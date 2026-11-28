import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Resolution } from "./addresses";
import { startProxy } from "./proxy";

/**
 * The proxy's rules, exercised locally: a test resolver stands in for DNS and
 * maps every allowed name to 127.0.0.1, where two upstreams record exactly what
 * reaches them. The address checks themselves are tested in addresses.test.ts,
 * and the whole gateway, in Docker, in gateway.test.ts.
 */

/** Connections each upstream accepted. A forwarded request is answered only after its upstream accepts. */
let tlsConnections = 0;
let httpConnections = 0;
/** Resolves with the first bytes the next TLS upstream connection receives. */
let nextTlsData = Promise.withResolvers<Buffer>();
/** Everything each plain-HTTP upstream connection received, settled when it closes. */
const httpRequests: Promise<string>[] = [];

const tlsUpstream = createServer(socket => {
	tlsConnections += 1;
	socket.once("data", (chunk: Buffer) => nextTlsData.resolve(chunk));
	socket.on("error", () => {});
});
// Answers the first request but keeps its connection open, recording everything that
// arrives until the proxy closes it, so bytes sent after the answer would show.
const httpUpstream = createServer(socket => {
	httpConnections += 1;
	const received = Promise.withResolvers<string>();
	httpRequests.push(received.promise);
	let text = "";
	let answered = false;
	socket.on("data", (chunk: Buffer) => {
		text += chunk.toString("latin1");
		if (!answered && text.includes("\r\n\r\n")) {
			answered = true;
			socket.write("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok");
		}
	});
	socket.on("close", () => received.resolve(text));
	socket.on("error", () => {});
});

const resolutions: Record<string, Resolution> = {
	"allowed.test": { ok: true, address: "127.0.0.1" },
	"github.com": { ok: true, address: "127.0.0.1" },
	"private.test": { ok: false, reason: "resolves to non-public address 10.0.0.1" },
};

let proxy: Server;

function port(server: Server): number {
	return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
	tlsUpstream.listen(0, "127.0.0.1");
	httpUpstream.listen(0, "127.0.0.1");
	await Promise.all([once(tlsUpstream, "listening"), once(httpUpstream, "listening")]);
	proxy = startProxy(
		{ name: "test", hosts: ["allowed.test", "github.com", "private.test"], methods: ["GET", "HEAD"], readOnly: [] },
		() => {},
		{
			port: 0,
			hostname: "127.0.0.1",
			resolve: async host => resolutions[host] ?? { ok: false, reason: "does not resolve" },
			httpsPort: port(tlsUpstream),
			httpPort: port(httpUpstream),
		},
	);
	await once(proxy, "listening");
});

afterAll(() => {
	proxy.close();
	tlsUpstream.close();
	httpUpstream.close();
});

/** Sends `text` to the proxy and returns everything it answers before the connection closes. */
async function exchange(text: string): Promise<string> {
	const socket = connect(port(proxy), "127.0.0.1");
	let answer = "";
	socket.on("data", (chunk: Buffer) => {
		answer += chunk.toString("latin1");
	});
	socket.on("error", () => {});
	socket.write(text);
	await once(socket, "close");
	return answer;
}

function status(answer: string): number {
	return Number(answer.split(" ")[1]);
}

/** Opens a CONNECT tunnel, then starts a TLS handshake through it with `servername`. */
async function tunnel(target: string, servername: string): Promise<{ status: number; socket: Socket }> {
	const socket = connect(port(proxy), "127.0.0.1");
	socket.on("error", () => {});
	socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
	let head = "";
	while (!head.includes("\r\n\r\n")) {
		const [chunk] = (await once(socket, "data")) as [Buffer];
		head += chunk.toString("latin1");
	}
	tlsConnect({ socket, servername }).on("error", () => {});
	return { status: status(head), socket };
}

