import { Buffer } from "node:buffer";
import { connect, createServer, type Server, type Socket } from "node:net";
import { resolvePublic, type Resolution } from "./addresses";
import type { GatewayProfile } from "./config";
import { PROXY_PORT, READ_ONLY_ENDPOINT_HOSTS } from "./endpoints";
import type { Log } from "./log";
import { readClientHello } from "./sni";

/**
 * The gateway's forward proxy (decision 0002 §2). Each connection carries one
 * request:
 *
 * - `CONNECT host:443`: the host must be in the profile; it is resolved once and
 *   must be public; after the 200 the client's TLS ClientHello must name the same
 *   host (SNI), or the tunnel closes before the gateway contacts the upstream.
 * - An absolute-form plain-HTTP request to port 80: the method and host must be in
 *   the profile. No request body is forwarded, `Host` is set to the checked host,
 *   and anything else the client sends on the connection is discarded, so a second
 *   request can't reach another site on the same address.
 *
 * Hosts with read-only endpoints are refused here whatever the profile says: they
 * accept writes from token holders, so they are never reachable this way.
 */

const HEAD_LIMIT = 16_384;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** Open connections per gateway; one task's sandbox is the only client. */
const MAX_CONNECTIONS = 256;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
/** Control characters other than tab, including bare CR and LF. */
const CONTROL = /[\x00-\x08\x0a-\x1f\x7f]/;
/** Request headers that describe the client's connection, or that the gateway sets itself. */
const NOT_FORWARDED = new Set([
	"connection",
	"content-length",
	"expect",
	"host",
	"keep-alive",
	"proxy-authorization",
	"proxy-connection",
	"te",
	"trailer",
	"transfer-encoding",
	"upgrade",
]);
const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	403: "Forbidden",
	405: "Method Not Allowed",
	431: "Request Header Fields Too Large",
	503: "Service Unavailable",
};

export interface ProxyOptions {
	readonly port?: number;
	readonly hostname?: string;
	/** Tests substitute a resolver and upstream ports to exercise the proxy without a network. */
	readonly resolve?: (host: string) => Promise<Resolution>;
	readonly httpsPort?: number;
	readonly httpPort?: number;
	/** True while a halt covers the task (decision 0002 §4); everything is refused then. */
	readonly halted?: () => boolean;
}

