import { isRecord } from "../util/guards";
import { READ_ONLY_ENDPOINT_HOSTS } from "./endpoints";

/**
 * What the control plane tells a task's gateway, through a read-only mount: the
 * task and its network profile (from `tasks/taxonomy.toml`).
 */

export interface GatewayProfile {
	readonly name: string;
	/** Hosts reachable over HTTPS (CONNECT to 443) and plain HTTP (port 80); `*` means any public host. */
	readonly hosts: readonly string[];
	/** Methods allowed for plain HTTP. */
	readonly methods: readonly string[];
	/** Read-only endpoints to serve. */
	readonly readOnly: readonly string[];
}

export interface GatewayConfig {
	readonly task: string;
	readonly profile: GatewayProfile;
}

export const CONFIG_PATH = "/etc/straight-facts/gateway.json";

const HOST = /^(\*|[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*)$/;
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

export class GatewayConfigError extends Error {
	override readonly name = "GatewayConfigError";
}

export function parseGatewayConfig(text: string): GatewayConfig {
	const root: unknown = JSON.parse(text);
	const profile = isRecord(root) ? root.profile : undefined;
	if (!isRecord(root) || typeof root.task !== "string" || root.task.length === 0) throw new GatewayConfigError("task must be a non-empty string");
	if (!isRecord(profile) || typeof profile.name !== "string") throw new GatewayConfigError("profile must name a network profile");
	const hosts = strings(profile.hosts, "profile.hosts");
	const methods = strings(profile.methods, "profile.methods");
	const readOnly = strings(profile.readOnly, "profile.readOnly");
	const badHost = hosts.find(host => !HOST.test(host));
	if (badHost !== undefined) throw new GatewayConfigError(`profile.hosts: invalid host ${JSON.stringify(badHost)}`);
	const badMethod = methods.find(method => !METHODS.includes(method));
	if (badMethod !== undefined) throw new GatewayConfigError(`profile.methods: unknown method ${JSON.stringify(badMethod)}`);
	const badEndpoint = readOnly.find(host => !READ_ONLY_ENDPOINT_HOSTS.includes(host));
	if (badEndpoint !== undefined) throw new GatewayConfigError(`profile.readOnly: no endpoint for ${JSON.stringify(badEndpoint)}`);
	return { task: root.task, profile: { name: profile.name, hosts, methods, readOnly } };
}

function strings(value: unknown, where: string): string[] {
	if (!Array.isArray(value) || !value.every(item => typeof item === "string")) throw new GatewayConfigError(`${where} must be a list of strings`);
	return value;
}