describe("the gateway's forward proxy", () => {
	test("tunnels HTTPS only when the ClientHello names the CONNECT host", async () => {
		nextTlsData = Promise.withResolvers<Buffer>();
		const matching = await tunnel("allowed.test:443", "allowed.test");
		expect(matching.status).toBe(200);
		expect((await nextTlsData.promise)[0]).toBe(0x16); // the ClientHello reached the upstream
		matching.socket.destroy();

		const before = tlsConnections;
		const mismatched = await tunnel("allowed.test:443", "evil.test");
		expect(mismatched.status).toBe(200);
		await once(mismatched.socket, "close"); // the gateway closed the tunnel
		expect(tlsConnections).toBe(before); // without ever contacting the upstream
	});

	test("refuses CONNECT to other ports, unlisted hosts, read-only endpoint hosts and refused addresses", async () => {
		const before = tlsConnections;
		const targets = ["allowed.test:8443", "allowed.test:80", "unlisted.test:443", "github.com:443", "private.test:443", "[::1]:443"];
		const answers = await Promise.all(targets.map(target => exchange(`CONNECT ${target} HTTP/1.1\r\n\r\n`)));
		expect(answers.map(status)).toEqual([403, 403, 403, 403, 403, 400]);
		expect(tlsConnections).toBe(before);
	});

	test("forwards one plain-HTTP request to the checked host, and nothing the client sends with or after it", async () => {
		const socket = connect(port(proxy), "127.0.0.1");
		socket.on("error", () => {});
		socket.write(
			"GET http://allowed.test/a?b=1 HTTP/1.1\r\nHost: evil.test\r\nProxy-Authorization: Basic c2VjcmV0\r\nAccept: */*\r\n\r\n" +
				"GET http://evil.test/pipelined HTTP/1.1\r\nHost: evil.test\r\n\r\n",
		);
		const [answer] = (await once(socket, "data")) as [Buffer];
		expect(status(answer.toString("latin1"))).toBe(200);
		// Another request after the answer, then the client closes, which closes the upstream.
		socket.end("GET http://evil.test/later HTTP/1.1\r\nHost: evil.test\r\n\r\n");
		expect(await httpRequests.at(-1)).toBe("GET /a?b=1 HTTP/1.1\r\nHost: allowed.test\r\nAccept: */*\r\nConnection: close\r\n\r\n");
	});

	test("refuses plain HTTP with another method, port or scheme, a body, or an unlisted host", async () => {
		const requests = [
			"POST http://allowed.test/ HTTP/1.1\r\n\r\n",
			"GET http://allowed.test:8080/ HTTP/1.1\r\n\r\n",
			"GET http://allowed.test/ HTTP/1.1\r\nContent-Length: 5\r\n\r\nhello",
			"GET http://allowed.test/ HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
			"GET http://unlisted.test/ HTTP/1.1\r\n\r\n",
			"GET http://github.com/ HTTP/1.1\r\n\r\n",
			"GET https://allowed.test/ HTTP/1.1\r\n\r\n",
			"GET /relative HTTP/1.1\r\nHost: allowed.test\r\n\r\n",
			// Any userinfo is refused; a username alone is enough to show it.
			"GET http://someone@allowed.test/ HTTP/1.1\r\n\r\n",
		];
		const before = httpConnections;
		const answers = await Promise.all(requests.map(exchange));
		expect(answers.map(status)).toEqual([405, 403, 400, 400, 403, 403, 400, 400, 400]);
		expect(httpConnections).toBe(before);
	});

	test("refuses a head with control characters, which could smuggle a second request past every check", async () => {
		const requests = [
			// A bare LF pair in a header value ends the forwarded request early for the upstream.
			"GET http://allowed.test/ HTTP/1.1\r\nX-A: a\n\nPOST /exfil HTTP/1.1\nHost: evil.test\nContent-Length: 6\n\nsecret\r\n\r\n",
			"GET http://allowed.test/ HTTP/1.1\r\nX-A: a\rb\r\n\r\n",
			"GET http://allowed.test/\n HTTP/1.1\r\n\r\n",
			"GET http://allowed.test/ HTTP/1.1\r\nX-A: \x00\r\n\r\n",
		];
		const before = httpConnections;
		const answers = await Promise.all(requests.map(exchange));
		expect(answers.map(status)).toEqual([400, 400, 400, 400]);
		expect(httpConnections).toBe(before);
	});

	test("refuses a head over 16 KiB even when it arrives in one piece", async () => {
		const before = httpConnections;
		const answer = await exchange(`GET http://allowed.test/ HTTP/1.1\r\nX-Pad: ${"a".repeat(20_000)}\r\n\r\n`);
		expect(status(answer)).toBe(431);
		expect(httpConnections).toBe(before);
	});
});
