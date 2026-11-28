import type { EventLog } from "../event-log/event-log";
import { TASK_TOKEN_HEADER } from "../gateway/endpoints";
import { HaltState } from "../halt/halt";
import { isRecord } from "../util/guards";
import { checkCountTokens, checkMessages, type RefusalCode } from "./checks";
import { Ledger, type Scope } from "./ledger";
import { priceUsage, reserve, type Amount, type ModelPrice, type PricePolicy, type Usage } from "./policy";

/**
 * The control plane's model proxy (decision 0002 §3). Every model call from a
 * sandbox reaches Anthropic only through it, by way of the task's gateway, which
 * adds the task token. For each `POST /v1/messages` it:
 *
 * 1. finds the task by its token, refuses it while a halt covers its lane or
 *    repository (decision 0002 §4), and checks the request (checks.ts);
 * 2. refuses at once if even the cheapest outcome, `max_tokens` at the model's
 *    lowest output rate, would not fit a budget, so an exhausted task can't make
 *    it count anything;
 * 3. counts the input with `count_tokens`, at most at the task's count rate, and
 *    refuses the call if that fails;
 * 4. reserves an upper bound on the cost against the task, lane and factory
 *    budgets, and refuses the call if any budget can't cover it;
 * 5. appends `model.reserved` to the event log, then forwards the checked request,
 *    re-serialized and pinned to standard routing and capacity, with the real key,
 *    which never leaves this process;
 * 6. settles: from the response's `usage`, priced by the response's `model`; at
 *    zero for a non-2xx answer, which Anthropic does not bill; and at the full
 *    reservation for any call that ends without its final usage (a disconnect, an
 *    error, a stream cut short) or that reports non-standard routing. It appends
 *    `model.call` with the model, usage, cost, latency, status and SHA-256 hashes
 *    of both bodies.
 *
 * `POST /v1/messages/count_tokens` is free; it is checked and forwarded, and
 * shares the task's count rate. Refusals are recorded with a fixed code only, at
 * most one a second per task, so a sandbox can't write its own text into the
 * permanent log or flood it.
 */

export interface ProxyTask {
	readonly token: string;
	readonly task: string;
	readonly lane: string;
	/** The task's repository, `owner/name`, which a halt can be scoped to. */
	readonly repo: string;
	readonly budget: Amount;
}

export interface ModelProxyOptions {
	readonly policy: PricePolicy;
	readonly log: EventLog;
	/** The approver roster: only their `halt.lifted` events lift a halt. */
	readonly approvers: ReadonlySet<string>;
	/** The Anthropic key, held only in this process's memory. */
	readonly key: string;
	readonly factoryBudget: Amount;
	readonly laneBudgets: ReadonlyMap<string, Amount>;
	readonly hostname: string;
	/** 0 picks a free port. */
	readonly port: number;
}

const ANTHROPIC_VERSION = "2023-06-01";
/** Response headers passed back to the sandbox. */
const RESPONSE_HEADERS = /^(content-type|request-id|retry-after|anthropic-ratelimit-.*)$/i;
/** The routing and capacity every call is made at; the policy's rates assume them. */
const STANDARD_ROUTING = { inference_geo: "global", service_tier: "standard_only" };
/** count_tokens calls per task, of both kinds: a burst of this many, refilled at one a second. */
const COUNT_BURST = 5;
const COUNT_REFILL_MS = 1000;
/** At most one refusal record per task per interval; the rest are counted into the next record. */
const REFUSAL_INTERVAL_MS = 1000;

type ProxyRefusal = RefusalCode | "count_failed" | "count_rate_limited" | "over_budget" | "halted";

export class ModelProxy {
	readonly #options: ModelProxyOptions;
	readonly #tasks = new Map<string, ProxyTask>();
	readonly #ledger: Ledger;
	readonly #halts: HaltState;
	readonly #server: ReturnType<typeof Bun.serve>;
	readonly #counts = new Map<string, { tokens: number; at: number }>();
	readonly #refusals = new Map<string, RefusalWindow>();