export function startProxy(profile: GatewayProfile, log: Log, options: ProxyOptions = {}): Server {
	const resolve = options.resolve ?? resolvePublic;
	const httpsPort = options.httpsPort ?? 443;
	const httpPort = options.httpPort ?? 80;
	const halted = options.halted ?? (() => false);
	const allowed = (host: string): boolean =>
		!READ_ONLY_ENDPOINT_HOSTS.includes(host) && (profile.hosts.includes("*") || profile.hosts.includes(host));

	const server = createServer(client => {
		client.on("error", () => client.destroy());
		handle(client).catch(() => client.destroy());
	});
	server.maxConnections = MAX_CONNECTIONS;
	server.listen(options.port ?? PROXY_PORT, options.hostname ?? "0.0.0.0");
	return server;

	async function handle(client: Socket): Promise<void> {
		const head = await collect(client, Buffer.alloc(0), data => {
			const end = data.indexOf("\r\n\r\n");
			if (end !== -1) return end + 4 <= HEAD_LIMIT ? "done" : "fail";
			return data.length > HEAD_LIMIT ? "fail" : "more";
		});
		if (!head) return refuse(client, 431, "request head too large, incomplete or slow", {});
		const end = head.indexOf("\r\n\r\n");
		const lines = head.subarray(0, end).toString("latin1").split("\r\n");
		// A bare LF or CR inside a line would end the request early for the upstream, smuggling
		// whatever follows past every check. No control character but tab is accepted anywhere.
		if (lines.some(line => CONTROL.test(line))) return refuse(client, 400, "control character in the request head", {});
		const [requestLine = "", ...headerLines] = lines;
		const rest = head.subarray(end + 4);
		const [method = "", target = "", version = "", ...extra] = requestLine.split(" ");
		if (extra.length > 0 || !/^HTTP\/1\.[01]$/.test(version) || !TOKEN.test(method)) return refuse(client, 400, "malformed request line", {});
		const headers: [string, string][] = [];
		for (const line of headerLines) {
			const colon = line.indexOf(":");
			const name = line.slice(0, colon);
			if (colon < 1 || !TOKEN.test(name)) return refuse(client, 400, "malformed header", {});
			headers.push([name, line.slice(colon + 1).trim()]);
		}
		if (halted()) return refuse(client, 503, "halted", method === "CONNECT" ? { kind: "connect", target } : { kind: "http", method, target });
		if (method === "CONNECT") return tunnel(client, target, rest);
		return forward(client, method, target, headers);
	}

	async function tunnel(client: Socket, target: string, rest: Buffer): Promise<void> {
		const match = /^([a-z0-9.-]+):(\d{1,5})$/.exec(target.toLowerCase());
		const entry = { kind: "connect", target };
		if (!match) return refuse(client, 400, "CONNECT needs host:port", entry);
		const [, host = "", port = ""] = match;
		if (port !== "443") return refuse(client, 403, "CONNECT is allowed only to port 443", entry);
		if (!allowed(host)) return refuse(client, 403, `${host} is not in the task's network profile`, entry);
		const resolution = await resolve(host);
		if (!resolution.ok) return refuse(client, 403, `${host}: ${resolution.reason}`, entry);
		client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		const hello = await collect(client, rest, data => (readClientHello(data).state === "incomplete" ? "more" : "done"));
		const parsed = hello ? readClientHello(hello) : undefined;
		if (!hello || !parsed || parsed.state !== "ok") {
			log({ ...entry, decision: "refused", reason: parsed?.state === "invalid" ? parsed.reason : "no TLS ClientHello" });
			client.destroy();
			return;
		}
		if (parsed.serverName !== host) {
			log({ ...entry, decision: "refused", reason: `SNI ${JSON.stringify(parsed.serverName ?? null)} does not match ${host}` });
			client.destroy();
			return;
		}
		log({ ...entry, decision: "forwarded", address: resolution.address });
		splice(client, connect({ host: resolution.address, port: httpsPort }), hello, true);
	}

	async function forward(client: Socket, method: string, target: string, headers: readonly [string, string][]): Promise<void> {
		const entry = { kind: "http", method, target };
		let url: URL;
		try {
			url = new URL(target);
		} catch {
			return refuse(client, 400, "expected an absolute http:// URL", entry);
		}
		if (url.protocol !== "http:" || url.username !== "" || url.password !== "") return refuse(client, 400, "expected an absolute http:// URL", entry);
		if (url.port !== "" && url.port !== "80") return refuse(client, 403, "plain HTTP is allowed only on port 80", entry);
		const host = url.hostname;
		if (!profile.methods.includes(method)) return refuse(client, 405, `${method} is not allowed by the task's network profile`, entry);
		if (!allowed(host)) return refuse(client, 403, `${host} is not in the task's network profile`, entry);
		const hasBody = headers.some(([name, value]) => {
			const lower = name.toLowerCase();
			return lower === "transfer-encoding" || (lower === "content-length" && value !== "0");
		});
		if (hasBody) return refuse(client, 400, "the gateway forwards no request bodies", entry);
		const resolution = await resolve(host);
		if (!resolution.ok) return refuse(client, 403, `${host}: ${resolution.reason}`, entry);
		const lines = [`${method} ${url.pathname}${url.search} HTTP/1.1`, `Host: ${host}`];
		for (const [name, value] of headers) if (!NOT_FORWARDED.has(name.toLowerCase())) lines.push(`${name}: ${value}`);
		lines.push("Connection: close");
		log({ ...entry, decision: "forwarded", address: resolution.address });
		splice(client, connect({ host: resolution.address, port: httpPort }), Buffer.from(`${lines.join("\r\n")}\r\n\r\n`, "latin1"), false);
	}

	function refuse(client: Socket, status: number, reason: string, entry: Readonly<Record<string, unknown>>): void {
		log({ ...entry, decision: "refused", reason });
		const body = `${reason}\n`;
		client.end(
			`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
		);
	}
}

/**
 * Sends `first` upstream, then relays upstream to client. If `bidirectional`,
 * the client's further bytes go upstream too; otherwise they are discarded.
 */
function splice(client: Socket, upstream: Socket, first: Buffer, bidirectional: boolean): void {
	upstream.on("error", () => client.destroy());
	client.on("close", () => upstream.destroy());
	upstream.on("close", () => client.destroy());
	upstream.once("connect", () => {
		upstream.write(first);
		upstream.pipe(client);
		if (bidirectional) client.pipe(upstream);
		else client.on("data", () => {});
		client.resume();
	});
}

/**
 * Reads from a paused-or-flowing socket into a buffer, starting from `initial`,
 * until `check` says done or fail, the peer closes, or the handshake timeout
 * passes. Leaves the socket paused, with nothing lost, and returns the buffer on
 * success.
 */
function collect(socket: Socket, initial: Buffer, check: (data: Buffer) => "more" | "done" | "fail"): Promise<Buffer | undefined> {
	let data = initial;
	const first = data.length > 0 ? check(data) : "more";
	if (first !== "more") return Promise.resolve(first === "done" ? data : undefined);
	const { promise, resolve } = Promise.withResolvers<Buffer | undefined>();
	const timer = setTimeout(() => finish(undefined), HANDSHAKE_TIMEOUT_MS);
	const onData = (chunk: Buffer): void => {
		data = Buffer.concat([data, chunk]);
		const state = check(data);
		if (state !== "more") finish(state === "done" ? data : undefined);
	};
	const onClose = (): void => finish(undefined);
	function finish(result: Buffer | undefined): void {
		clearTimeout(timer);
		socket.off("data", onData);
		socket.off("end", onClose);
		socket.off("close", onClose);
		socket.pause();
		resolve(result);
	}
	socket.on("data", onData);
	socket.on("end", onClose);
	socket.on("close", onClose);
	socket.resume();
	return promise;
}
