import type { GatewayConfig } from "./config";
import { MODEL_PORT, TASK_TOKEN_HEADER } from "./endpoints";
import type { Log } from "./log";

/**
 * The gateway's model route (decision 0002 §2): the sandbox's
 * `ANTHROPIC_BASE_URL`. It forwards only `POST /v1/messages`, and
 * `POST /v1/messages/count_tokens` at most once a second, to the control
 * plane's model proxy. It drops whatever key the sandbox sends (a placeholder)
 * and adds the task token itself, so the token never enters the sandbox.
 */

const PATHS = new Set(["/v1/messages", "/v1/messages/count_tokens"]);
/** The only request headers forwarded; the sandbox's `x-api-key` and `Authorization` never are. */
const FORWARDED_HEADERS = ["accept", "anthropic-beta", "anthropic-version", "content-type"];
const RESPONSE_HEADERS = /^(content-type|request-id|retry-after|anthropic-ratelimit-.*)$/i;
const COUNT_INTERVAL_MS = 1000;

export interface ModelRouteOptions {
	readonly port?: number;
	readonly hostname?: string;
	/** True while a halt covers the task (decision 0002 §4); everything is refused then. */
	readonly halted?: () => boolean;
}

export function serveModelRoute(model: NonNullable<GatewayConfig["model"]>, log: Log, options: ModelRouteOptions = {}): ReturnType<typeof Bun.serve> {
	let lastCount = Number.NEGATIVE_INFINITY;
	return Bun.serve({
		port: options.port ?? MODEL_PORT,
		hostname: options.hostname ?? "0.0.0.0",
		// A streamed answer can pause between events; Anthropic's pings keep it under this.
		idleTimeout: 255,
		// Never answer with Bun's debug page, which would show stacks and the proxy's address.
		development: false,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const entry = { kind: "model", method: request.method, path };
			if (options.halted?.()) {
				log({ ...entry, decision: "refused", reason: "halted" });
				return error(503, "api_error", "the task's scope is halted");
			}
			if (request.method !== "POST" || !PATHS.has(path)) {
				log({ ...entry, decision: "refused", reason: "not a model call" });
				return error(404, "not_found_error", "only POST /v1/messages and /v1/messages/count_tokens are served");
			}
			if (path === "/v1/messages/count_tokens") {
				const now = performance.now();
				if (now - lastCount < COUNT_INTERVAL_MS) {
					log({ ...entry, decision: "refused", reason: "count_tokens is limited to once a second" });
					return error(429, "rate_limit_error", "count_tokens is limited to once a second", { "retry-after": "1" });
				}
				lastCount = now;
			}
			const headers = new Headers({ [TASK_TOKEN_HEADER]: model.token });
			for (const name of FORWARDED_HEADERS) {
				const value = request.headers.get(name);
				if (value !== null) headers.set(name, value);
			}
			let response: Response;
			try {
				response = await fetch(`${model.proxy}${path}`, { method: "POST", headers, body: await request.arrayBuffer(), redirect: "manual", signal: request.signal });
			} catch {
				log({ ...entry, decision: "failed", reason: "model proxy unreachable" });
				return error(502, "api_error", "the model proxy could not be reached");
			}
			log({ ...entry, decision: "forwarded", status: response.status });
			const out = new Headers();
			for (const [name, value] of response.headers) if (RESPONSE_HEADERS.test(name)) out.set(name, value);
			return new Response(response.body, { status: response.status, headers: out });
		},
	});
}

function error(status: number, type: string, message: string, headers: Record<string, string> = {}): Response {
	return Response.json({ type: "error", error: { type, message } }, { status, headers });
}
