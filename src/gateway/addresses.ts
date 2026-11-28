import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * The gateway connects only to public IPv4 addresses (decision 0002 §2). It
 * resolves a name once, refuses it if any address is not public, and connects to
 * the address it checked, so a second lookup can't rebind the name.
 */

/** IPv4 ranges the gateway never connects to, as [network, prefix length]. */
const REFUSED: readonly (readonly [string, number])[] = [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8], // RFC 1918
	["100.64.0.0", 10], // CGNAT
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, including cloud metadata services
	["172.16.0.0", 12], // RFC 1918, including Docker's default bridge networks
	["192.0.0.0", 24], // IETF protocol assignments
	["192.0.2.0", 24], // documentation
	["192.88.99.0", 24], // 6to4 relay anycast
	["192.168.0.0", 16], // RFC 1918, including Docker Desktop's 192.168.65.0/24
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation
	["203.0.113.0", 24], // documentation
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, and the broadcast address
];

function toNumber(address: string): number {
	return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

const REFUSED_RANGES = REFUSED.map(([network, bits]) => {
	const size = 2 ** (32 - bits);
	const start = toNumber(network);
	return { start, end: start + size - 1 };
});

export function isPublicIPv4(address: string): boolean {
	if (isIP(address) !== 4) return false;
	const value = toNumber(address);
	return !REFUSED_RANGES.some(range => value >= range.start && value <= range.end);
}

export type Resolution = { readonly ok: true; readonly address: string } | { readonly ok: false; readonly reason: string };

/**
 * Resolves `host` to one public IPv4 address, or explains why not. IPv6 is not
 * supported: the task network and the egress network are IPv4 only.
 */
export async function resolvePublic(host: string): Promise<Resolution> {
	if (host === "docker.internal" || host.endsWith(".docker.internal")) return { ok: false, reason: "Docker host name" };
	const family = isIP(host);
	if (family === 6) return { ok: false, reason: "IPv6 address" };
	let addresses: string[];
	if (family === 4) addresses = [host];
	else {
		try {
			addresses = (await lookup(host, { all: true, family: 4 })).map(entry => entry.address);
		} catch {
			return { ok: false, reason: "does not resolve" };
		}
	}
	const first = addresses[0];
	if (first === undefined) return { ok: false, reason: "does not resolve" };
	const refused = addresses.find(address => !isPublicIPv4(address));
	if (refused !== undefined) return { ok: false, reason: `resolves to non-public address ${refused}` };
	return { ok: true, address: first };
}
