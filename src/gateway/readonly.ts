import { isRecord } from "../util/guards";
import { endpointUrl, type ReadOnlyEndpoint } from "./endpoints";
import type { Log } from "./log";

/**
 * A read-only endpoint (decision 0002 §2): a plain-HTTP reverse proxy for one
 * host that accepts writes from token holders. It accepts only GET and HEAD,
 * forwards no credentials or cookies upstream, drops cookies from responses,
 * and points the registry's tarball URLs and same-host redirects back at itself.
 */

/** The only request headers forwarded upstream. Authorization and Cookie never are. */
const FORWARDED_HEADERS = ["accept", "if-modified-since", "if-none-match", "range", "user-agent"];
/** Response headers that are dropped: cookies, and those that describe the upstream connection or encoding. */
const DROPPED_HEADERS = ["set-cookie", "content-encoding", "content-length", "transfer-encoding", "connection", "keep-alive", "strict-transport-security", "alt-svc"];
/** Under the server's 255-second idle timeout, so a stalled upstream ends in a logged 502, not a reset. */
const UPSTREAM_TIMEOUT_MS = 250_000;

export interface ReadOnlyOptions {
	/** Overrides the endpoint's upstream origin; tests point it at a local server. */
	readonly upstream?: string;
	readonly port?: number;
	readonly hostname?: string;
	/** True while a halt covers the task (decision 0002 §4); everything is refused then. */
	readonly halted?: () => boolean;
}

export function serveReadOnly(endpoint: ReadOnlyEndpoint, log: Log, options: ReadOnlyOptions = {}): ReturnType<typeof Bun.serve> {
	const upstream = options.upstream ?? endpoint.upstream;
	const base = endpointUrl(endpoint);
	return Bun.serve({
		port: options.port ?? endpoint.port,
		hostname: options.hostname ?? "0.0.0.0",
		// Bun's default 10-second idle timeout would cut a slow upstream (a large package
		// document is buffered before it is rewritten), and the client would retry it.
		idleTimeout: 255,
		// Never answer with Bun's debug page, which would show stacks.
		development: false,
		async fetch(request) {
			const url = new URL(request.url);
			const entry = { endpoint: endpoint.host, method: request.method, path: url.pathname };
			if (options.halted?.()) {
				log({ ...entry, decision: "refused", reason: "halted" });
				return new Response("the task's scope is halted\n", { status: 503 });
			}
			if (request.method !== "GET" && request.method !== "HEAD") {
				log({ ...entry, decision: "refused", reason: "read-only endpoint" });
				return new Response("read-only endpoint: only GET and HEAD are allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
			}
			const headers = new Headers();
			for (const name of FORWARDED_HEADERS) {
				const value = request.headers.get(name);
				if (value !== null) headers.set(name, value);
			}
			let response: Response;
			try {
				response = await fetch(`${upstream}${url.pathname}${url.search}`, {
					method: request.method,
					headers,
					redirect: "manual",
					signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
				});
			} catch {
				log({ ...entry, decision: "failed", reason: "upstream unreachable" });
				return new Response("upstream unreachable\n", { status: 502 });
			}
			log({ ...entry, decision: "forwarded", status: response.status });
			const out = new Headers(response.headers);
			for (const name of DROPPED_HEADERS) out.delete(name);
			const location = out.get("location");
			if (location !== null && location.startsWith(`${upstream}/`)) out.set("location", base + location.slice(upstream.length));
			const init = { status: response.status, statusText: response.statusText, headers: out };
			if (request.method === "HEAD") return new Response(null, init);
			if (endpoint.host === "registry.npmjs.org" && /json/i.test(out.get("content-type") ?? "")) {
				return new Response(rewriteTarballs(await response.text(), upstream, base), init);
			}
			return new Response(response.body, init);
		},
	});
}

/**
 * Points every `dist.tarball` URL on `upstream` at `base`, in a package document
 * (all versions) or a single version's document. Anything that isn't a JSON
 * object is returned unchanged.
 */
export function rewriteTarballs(text: string, upstream: string, base: string): string {
	let document: unknown;
	try {
		document = JSON.parse(text);
	} catch {
		return text;
	}
	if (!isRecord(document)) return text;
	const rewrite = (version: unknown): void => {
		const dist = isRecord(version) ? version.dist : undefined;
		if (isRecord(dist) && typeof dist.tarball === "string" && dist.tarball.startsWith(`${upstream}/`)) {
			dist.tarball = base + dist.tarball.slice(upstream.length);
		}
	};
	rewrite(document);
	if (isRecord(document.versions)) for (const version of Object.values(document.versions)) rewrite(version);
	return JSON.stringify(document);
}
