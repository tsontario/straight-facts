import { expect, test } from "bun:test";
import { GatewayConfigError, parseGatewayConfig } from "./config";

const valid = { task: "t-1", profile: { name: "web", hosts: ["example.com"], methods: ["GET"], readOnly: ["github.com"] } };
const model = { proxy: "http://host.docker.internal:7777", token: "a".repeat(40) };

function withProfile(profile: Record<string, unknown>): string {
	return JSON.stringify({ ...valid, profile: { ...valid.profile, ...profile } });
}

test("accepts a valid config, with or without a model route", () => {
	expect(parseGatewayConfig(JSON.stringify(valid))).toEqual({ ...valid, model: undefined });
	expect(parseGatewayConfig(JSON.stringify({ ...valid, model }))).toEqual({ ...valid, model });
});

test("refuses a config that would widen what the gateway forwards", () => {
	const invalid = [
		withProfile({ hosts: ["example.com:443"] }),
		withProfile({ hosts: ["Example.com"] }),
		withProfile({ hosts: ["exa mple.com"] }),
		withProfile({ hosts: "example.com" }),
		withProfile({ methods: ["CONNECT"] }),
		withProfile({ readOnly: ["gitlab.com"] }),
		JSON.stringify({ profile: valid.profile }),
		// A model route anywhere but a plain host:port, or with a short or odd token.
		JSON.stringify({ ...valid, model: { ...model, proxy: "http://host.docker.internal:7777/v1?x=1" } }),
		JSON.stringify({ ...valid, model: { ...model, proxy: "https://host.docker.internal:7777" } }),
		JSON.stringify({ ...valid, model: { ...model, token: "short" } }),
		JSON.stringify({ ...valid, model: { ...model, token: `${"a".repeat(40)}\r\nX: y` } }),
	];
	const accepted = invalid.filter(text => {
		try {
			parseGatewayConfig(text);
			return true;
		} catch (error) {
			if (error instanceof GatewayConfigError) return false;
			throw error;
		}
	});
	expect(accepted).toEqual([]);
});