	private constructor(options: ModelProxyOptions) {
		this.#options = options;
		this.#ledger = Ledger.fromLog(options.log);
		this.#halts = new HaltState(options.log, options.approvers);
		this.#server = Bun.serve({
			hostname: options.hostname,
			port: options.port,
			// Streams can be quiet between events for a while; Anthropic's pings keep them under this.
			idleTimeout: 255,
			// Never answer with Bun's debug page, which would show stacks and the upstream URL.
			development: false,
			fetch: request => this.#handle(request).catch(() => anthropicError(500, "api_error", "the model proxy failed")),
			error: () => anthropicError(500, "api_error", "the model proxy failed"),
		});
	}

	/** Starts the proxy. Spend already in the event log, settled or not, counts from the start. */
	static start(options: ModelProxyOptions): ModelProxy {
		return new ModelProxy(options);
	}

	get port(): number {
		return this.#server.port ?? 0;
	}

	/** Lets a task's gateway call the proxy with `token`, within `budget`. */
	registerTask(task: ProxyTask): void {
		if (task.token.length < 32) throw new Error("task tokens must be at least 32 characters");
		this.#tasks.set(task.token, task);
	}

	unregisterTask(token: string): void {
		const task = this.#tasks.get(token);
		if (task) this.#flushRefusals(task.task);
		this.#tasks.delete(token);
	}

	/** Spend so far in a scope, settled plus reserved. */
	spent(scope: Scope): Amount {
		return this.#ledger.spent(scope);
	}

	stop(): void {
		for (const task of this.#refusals.keys()) this.#flushRefusals(task);
		this.#server.stop(true);
	}

	async #handle(request: Request): Promise<Response> {
		const received = performance.now();
		const path = new URL(request.url).pathname;
		if (request.method !== "POST" || (path !== "/v1/messages" && path !== "/v1/messages/count_tokens")) {
			return anthropicError(404, "not_found_error", "only POST /v1/messages and /v1/messages/count_tokens are served");
		}
		const task = this.#tasks.get(request.headers.get(TASK_TOKEN_HEADER) ?? "");
		if (!task) return anthropicError(401, "authentication_error", "unknown task");
		// The log is the halt's record; the halt command appends to it from another process.
		if (this.#halts.refresh().covers(task)) return this.#refuse(task, "halted", "the task's scope is halted", 503, "api_error");
		let body: unknown;
		try {
			body = JSON.parse(await request.text());
		} catch {
			return anthropicError(400, "invalid_request_error", "the request body is not JSON");
		}
		const beta = request.headers.get("anthropic-beta");
		const version = request.headers.get("anthropic-version") ?? ANTHROPIC_VERSION;
		if (path === "/v1/messages/count_tokens") {
			const checked = checkCountTokens(body, beta, this.#options.policy);
			if (!checked.ok) return this.#refuse(task, checked.code, checked.detail, 400, "invalid_request_error");
			if (!this.#takeCount(task)) return this.#countLimited(task);
			try {
				return await passThrough(await this.#upstream("/v1/messages/count_tokens", JSON.stringify(body), version, beta, request.signal));
			} catch {
				return anthropicError(502, "api_error", "the model API could not be reached");
			}
		}

		const checked = checkMessages(body, beta, this.#options.policy);
		if (!checked.ok) return this.#refuse(task, checked.code, checked.detail, 400, "invalid_request_error");
		const { model, maxTokens, stream, request: checkedRequest, countBody } = checked.value;

		const floor: Amount = { nanoUsd: maxTokens * lowestOutputRate(model), tokens: maxTokens };
		const short = this.#overBudget(task, floor);
		if (short) return this.#refuse(task, "over_budget", `the ${short} budget cannot cover this call`, 403, "permission_error");
		if (!this.#takeCount(task)) return this.#countLimited(task);
		const counted = await this.#count(countBody, version, beta, request.signal);
		if (counted === undefined) return this.#refuse(task, "count_failed", "count_tokens failed, so the call cannot be reserved", 502, "api_error");
		const reserved = reserve(model, counted, maxTokens);
		const over = this.#overBudget(task, reserved);
		if (over) return this.#refuse(task, "over_budget", `the ${over} budget cannot cover this call`, 403, "permission_error");

		const forwarded = JSON.stringify({ ...checkedRequest, ...STANDARD_ROUTING });
		const reservation = crypto.randomUUID();
		this.#options.log.append({
			type: "model.reserved",
			actor: "control-plane",
			task: task.task,
			lane: task.lane,
			payload: { reservation, model: model.id, counted_input: counted, max_tokens: maxTokens, reserved_nano_usd: reserved.nanoUsd, reserved_tokens: reserved.tokens },
		});
		this.#ledger.reserve(reservation, task.task, task.lane, reserved);

		const call: Call = { task, reservation, model, reserved, received, requestSha256: sha256(forwarded), settled: false };
		let response: Response;
		try {
			response = await this.#upstream("/v1/messages", forwarded, version, beta, request.signal);
		} catch {
			this.#settle(call, { status: 0, outcome: "reservation", model: model.id, usage: undefined, responseSha256: sha256("") });
			return anthropicError(502, "api_error", "the model API could not be reached");
		}
		if (!response.ok) {
			const errorText = await response.text().catch(() => "");
			this.#settle(call, { status: response.status, outcome: "zero", model: model.id, usage: undefined, responseSha256: sha256(errorText) });
			return new Response(errorText, { status: response.status, headers: responseHeaders(response.headers) });
		}
		if (!stream) {
			let answer: string;
			try {
				answer = await response.text();
			} catch {
				this.#settle(call, { status: response.status, outcome: "reservation", model: model.id, usage: undefined, responseSha256: sha256("") });
				return anthropicError(502, "api_error", "the model API's answer was cut short");
			}
			const usage = new UsageReader();
			usage.message(safeJson(answer));
			usage.complete = usage.model !== undefined && usage.raw !== undefined;
			this.#settleFrom(call, response.status, usage, sha256(answer));
			return new Response(answer, { status: response.status, headers: responseHeaders(response.headers) });
		}
		return new Response(this.#relay(call, response), { status: response.status, headers: responseHeaders(response.headers) });
	}

	/** Relays a streamed answer unchanged, reading its usage, and settles when it ends or is cut short. */
	#relay(call: Call, response: Response): ReadableStream<Uint8Array> {
		const usage = new UsageReader();
		const hasher = new Bun.CryptoHasher("sha256");
		const reader = response.body?.getReader();
		// The usage counts only if the stream reached message_stop; a cut after that loses nothing.
		const finish = (): void => this.#settleFrom(call, response.status, usage, hasher.digest("hex"));
		return new ReadableStream<Uint8Array>({
			pull: async controller => {
				if (!reader) {
					finish();
					controller.close();
					return;
				}
				try {
					const { done, value } = await reader.read();
					if (done) {
						finish();
						controller.close();
						return;
					}
					hasher.update(value);
					usage.push(value);
					controller.enqueue(value);
				} catch (error) {
					finish();
					controller.error(error);
				}
			},
			cancel: async reason => {
				finish();
				await reader?.cancel(reason).catch(() => {});
			},
		});
	}

	#settleFrom(call: Call, status: number, usage: UsageReader, responseSha256: string): void {
		const reported = usage.model;
		const priced = reported === undefined ? undefined : this.#options.policy.models.get(reported);
		const complete = usage.complete && usage.raw !== undefined && usage.standard && priced !== undefined;
		this.#settle(call, {
			status,
			outcome: complete ? "usage" : "reservation",
			model: reported ?? call.model.id,
			usage: complete ? usage.usage() : undefined,
			responseSha256,
			pricedAs: priced,
		});
	}

	#settle(
		call: Call,
		result: { status: number; outcome: "usage" | "reservation" | "zero"; model: string; usage: Usage | undefined; responseSha256: string; pricedAs?: ModelPrice | undefined },
	): void {
		if (call.settled) return;
		call.settled = true;
		const cost: Amount =
			result.outcome === "zero"
				? { nanoUsd: 0, tokens: 0 }
				: result.outcome === "usage" && result.usage && result.pricedAs
					? priceUsage(result.pricedAs, result.usage)
					: call.reserved;
		this.#options.log.append({
			type: "model.call",
			actor: "control-plane",
			task: call.task.task,
			lane: call.task.lane,
			payload: {
				reservation: call.reservation,
				provider: "anthropic",
				model: result.model,
				status: result.status,
				settled: result.outcome,
				usage: result.usage
					? {
							input: result.usage.input,
							output: result.usage.output,
							cache_write_5m: result.usage.cacheWrite5m,
							cache_write_1h: result.usage.cacheWrite1h,
							cache_read: result.usage.cacheRead,
						}
					: null,
				cost_nano_usd: cost.nanoUsd,
				tokens: cost.tokens,
				latency_ms: Math.round(performance.now() - call.received),
				request_sha256: call.requestSha256,
				response_sha256: result.responseSha256,
			},
		});
		this.#ledger.settle(call.reservation, cost);
	}

	/** Returns the scope whose budget can't cover `amount` on top of its spend, if any. */
	#overBudget(task: ProxyTask, amount: Amount): string | undefined {
		const lane = this.#options.laneBudgets.get(task.lane);
		if (!lane) return `lane ${task.lane}`;
		const checks: [string, Scope, Amount][] = [
			[`task ${task.task}`, { task: task.task }, task.budget],
			[`lane ${task.lane}`, { lane: task.lane }, lane],
			["factory", "factory", this.#options.factoryBudget],
		];
		for (const [name, scope, budget] of checks) {
			const spent = this.#ledger.spent(scope);
			if (spent.nanoUsd + amount.nanoUsd > budget.nanoUsd || spent.tokens + amount.tokens > budget.tokens) return name;
		}
		return undefined;
	}

	/** Takes one count_tokens call from the task's bucket. */
	#takeCount(task: ProxyTask): boolean {
		const now = performance.now();
		const bucket = this.#counts.get(task.task) ?? { tokens: COUNT_BURST, at: now };
		const tokens = Math.min(COUNT_BURST, bucket.tokens + (now - bucket.at) / COUNT_REFILL_MS);
		const allowed = tokens >= 1;
		this.#counts.set(task.task, { tokens: allowed ? tokens - 1 : tokens, at: now });
		return allowed;
	}

	#countLimited(task: ProxyTask): Response {
		return this.#refuse(task, "count_rate_limited", "count_tokens is limited to one a second per task", 429, "rate_limit_error", { "retry-after": "1" });
	}

	async #count(countBody: Record<string, unknown>, version: string, beta: string | null, signal: AbortSignal): Promise<number | undefined> {
		try {
			const response = await this.#upstream("/v1/messages/count_tokens", JSON.stringify(countBody), version, beta, signal);
			const counted: unknown = response.ok ? await response.json() : undefined;
			const tokens = isRecord(counted) ? counted.input_tokens : undefined;
			return typeof tokens === "number" && Number.isInteger(tokens) && tokens >= 0 ? tokens : undefined;
		} catch {
			return undefined;
		}
	}

	#upstream(path: string, body: string, version: string, beta: string | null, signal: AbortSignal): Promise<Response> {
		const headers: Record<string, string> = { "content-type": "application/json", "anthropic-version": version, "x-api-key": this.#options.key };
		if (beta) headers["anthropic-beta"] = beta;
		// A redirect would carry the key to wherever it points.
		return fetch(`${this.#options.policy.upstream}${path}`, { method: "POST", headers, body, signal, redirect: "error" });
	}

	/**
	 * Refuses a call. The event log gets only fixed codes, and at most one record a
	 * second per task: the first refusal is recorded at once, and those held back
	 * within the second are recorded together when it ends, as one record with the
	 * latest code and their count. The detail, which may quote the request, goes only
	 * back to the sandbox.
	 */
	#refuse(task: ProxyTask, code: ProxyRefusal, detail: string, status: number, type: string, headers: Record<string, string> = {}): Response {
		const now = performance.now();
		const window = this.#refusals.get(task.task);
		if (window && now - window.at < REFUSAL_INTERVAL_MS) {
			window.count += 1;
			window.code = code;
			window.timer ??= setTimeout(() => this.#flushRefusals(task.task), REFUSAL_INTERVAL_MS - (now - window.at));
		} else {
			this.#flushRefusals(task.task);
			this.#recordRefusals(task, code, 1);
			this.#refusals.set(task.task, { task, at: now, count: 0, code, timer: undefined });
		}
		return anthropicError(status, type, detail, headers);
	}

	/** Records the refusals held back in a task's current window, if any. */
	#flushRefusals(task: string): void {
		const window = this.#refusals.get(task);
		if (!window) return;
		clearTimeout(window.timer);
		window.timer = undefined;
		if (window.count > 0) this.#recordRefusals(window.task, window.code, window.count);
		window.count = 0;
	}

	#recordRefusals(task: ProxyTask, code: ProxyRefusal, count: number): void {
		this.#options.log.append({ type: "model.refused", actor: "control-plane", task: task.task, lane: task.lane, payload: { code, count } });
	}
}

