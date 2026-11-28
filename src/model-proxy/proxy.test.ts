import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog, type LoggedEvent } from "../event-log/event-log";
import { TASK_TOKEN_HEADER } from "../gateway/endpoints";
import { isRecord } from "../util/guards";
import { parsePricePolicy, type Amount } from "./policy";
import { ModelProxy, type ProxyTask } from "./proxy";

/**
 * The model proxy against a fake Anthropic upstream (decision 0002, build step 3).
 * The upstream's behaviour is chosen per test, and it records every request.
 */

type Behaviour = "stream" | "truncated" | "error" | "json" | "count-fails" | "slow" | "null-delta" | "cache-split" | "priority" | "redirect";
let behaviour: Behaviour = "stream";
let received: { path: string; headers: Record<string, string>; body: string }[] = [];
const COUNTED = 1000;
const USAGE = { input_tokens: 900, output_tokens: 50, cache_read_input_tokens: 100, cache_creation_input_tokens: 0 };

const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const START = sse("message_start", { type: "message_start", message: { id: "m", model: "test-model", usage: { ...USAGE, output_tokens: 1 } } });
const REST =
	sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
	sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } }) +
	sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
	sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: USAGE.output_tokens } }) +
	sse("message_stop", { type: "message_stop" });

/** The usage message_start and message_delta report, per behaviour. */
function streamFor(kind: Behaviour): { start: string; rest: string } {
	let startUsage: Record<string, unknown> = { ...USAGE, output_tokens: 1 };
	let deltaUsage: Record<string, unknown> = { output_tokens: USAGE.output_tokens };
	// Anthropic's MessageDeltaUsage allows nulls for the input and cache counts.
	if (kind === "null-delta") deltaUsage = { output_tokens: USAGE.output_tokens, input_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null };
	// 100 cache-write tokens, of which the split accounts for only 30.
	if (kind === "cache-split") startUsage = { ...startUsage, cache_creation_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 30 } };
	if (kind === "priority") startUsage = { ...startUsage, service_tier: "priority" };
	const start = sse("message_start", { type: "message_start", message: { id: "m", model: "test-model", usage: startUsage } });
	const rest = REST.replace(JSON.stringify({ output_tokens: USAGE.output_tokens }), JSON.stringify(deltaUsage));
	return { start, rest };
}

/** Records anything a redirect would send it; nothing should ever arrive. */
const elsewhere: string[] = [];
const elsewhereServer = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request) {
		elsewhere.push(request.headers.get("x-api-key") ?? "");
		return new Response("nope", { status: 500 });
	},
});

const upstream = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	async fetch(request) {
		const path = new URL(request.url).pathname;
		received.push({ path, headers: Object.fromEntries(request.headers), body: await request.text() });
		if (path === "/v1/messages/count_tokens") {
			return behaviour === "count-fails" ? new Response("overloaded", { status: 529 }) : Response.json({ input_tokens: COUNTED });
		}
		if (behaviour === "error") return Response.json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }, { status: 429 });
		if (behaviour === "json") return Response.json({ id: "m", type: "message", model: "test-model", content: [], usage: USAGE });
		if (behaviour === "redirect") return new Response(null, { status: 307, headers: { location: `http://127.0.0.1:${elsewhereServer.port}/v1/messages` } });
		const encoder = new TextEncoder();
		const { start, rest } = streamFor(behaviour);
		const body = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(encoder.encode(start));
				if (behaviour === "truncated") return controller.close();
				// "slow" never finishes, so the client must give up first.
				if (behaviour === "slow") return;
				controller.enqueue(encoder.encode(rest));
				controller.close();
			},
		});
		return new Response(body, { headers: { "content-type": "text/event-stream", "request-id": "req_1" } });
	},
});

/**
 * Answers count_tokens normally, but a message with real headers and part of the
 * declared body, then resets the connection. Bun's own server can't be made to
 * break off mid-body on cue, so this speaks HTTP over a plain socket.
 */
