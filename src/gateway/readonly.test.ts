import { afterAll, describe, expect, test } from "bun:test";
import { READ_ONLY_ENDPOINTS, type ReadOnlyEndpoint } from "./endpoints";
import { serveReadOnly } from "./readonly";

function endpoint(host: string): ReadOnlyEndpoint {
	const found = READ_ONLY_ENDPOINTS.find(candidate => candidate.host === host);
	if (!found) throw new Error(`no endpoint for ${host}`);
	return found;
}

/** A stand-in for the registry or GitHub: records each request it receives. */
const received: { method: string; path: string; headers: Record<string, string> }[] = [];
const upstream = Bun.serve({
	port: 0,
	hostname: "127.0.0.1",
	fetch(request): Response {
		const url = new URL(request.url);
		received.push({ method: request.method, path: url.pathname, headers: Object.fromEntries(request.headers) });
		const origin = url.origin;
		if (url.pathname === "/moved") return new Response(null, { status: 301, headers: { location: `${origin}/left-pad` } });
		const packument = {
			name: "left-pad",
			versions: {
				"1.3.0": { dist: { tarball: `${origin}/left-pad/-/left-pad-1.3.0.tgz` } },
				// A version whose tarball is on another host: the endpoint must leave it alone.
				"1.2.0": { dist: { tarball: "https://example.com/left-pad-1.2.0.tgz" } },
			},
		};
		return Response.json(packument, { headers: { "set-cookie": "session=abc", "content-type": "application/vnd.npm.install-v1+json" } });
	},
});
const origin = `http://127.0.0.1:${upstream.port}`;
const log = (): void => {};
const npm = serveReadOnly(endpoint("registry.npmjs.org"), log, { upstream: origin, port: 0, hostname: "127.0.0.1" });
const github = serveReadOnly(endpoint("github.com"), log, { upstream: origin, port: 0, hostname: "127.0.0.1" });

afterAll(() => {
	npm.stop(true);
	github.stop(true);
	upstream.stop(true);
});

describe("a read-only endpoint", () => {
	test("refuses every method but GET and HEAD without contacting the upstream", async () => {
		const before = received.length;
		for (const server of [npm, github]) {
			for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
				const response = await fetch(`http://127.0.0.1:${server.port}/left-pad`, { method, body: method === "OPTIONS" ? null : "x" });
				expect([method, response.status, response.headers.get("allow")]).toEqual([method, 405, "GET, HEAD"]);
			}
		}
		expect(received.length).toBe(before);
	});

	test("forwards no credentials or cookies upstream, and returns none", async () => {
		const response = await fetch(`http://127.0.0.1:${npm.port}/left-pad`, {
			headers: { authorization: "Bearer npm_secret", cookie: "session=xyz", "x-api-key": "secret", accept: "application/json" },
		});
		const sent = received.at(-1)?.headers ?? {};
		expect([sent.authorization, sent.cookie, sent["x-api-key"], sent.accept]).toEqual([undefined, undefined, undefined, "application/json"]);
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	test("points the registry's tarball URLs at itself, and leaves other hosts' URLs alone", async () => {
		const body = (await (await fetch(`http://127.0.0.1:${npm.port}/left-pad`)).json()) as { versions: Record<string, { dist: { tarball: string } }> };
		expect(body.versions["1.3.0"]?.dist.tarball).toBe("http://gateway:4873/left-pad/-/left-pad-1.3.0.tgz");
		expect(body.versions["1.2.0"]?.dist.tarball).toBe("https://example.com/left-pad-1.2.0.tgz");
	});

	test("points same-host redirects at itself", async () => {
		const response = await fetch(`http://127.0.0.1:${github.port}/moved`, { redirect: "manual" });
		expect([response.status, response.headers.get("location")]).toEqual([301, "http://gateway:4874/left-pad"]);
	});

	test("does not rewrite documents from GitHub", async () => {
		const body = await (await fetch(`http://127.0.0.1:${github.port}/left-pad`)).text();
		expect(body).toContain(`${origin}/left-pad/-/left-pad-1.3.0.tgz`);
	});
});