/** A task's current one-second window of refusals: the ones after the first are held back and counted. */
interface RefusalWindow {
	readonly task: ProxyTask;
	readonly at: number;
	count: number;
	code: ProxyRefusal;
	timer: ReturnType<typeof setTimeout> | undefined;
}

interface Call {
	readonly task: ProxyTask;
	readonly reservation: string;
	readonly model: ModelPrice;
	readonly reserved: Amount;
	readonly received: number;
	readonly requestSha256: string;
	settled: boolean;
}

function lowestOutputRate(model: ModelPrice): number {
	return Math.min(...model.tiers.map(tier => tier.rates.output));
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Reads the model and usage from a streamed (SSE) or whole Messages answer. */
class UsageReader {
	model: string | undefined;
	raw: Record<string, unknown> | undefined;
	/** True once the answer reached its end: `message_stop`, or a whole non-streamed message. */
	complete = false;
	#pending = "";
	readonly #decoder = new TextDecoder();

	push(chunk: Uint8Array): void {
		this.#pending += this.#decoder.decode(chunk, { stream: true });
		let end = this.#pending.indexOf("\n\n");
		while (end !== -1) {
			const event = this.#pending.slice(0, end);
			this.#pending = this.#pending.slice(end + 2);
			const data = event
				.split("\n")
				.filter(line => line.startsWith("data:"))
				.map(line => line.slice(5).trimStart())
				.join("\n");
			if (data) this.#event(safeJson(data));
			end = this.#pending.indexOf("\n\n");
		}
	}

	/** A whole message: a non-streamed answer, or `message_start`'s message. */
	message(message: unknown): void {
		if (!isRecord(message)) return;
		if (typeof message.model === "string") this.model = message.model;
		if (isRecord(message.usage)) this.#merge(message.usage);
	}

	/** True unless the answer reports routing or capacity the policy's rates don't cover. */
	get standard(): boolean {
		const tier = this.raw?.service_tier;
		const geo = this.raw?.inference_geo;
		return (tier === undefined || tier === "standard") && (geo === undefined || geo === "global" || geo === "not_available");
	}

	#event(event: unknown): void {
		if (!isRecord(event)) return;
		if (event.type === "message_start") this.message(event.message);
		else if (event.type === "message_delta" && isRecord(event.usage)) this.#merge(event.usage);
		else if (event.type === "message_stop") this.complete = true;
	}

	/**
	 * Merges usage counts. A later count replaces an earlier one (message_delta's are
	 * cumulative), but a null or anything else that isn't a count never erases one.
	 */
	#merge(usage: Record<string, unknown>): void {
		const next: Record<string, unknown> = { ...this.raw };
		for (const [key, value] of Object.entries(usage)) {
			if (isCount(value)) next[key] = value;
			else if ((key === "service_tier" || key === "inference_geo") && typeof value === "string") next[key] = value;
			else if (key === "cache_creation" && isRecord(value)) {
				const counts = Object.fromEntries(Object.entries(value).filter(([, count]) => isCount(count)));
				next.cache_creation = { ...(isRecord(next.cache_creation) ? next.cache_creation : {}), ...counts };
			}
		}
		this.raw = next;
	}

	usage(): Usage {
		const raw = this.raw ?? {};
		const count = (value: unknown): number => (isCount(value) ? value : 0);
		const creation = isRecord(raw.cache_creation) ? raw.cache_creation : {};
		const fiveMinutes = count(creation.ephemeral_5m_input_tokens);
		const oneHour = count(creation.ephemeral_1h_input_tokens);
		// Cache writes the 5-minute/1-hour split doesn't account for are priced at the dearer 1-hour rate.
		const unsplit = Math.max(0, count(raw.cache_creation_input_tokens) - fiveMinutes - oneHour);
		return {
			input: count(raw.input_tokens),
			output: count(raw.output_tokens),
			cacheRead: count(raw.cache_read_input_tokens),
			cacheWrite5m: fiveMinutes,
			cacheWrite1h: oneHour + unsplit,
		};
	}
}

function safeJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function sha256(text: string): string {
	return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function responseHeaders(headers: Headers): Headers {
	const out = new Headers();
	for (const [name, value] of headers) if (RESPONSE_HEADERS.test(name)) out.set(name, value);
	return out;
}

async function passThrough(response: Response): Promise<Response> {
	return new Response(await response.text(), { status: response.status, headers: responseHeaders(response.headers) });
}

function anthropicError(status: number, type: string, message: string, headers: Record<string, string> = {}): Response {
	return Response.json({ type: "error", error: { type, message } }, { status, headers });
}