const cutUpstream = createServer(socket => {
	let buffered = "";
	socket.on("data", (chunk: Buffer) => {
		buffered += chunk.toString("latin1");
		const end = buffered.indexOf("\r\n\r\n");
		if (end === -1) return;
		const length = Number(/content-length: (\d+)/i.exec(buffered.slice(0, end))?.[1] ?? 0);
		if (buffered.length < end + 4 + length) return;
		if (buffered.startsWith("POST /v1/messages/count_tokens")) {
			const body = JSON.stringify({ input_tokens: COUNTED });
			socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`);
		} else {
			socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 500\r\n\r\n{"id":"m","type":"message","usage":', () => socket.destroy());
		}
	});
	socket.on("error", () => {});
});
cutUpstream.listen(0, "127.0.0.1");
await once(cutUpstream, "listening");

const policy = parsePricePolicy(`
[anthropic]
upstream = "http://127.0.0.1:${upstream.port}"
betas = ["allowed-beta-2026-01-01"]
[[anthropic.models]]
id = "test-model"
[[anthropic.models.tiers]]
input = 1
cache_write_5m = 1.25
cache_write_1h = 2
cache_read = 0.1
output = 5
`);

const KEY = "sk-real-key-held-by-the-control-plane";
const TOKEN = "t".repeat(40);
const LARGE: Amount = { nanoUsd: 1_000_000_000_000, tokens: 1_000_000_000 };
const REQUEST = { model: "test-model", max_tokens: 1000, stream: true, messages: [{ role: "user", content: "hi" }] };
/** What REQUEST reserves: 1,100 input tokens at the 1-hour cache-write rate (2), and 1,000 output tokens at 5. */
const RESERVED: Amount = { nanoUsd: 1100 * 2000 + 1000 * 5000, tokens: 2100 };
/** What USAGE costs: 900 input at 1, 100 cache reads at 0.1, 50 output at 5. */
const COST: Amount = { nanoUsd: 900 * 1000 + 100 * 100 + 50 * 5000, tokens: 1050 };

let dir: string;
let log: EventLog;
let proxy: ModelProxy | undefined;

function start(budgets: { task?: Amount; lane?: Amount; factory?: Amount } = {}, upstreamOrigin?: string): ModelProxy {
	proxy = ModelProxy.start({
		policy: upstreamOrigin === undefined ? policy : { ...policy, upstream: upstreamOrigin },
		log,
		key: KEY,
		factoryBudget: budgets.factory ?? LARGE,
		laneBudgets: new Map([["lane-0001", budgets.lane ?? LARGE]]),
		hostname: "127.0.0.1",
		port: 0,
	});
	const task: ProxyTask = { token: TOKEN, task: "task-1", lane: "lane-0001", budget: budgets.task ?? LARGE };
	proxy.registerTask(task);
	return proxy;
}

function call(body: unknown = REQUEST, headers: Record<string, string> = {}, signal?: AbortSignal): Promise<Response> {
	return fetch(`http://127.0.0.1:${proxy?.port}/v1/messages`, {
		method: "POST",
		headers: { "content-type": "application/json", "anthropic-version": "2023-06-01", [TASK_TOKEN_HEADER]: TOKEN, "x-api-key": "placeholder", ...headers },
		body: JSON.stringify(body),
		...(signal ? { signal } : {}),
	});
}

function events(type: string): LoggedEvent[] {
	return [...log.read()].filter(event => event.type === type);
}

function payload(event: LoggedEvent | undefined): Record<string, unknown> {
	return isRecord(event?.payload) ? event.payload : {};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "sf-proxy-"));
	log = EventLog.open(join(dir, "events.sqlite"));
	behaviour = "stream";
	received = [];
});

afterEach(() => {
	proxy?.stop();
	proxy = undefined;
	log.close();
	rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
	upstream.stop(true);
	elsewhereServer.stop(true);
	cutUpstream.close();
});

