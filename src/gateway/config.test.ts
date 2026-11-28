import { expect, test } from "bun:test";
import { GatewayConfigError, parseGatewayConfig } from "./config";

const valid = { task: "t-1", profile: { name: "web", hosts: ["example.com"], methods: ["GET"], readOnly: ["github.com"] } };

function withProfile(profile: Record<string, unknown>): string {
	return JSON.stringify({ ...valid, profile: { ...valid.profile, ...profile } });
}

test("accepts a valid config", () => {
	expect(parseGatewayConfig(JSON.stringify(valid))).toEqual(valid);
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
