/**
 * The gateway's fixed addresses and read-only endpoints (decision 0002 §2).
 *
 * Hosts that accept writes from anyone holding a token are never reachable over
 * HTTPS. The gateway serves each of them as a plain-HTTP reverse proxy inside
 * the task network, on its own port, accepting only GET and HEAD.
 */

/** The gateway's name on the task network. */
export const GATEWAY_HOST = "gateway";
/** The forward proxy: CONNECT for HTTPS, absolute-form requests for plain HTTP. */
export const PROXY_PORT = 3128;

export interface ReadOnlyEndpoint {
	readonly host: string;
	readonly port: number;
	readonly upstream: string;
}

export const READ_ONLY_ENDPOINTS: readonly ReadOnlyEndpoint[] = [
	{ host: "registry.npmjs.org", port: 4873, upstream: "https://registry.npmjs.org" },
	{ host: "github.com", port: 4874, upstream: "https://github.com" },
];

export const READ_ONLY_ENDPOINT_HOSTS: readonly string[] = READ_ONLY_ENDPOINTS.map(endpoint => endpoint.host);

/** The URL a sandbox uses for a read-only endpoint, e.g. as `bun install --registry`. */
export function endpointUrl(endpoint: ReadOnlyEndpoint): string {
	return `http://${GATEWAY_HOST}:${endpoint.port}`;
}