describe("the model proxy", () => {
	test("reserves before forwarding, forwards with the real key only, and settles from the response's usage", async () => {
		start();
		const response = await call(REQUEST, { "anthropic-beta": "allowed-beta-2026-01-01" });
		expect(await response.text()).toBe(START + REST);
		const sent = received.find(request => request.path === "/v1/messages");
		expect([sent?.headers["x-api-key"], sent?.headers[TASK_TOKEN_HEADER], sent?.headers.authorization]).toEqual([KEY, undefined, undefined]);
		expect(sent?.headers["anthropic-beta"]).toBe("allowed-beta-2026-01-01");

		const [reservedEvent] = events("model.reserved");
		const [callEvent] = events("model.call");
		expect((reservedEvent?.seq ?? 0) < (callEvent?.seq ?? 0)).toBe(true);
		expect(payload(reservedEvent)).toMatchObject({ counted_input: COUNTED, reserved_nano_usd: RESERVED.nanoUsd, reserved_tokens: RESERVED.tokens });
		expect(payload(callEvent)).toMatchObject({
			provider: "anthropic",
			model: "test-model",
			status: 200,
			settled: "usage",
			usage: { input: 900, output: 50, cache_read: 100, cache_write_5m: 0, cache_write_1h: 0 },
			cost_nano_usd: COST.nanoUsd,
			tokens: COST.tokens,
			// The hash is of exactly what reached the model.
			request_sha256: new Bun.CryptoHasher("sha256").update(sent?.body ?? "").digest("hex"),
			response_sha256: new Bun.CryptoHasher("sha256").update(START + REST).digest("hex"),
		});
		expect(proxy?.spent({ task: "task-1" })).toEqual(COST);
		// Forwarded pinned to the standard routing and capacity the policy's rates assume.
		expect(JSON.parse(sent?.body ?? "{}")).toMatchObject({ ...REQUEST, inference_geo: "global", service_tier: "standard_only" });
	});

	test("settles a whole (non-streamed) answer from its usage", async () => {
		behaviour = "json";
		start();
		await (await call({ ...REQUEST, stream: false })).text();
		expect(payload(events("model.call")[0])).toMatchObject({ settled: "usage", cost_nano_usd: COST.nanoUsd });
	});

	test("refuses a call the task, lane or factory budget can't cover, without calling the model", async () => {
		const tooSmall: Amount = { nanoUsd: RESERVED.nanoUsd - 1, tokens: LARGE.tokens };
		const tooFewTokens: Amount = { nanoUsd: LARGE.nanoUsd, tokens: RESERVED.tokens - 1 };
		for (const [budgets, scope] of [
			[{ task: tooSmall }, "task task-1"],
			[{ lane: tooFewTokens }, "lane lane-0001"],
			[{ factory: tooSmall }, "factory"],
		] as const) {
			start(budgets);
			const response = await call();
			expect([response.status, ((await response.json()) as { error: { message: string } }).error.message]).toEqual([
				403,
				`the ${scope} budget cannot cover this call`,
			]);
			proxy?.stop();
		}
		expect(received.filter(request => request.path === "/v1/messages")).toEqual([]);
		expect(events("model.reserved")).toEqual([]);
	});

	test("refuses server-side tools, url sources and unknown fields before counting anything", async () => {
		start();
		const bodies = [
			{ ...REQUEST, tools: [{ type: "web_search_20250305", name: "web_search" }] },
			{ ...REQUEST, messages: [{ role: "user", content: [{ type: "image", source: { type: "url", url: "https://example.com/a.png" } }] }] },
			{ ...REQUEST, mcp_servers: [] },
		];
		const statuses = await Promise.all(bodies.map(async body => (await call(body)).status));
		expect(statuses).toEqual([400, 400, 400]);
		expect(received).toEqual([]);
		// The first refusal is recorded at once, with a fixed code and nothing from the request;
		// the two held back within the same second are recorded together when the window closes.
		const first = events("model.refused");
		expect(first).toHaveLength(1);
		expect(Object.keys(payload(first[0])).sort()).toEqual(["code", "count"]);
		expect(payload(first[0]).count).toBe(1);
		proxy?.stop(); // closes the window now, rather than waiting out the second
		expect(events("model.refused").map(event => payload(event).count)).toEqual([1, 2]);
	});

	test("refuses the call when count_tokens fails", async () => {
		behaviour = "count-fails";
		start();
		expect((await call()).status).toBe(502);
		expect(received.map(request => request.path)).toEqual(["/v1/messages/count_tokens"]);
		expect(events("model.reserved")).toEqual([]);
	});

	test("settles a stream cut short at the full reservation", async () => {
		behaviour = "truncated";
		start();
		expect(await (await call()).text()).toBe(START);
		expect(payload(events("model.call")[0])).toMatchObject({ settled: "reservation", usage: null, cost_nano_usd: RESERVED.nanoUsd, tokens: RESERVED.tokens });
	});

	test("settles a client that disconnects mid-stream at the full reservation", async () => {
		behaviour = "slow";
		start();
		const abort = new AbortController();
		const response = await call(REQUEST, {}, abort.signal);
		const reader = response.body?.getReader();
		await reader?.read(); // the first event arrived
		abort.abort();
		await reader?.cancel().catch(() => {});
		// The proxy settles when it sees the stream cancelled. It exposes no completion signal, so this polls the log, briefly.
		const deadline = performance.now() + 3000;
		while (events("model.call").length === 0 && performance.now() < deadline) await Bun.sleep(5);
		expect(payload(events("model.call")[0])).toMatchObject({ settled: "reservation", cost_nano_usd: RESERVED.nanoUsd });
	});

	test("settles an HTTP error answer, which Anthropic does not bill, at zero", async () => {
		behaviour = "error";
		start();
		const response = await call();
		expect(response.status).toBe(429);
		expect(payload(events("model.call")[0])).toMatchObject({ settled: "zero", status: 429, cost_nano_usd: 0, tokens: 0 });
		expect(proxy?.spent("factory")).toEqual({ nanoUsd: 0, tokens: 0 });
	});

	test("after a restart, counts a reservation that was never settled as spent", async () => {
		log.append({
			type: "model.reserved",
			actor: "control-plane",
			task: "task-1",
			lane: "lane-0001",
			payload: { reservation: "r-1", model: "test-model", counted_input: 10, max_tokens: 10, reserved_nano_usd: 5_000_000, reserved_tokens: 20 },
		});
		// Room for one more reservation like REQUEST's, but not on top of the unsettled one.
		start({ task: { nanoUsd: RESERVED.nanoUsd + 4_999_999, tokens: LARGE.tokens } });
		expect(proxy?.spent({ task: "task-1" })).toEqual({ nanoUsd: 5_000_000, tokens: 20 });
		expect((await call()).status).toBe(403);
	});

	test("serves only its two paths, and only to registered tasks", async () => {
		start();
		const base = `http://127.0.0.1:${proxy?.port}`;
		const statuses = await Promise.all([
			fetch(`${base}/v1/messages`, { method: "POST", body: JSON.stringify(REQUEST) }).then(response => response.status),
			fetch(`${base}/v1/messages`, { method: "POST", headers: { [TASK_TOKEN_HEADER]: "x".repeat(40) }, body: "{}" }).then(response => response.status),
			fetch(`${base}/v1/models`, { headers: { [TASK_TOKEN_HEADER]: TOKEN } }).then(response => response.status),
			fetch(`${base}/v1/messages/batches`, { method: "POST", headers: { [TASK_TOKEN_HEADER]: TOKEN }, body: "{}" }).then(response => response.status),
		]);
		expect(statuses).toEqual([401, 401, 404, 404]);
		expect(received).toEqual([]);
	});

	test("never lets a null in message_delta erase counts, and prices unsplit cache writes at the 1-hour rate", async () => {
		behaviour = "null-delta";
		start();
		await (await call()).text();
		expect(payload(events("model.call")[0])).toMatchObject({ settled: "usage", cost_nano_usd: COST.nanoUsd, usage: { input: 900, cache_read: 100 } });

		proxy?.stop();
		behaviour = "cache-split";
		start();
		await (await call()).text();
		// 30 at the 5-minute rate (1.25) and the other 70 at the 1-hour rate (2), on top of COST.
		expect(payload(events("model.call")[1])).toMatchObject({ usage: { cache_write_5m: 30, cache_write_1h: 70 }, cost_nano_usd: COST.nanoUsd + 30 * 1250 + 70 * 2000 });
	});

	test("settles at the full reservation an answer that reports priority capacity, which the policy doesn't price", async () => {
		behaviour = "priority";
		start();
		await (await call()).text();
		expect(payload(events("model.call")[0])).toMatchObject({ settled: "reservation", cost_nano_usd: RESERVED.nanoUsd });
	});

	test("settles a whole answer that breaks off mid-body at the full reservation, with a clean error", async () => {
		start({}, `http://127.0.0.1:${(cutUpstream.address() as AddressInfo).port}`);
		const response = await call({ ...REQUEST, stream: false });
		expect([response.status, response.headers.get("content-type")]).toEqual([502, "application/json;charset=utf-8"]);
		expect(((await response.json()) as { error: { type: string } }).error.type).toBe("api_error");
		expect(payload(events("model.call")[0])).toMatchObject({ settled: "reservation", cost_nano_usd: RESERVED.nanoUsd });
	});

	test("never follows a redirect, which would carry the key elsewhere", async () => {
		behaviour = "redirect";
		start();
		expect((await call()).status).toBe(502);
		expect(elsewhere).toEqual([]);
		expect(payload(events("model.call")[0])).toMatchObject({ settled: "reservation" });
	});

	test("checks and forwards the parsed request, so a duplicated key can't hide a larger max_tokens", async () => {
		start();
		const raw = '{"model":"test-model","max_tokens":64000,"max_tokens":1000,"stream":true,"messages":[{"role":"user","content":"hi"}]}';
		const response = await fetch(`http://127.0.0.1:${proxy?.port}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", [TASK_TOKEN_HEADER]: TOKEN },
			body: raw,
		});
		await response.text();
		const sent = received.find(request => request.path === "/v1/messages")?.body ?? "";
		expect(sent.match(/"max_tokens"/g)).toHaveLength(1);
		expect((JSON.parse(sent) as { max_tokens: number }).max_tokens).toBe(1000);
	});

	test("refuses before counting when even the cheapest outcome would not fit, and limits counting per task", async () => {
		// max_tokens at the lowest output rate (5) alone is 5,000,000 nano-USD.
		start({ task: { nanoUsd: 4_999_999, tokens: LARGE.tokens } });
		expect((await call()).status).toBe(403);
		expect(received).toEqual([]);
		proxy?.stop();

		start();
		const statuses = await Promise.all(Array.from({ length: 8 }, async () => (await call()).status));
		// A burst of five counts per task; the rest are told to retry.
		expect(statuses.filter(status => status === 200)).toHaveLength(5);
		expect(statuses.filter(status => status === 429)).toHaveLength(3);
		expect(received.filter(request => request.path === "/v1/messages/count_tokens")).toHaveLength(5);
	});

	test("after a restart, a malformed settlement leaves its reservation counting in full", async () => {
		const reservedPayload = { reservation: "r-2", model: "test-model", counted_input: 10, max_tokens: 10, reserved_nano_usd: 5_000_000, reserved_tokens: 20 };
		log.append({ type: "model.reserved", actor: "control-plane", task: "task-1", lane: "lane-0001", payload: reservedPayload });
		log.append({ type: "model.call", actor: "control-plane", task: "task-1", lane: "lane-0001", payload: { reservation: "r-2", cost_nano_usd: null, tokens: 5 } });
		start();
		expect(proxy?.spent({ task: "task-1" })).toEqual({ nanoUsd: 5_000_000, tokens: 20 });
	});

	test("after a restart, a repeated reservation id never lowers what is held", async () => {
		const reserved = (nanoUsd: number, tokens: number) => ({ reservation: "r-3", model: "test-model", counted_input: 1, max_tokens: 1, reserved_nano_usd: nanoUsd, reserved_tokens: tokens });
		log.append({ type: "model.reserved", actor: "control-plane", task: "task-1", lane: "lane-0001", payload: reserved(100, 10) });
		log.append({ type: "model.reserved", actor: "control-plane", task: "task-1", lane: "lane-0001", payload: reserved(50, 20) });
		start();
		expect(proxy?.spent({ task: "task-1" })).toEqual({ nanoUsd: 100, tokens: 20 });
	});
});
