/**
 * Reads the server name (SNI) from a TLS ClientHello, so the gateway can check
 * that an HTTPS tunnel goes to the host it was opened for (decision 0002 §2).
 *
 * Only a ClientHello that fits in one TLS record is accepted; that covers every
 * mainstream client. Anything malformed is `invalid`, and the gateway closes it.
 */

export type ClientHello =
	| { readonly state: "incomplete" }
	| { readonly state: "invalid"; readonly reason: string }
	| { readonly state: "ok"; readonly serverName: string | undefined };

const HANDSHAKE = 0x16;
const CLIENT_HELLO = 0x01;
const SERVER_NAME = 0x0000;
const HOST_NAME = 0x00;
/** TLS records carry at most 2^14 bytes of plaintext. */
const MAX_RECORD = 16_384;

export function readClientHello(data: Uint8Array): ClientHello {
	if (data.length < 5) return { state: "incomplete" };
	if (data[0] !== HANDSHAKE) return { state: "invalid", reason: "not a TLS handshake" };
	const recordLength = u16(data, 3);
	if (recordLength > MAX_RECORD) return { state: "invalid", reason: "record too long" };
	if (data.length < 5 + recordLength) return { state: "incomplete" };
	const record = data.subarray(5, 5 + recordLength);
	if (record[0] !== CLIENT_HELLO) return { state: "invalid", reason: "not a ClientHello" };
	try {
		const helloLength = u24(record, 1);
		if (4 + helloLength > record.length) return { state: "invalid", reason: "ClientHello spans more than one record" };
		return { state: "ok", serverName: serverName(record.subarray(4, 4 + helloLength)) };
	} catch (error) {
		return { state: "invalid", reason: error instanceof Error ? error.message : "malformed ClientHello" };
	}
}

/** Walks the ClientHello body to its extensions and returns the host name, if any. */
function serverName(hello: Uint8Array): string | undefined {
	let at = 2 + 32; // legacy_version, random
	at = skip(hello, at, 1); // legacy_session_id
	at = skip(hello, at, 2); // cipher_suites
	at = skip(hello, at, 1); // legacy_compression_methods
	if (at === hello.length) return undefined; // no extensions
	const extensionsEnd = at + 2 + u16(hello, at);
	if (extensionsEnd !== hello.length) throw new Error("extensions length mismatch");
	at += 2;
	let name: string | undefined;
	let seen = false;
	while (at < extensionsEnd) {
		const type = u16(hello, at);
		const length = u16(hello, at + 2);
		const body = slice(hello, at + 4, length);
		at += 4 + length;
		if (type !== SERVER_NAME) continue;
		if (seen) throw new Error("duplicate server_name extension");
		seen = true;
		name = hostName(body);
	}
	if (at !== extensionsEnd) throw new Error("extension overruns the ClientHello");
	return name;
}

function hostName(extension: Uint8Array): string {
	const listEnd = 2 + u16(extension, 0);
	if (listEnd !== extension.length) throw new Error("server_name list length mismatch");
	let at = 2;
	let name: string | undefined;
	while (at < listEnd) {
		const type = extension[at];
		const length = u16(extension, at + 1);
		const value = slice(extension, at + 3, length);
		at += 3 + length;
		if (type !== HOST_NAME) continue;
		if (name !== undefined) throw new Error("more than one host name");
		name = new TextDecoder("ascii", { fatal: true }).decode(value).toLowerCase();
	}
	if (at !== listEnd || name === undefined) throw new Error("malformed server_name");
	return name;
}

function skip(data: Uint8Array, at: number, lengthBytes: 1 | 2): number {
	const length = lengthBytes === 1 ? byte(data, at) : u16(data, at);
	const end = at + lengthBytes + length;
	if (end > data.length) throw new Error("field overruns the ClientHello");
	return end;
}

function slice(data: Uint8Array, at: number, length: number): Uint8Array {
	if (at + length > data.length) throw new Error("field overruns the ClientHello");
	return data.subarray(at, at + length);
}

function byte(data: Uint8Array, at: number): number {
	const value = data[at];
	if (value === undefined) throw new Error("truncated ClientHello");
	return value;
}

function u16(data: Uint8Array, at: number): number {
	return byte(data, at) * 256 + byte(data, at + 1);
}

function u24(data: Uint8Array, at: number): number {
	return byte(data, at) * 65_536 + u16(data, at + 1);
}
