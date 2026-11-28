import { describe, expect, test } from "bun:test";
import { isPublicIPv4, resolvePublic } from "./addresses";

describe("isPublicIPv4", () => {
	test("refuses every private, loopback, link-local, CGNAT, Docker, multicast and reserved range", () => {
		const refused = [
			"0.0.0.0",
			"10.0.0.1",
			"10.255.255.255",
			"100.64.0.1",
			"100.127.255.254",
			"127.0.0.1",
			"169.254.169.254", // cloud metadata
			"172.16.0.1",
			"172.17.0.1", // Docker's default bridge
			"172.31.255.254",
			"192.0.0.8",
			"192.0.2.1",
			"192.88.99.1",
			"192.168.0.1",
			"192.168.65.254", // Docker Desktop
			"198.18.0.1",
			"198.51.100.1",
			"203.0.113.1",
			"224.0.0.251",
			"239.255.255.250",
			"240.0.0.1",
			"255.255.255.255",
		];
		expect(refused.filter(isPublicIPv4)).toEqual([]);
	});

	test("accepts public addresses, including the neighbours of refused ranges", () => {
		const accepted = ["1.1.1.1", "8.8.8.8", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "192.167.255.255", "192.169.0.1", "223.255.255.255"];
		expect(accepted.filter(address => !isPublicIPv4(address))).toEqual([]);
	});

	test("accepts only dotted-quad IPv4", () => {
		expect(["::1", "2606:4700::1111", "example.com", "1.1.1", "1.1.1.256"].filter(isPublicIPv4)).toEqual([]);
	});
});

describe("resolvePublic", () => {
	test("refuses Docker names, IPv6, private literals and names that resolve to loopback", async () => {
		const reasons = await Promise.all(
			["host.docker.internal", "gateway.docker.internal", "::1", "10.1.2.3", "localhost"].map(async host => {
				const result = await resolvePublic(host);
				return result.ok ? `${host} accepted` : host;
			}),
		);
		expect(reasons).toEqual(["host.docker.internal", "gateway.docker.internal", "::1", "10.1.2.3", "localhost"]);
	});

	test("refuses *.docker.internal by name, before any lookup", async () => {
		expect(await resolvePublic("anything.docker.internal")).toEqual({ ok: false, reason: "Docker host name" });
	});

	test("returns a public literal as the address to connect to", async () => {
		expect(await resolvePublic("1.1.1.1")).toEqual({ ok: true, address: "1.1.1.1" });
	});
});
