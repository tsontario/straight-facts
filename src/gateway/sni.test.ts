import { describe, expect, test } from "bun:test";
import { once } from "node:events";
import { createServer } from "node:net";
import { connect } from "node:tls";
import { readClientHello } from "./sni";

/** Captures the first bytes a real TLS client sends, i.e. its ClientHello. */
async function clientHello(servername: string | undefined): Promise<Uint8Array> {
	const { promise, resolve } = Promise.withResolvers<Uint8Array>();
	let received = Buffer.alloc(0);
	const server = createServer(socket => {
		socket.on("data", (chunk: Buffer) => {
			received = Buffer.concat([received, chunk]);
			if (readClientHello(received).state !== "incomplete") {
				socket.destroy();
				resolve(new Uint8Array(received));
			}
		});
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("no port");
	const client = connect({ host: "127.0.0.1", port: address.port, ...(servername === undefined ? {} : { servername }) });
	client.on("error", () => {});
	try {
		return await promise;
	} finally {
		client.destroy();
		server.close();
	}
}

describe("readClientHello", () => {
	test("reads the server name a real TLS client sends, lowercased", async () => {
		expect(readClientHello(await clientHello("Example.COM"))).toEqual({ state: "ok", serverName: "example.com" });
	});

	test("reports no server name when the client sends none", async () => {
		expect(readClientHello(await clientHello(undefined))).toEqual({ state: "ok", serverName: undefined });
	});

	test("waits for a whole record, and refuses what is not a well-formed ClientHello", async () => {
		const hello = await clientHello("example.com");
		expect(readClientHello(hello.subarray(0, 4)).state).toBe("incomplete");
		expect(readClientHello(hello.subarray(0, hello.length - 1)).state).toBe("incomplete");
		expect(readClientHello(new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n")).state).toBe("invalid");
		// A handshake length larger than its record: a ClientHello split across records.
		const split = hello.slice();
		split[6] = 0xff;
		expect(readClientHello(split).state).toBe("invalid");
		// Shortened by 10 bytes with both length fields kept consistent: the extensions now overrun it.
		const truncated = hello.slice(0, hello.length - 10);
		const view = new DataView(truncated.buffer);
		view.setUint16(3, view.getUint16(3) - 10);
		view.setUint16(7, view.getUint16(7) - 10);
		expect(readClientHello(truncated).state).toBe("invalid");
	});
});
