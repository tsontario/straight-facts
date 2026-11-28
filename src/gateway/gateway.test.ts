import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-log/event-log";
import { writeHaltFile } from "../halt/halt";
import { testImage } from "../images/images";
import { startTaskNetwork, type TaskNetwork } from "../sandbox/network";
import { startSandbox } from "../sandbox/sandbox";

/**
 * The gateway in Docker, driven from inside a real sandbox on its task network
 * (decision 0002 §2, build step 2). Required in CI; skipped without Docker.
 *
 * The test profile lists private, link-local, CGNAT and Docker addresses and
 * names, and github.com, as HTTPS hosts on purpose: the gateway must refuse
 * them even when a profile lists them. Some checks reach the internet
 * (example.com, the npm registry).
 */
const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
if (process.env.CI && !dockerAvailable) throw new Error("Docker is required for the gateway tests in CI");

const REFUSED_TARGETS = [
	"localhost",
	"host.docker.internal",
	"10.1.2.3",
	"127.0.0.1",
	"169.254.169.254",
	"172.17.0.1",
	"192.168.65.1",
	"100.64.0.1",
	"github.com",
	"registry.npmjs.org",
];

/** Runs inside the sandbox: probes the gateway and prints one JSON object of results. */
const PROBE = `
import { connect } from "node:net";
import { connect as tlsConnect } from "node:tls";

function openProxy(request) {
	const socket = connect(3128, "gateway");
	socket.on("error", () => {});
	socket.write(request);
	return new Promise(resolve => {
		let head = "";
		const onData = chunk => {
			head += chunk.toString("latin1");
			if (!head.includes("\\r\\n")) return;
			socket.off("data", onData);
			resolve({ socket, status: Number(head.split(" ")[1]) });
		};
		socket.on("data", onData);
		socket.on("close", () => resolve({ socket, status: "closed" }));
	});
}

async function status(request) {
	const { socket, status } = await openProxy(request);
	socket.destroy();
	return status;
}

async function sni(target, servername) {
	const { socket, status } = await openProxy("CONNECT " + target + " HTTP/1.1\\r\\n\\r\\n");
	if (status !== 200) return "status " + status;
	const tls = tlsConnect({ socket, servername });
	return new Promise(resolve => {
		tls.once("secureConnect", () => { resolve("handshake"); tls.destroy(); });
		tls.once("error", () => resolve("closed"));
		tls.once("close", () => resolve("closed"));
		setTimeout(() => resolve("timeout"), 15000);
	});
}

const results = {};
for (const target of ${JSON.stringify(REFUSED_TARGETS)}) {
	results["CONNECT " + target + ":443"] = await status("CONNECT " + target + ":443 HTTP/1.1\\r\\n\\r\\n");
}
results["CONNECT example.com:443"] = await status("CONNECT example.com:443 HTTP/1.1\\r\\n\\r\\n");
results["CONNECT example.com:8443"] = await status("CONNECT example.com:8443 HTTP/1.1\\r\\n\\r\\n");
results["CONNECT unlisted.example:443"] = await status("CONNECT unlisted.example:443 HTTP/1.1\\r\\n\\r\\n");
results["SNI example.com"] = await sni("example.com:443", "example.com");
results["SNI evil.example"] = await sni("example.com:443", "evil.example");
results["GET http://example.com/"] = await status("GET http://example.com/ HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n");
results["POST http://example.com/"] = await status("POST http://example.com/ HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 0\\r\\n\\r\\n");
results["GET http://example.com:8080/"] = await status("GET http://example.com:8080/ HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n");
for (const port of [4873, 4874]) {
	for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
		results[method + " :" + port] = (await fetch("http://gateway:" + port + "/left-pad", { method, body: "x" })).status;
	}
}
const packument = await fetch("http://gateway:4873/left-pad");
results["npm GET"] = packument.status;
results["npm tarball"] = (await packument.json()).versions["1.3.0"].dist.tarball;
results["HTTPS registry.npmjs.org"] = await fetch("https://registry.npmjs.org/left-pad").then(response => response.status, () => "blocked");
console.log(JSON.stringify(results));
`;

describe.skipIf(!dockerAvailable)("the gateway, from inside a sandbox", () => {
	let sandboxImage: string;
	let network: TaskNetwork | undefined;
	let workspace: string;
	let dockerConfig: string | undefined;
	let stateDir: string | undefined;
	let results: Record<string, unknown> = {};
	let counter = 0;

	async function runIn(command: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
		if (!network) throw new Error("no task network");
		counter += 1;
		const proc = startSandbox(sandboxImage, {
			taskId: `gw-${process.pid}-${counter}`,
			laneId: "lane-0001",
			repo: "tsontario/straight-facts",
			network: network.name,
			workspace,
			command,
		});
		proc.stdin.end();
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout: stdout.trim(), stderr };
	}

	beforeAll(async () => {
		sandboxImage = await testImage("sandbox");
		const gatewayImage = await testImage("gateway");
		// Start the gateway with a docker client config whose proxies would redirect its
		// upstream requests if the docker client copied them in.
		dockerConfig = mkdtempSync(join(tmpdir(), "sf-gw-docker-config-"));
		stateDir = mkdtempSync(join(tmpdir(), "sf-gw-state-"));
		const haltDir = join(stateDir, "halt");
		await writeHaltFile({ log: EventLog.open(":memory:"), approvers: new Set(), haltDir });
		const proxy = "http://proxy.invalid:3128";
		writeFileSync(join(dockerConfig, "config.json"), JSON.stringify({ proxies: { default: { httpProxy: proxy, httpsProxy: proxy, allProxy: proxy } } }));
		const dockerHost =
			process.env.DOCKER_HOST ??
			Bun.spawnSync(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).stdout.toString().trim();
		const saved = { DOCKER_CONFIG: process.env.DOCKER_CONFIG, DOCKER_HOST: process.env.DOCKER_HOST };
		Object.assign(process.env, { DOCKER_CONFIG: dockerConfig, DOCKER_HOST: dockerHost });
		try {
			network = await startTaskNetwork(gatewayImage, {
				taskId: `gw-${process.pid}`,
				laneId: "lane-0001",
				repo: "tsontario/straight-facts",
				profile: {
					name: "test",
					hosts: ["example.com", ...REFUSED_TARGETS],
					methods: ["GET", "HEAD"],
					readOnly: ["registry.npmjs.org", "github.com"],
				},
				haltDir,
			});
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
		workspace = mkdtempSync(join(tmpdir(), "sf-gw-ws-"));
		writeFileSync(join(workspace, "probe.mjs"), PROBE);
		const probe = await runIn(["bun", "/workspace/probe.mjs"]);
		if (probe.code !== 0) throw new Error(`probe failed: ${probe.stderr}`);
		results = JSON.parse(probe.stdout) as Record<string, unknown>;
	}, 600_000);

	afterAll(async () => {
		await network?.stop();
		if (workspace) rmSync(workspace, { recursive: true, force: true });
		if (dockerConfig) rmSync(dockerConfig, { recursive: true, force: true });
		if (stateDir) rmSync(stateDir, { recursive: true, force: true });
	});

	test("runs unprivileged, read-only and without the docker client's proxy settings", async () => {
		const script = [
			'const fs = require("fs");',
			'const status = fs.readFileSync("/proc/self/status", "utf8").split("\\n").filter(line => /^(CapEff|CapBnd|NoNewPrivs):/.test(line)).map(line => line.replace(/\\s+/g, " "));',
			// /home/nonroot belongs to the gateway's user, so only the read-only root stops writes there.
			'let writable = true; try { fs.writeFileSync("/home/nonroot/x", "x"); } catch { writable = false; }',
			"const proxies = Object.keys(process.env).filter(key => /proxy/i.test(key));",
			"console.log(JSON.stringify({ uid: process.getuid(), status, writable, proxies }));",
		].join(" ");
		const exec = Bun.spawnSync(["docker", "exec", network?.gateway ?? "", "/usr/local/bin/bun", "-e", script]);
		expect(JSON.parse(exec.stdout.toString())).toEqual({
			uid: 65532,
			status: ["CapEff: 0000000000000000", "CapBnd: 0000000000000000", "NoNewPrivs: 1"],
			writable: false,
			proxies: [],
		});
	});

	test("refuses CONNECT to non-public addresses, Docker names and token-write hosts, even when the profile lists them", () => {
		const refused = Object.fromEntries(REFUSED_TARGETS.map(target => [`CONNECT ${target}:443`, 403]));
		expect(Object.fromEntries(REFUSED_TARGETS.map(target => [`CONNECT ${target}:443`, results[`CONNECT ${target}:443`]]))).toEqual(refused);
	});

	test("allows CONNECT only to a listed host on port 443", () => {
		expect([results["CONNECT example.com:443"], results["CONNECT example.com:8443"], results["CONNECT unlisted.example:443"]]).toEqual([200, 403, 403]);
	});

	test("completes a TLS handshake only when the SNI matches the CONNECT host", () => {
		expect([results["SNI example.com"], results["SNI evil.example"]]).toEqual(["handshake", "closed"]);
	});

	test("allows plain HTTP only with the profile's methods, on port 80", async () => {
		// The GET is forwarded: whatever example.com answers, it is not one of the gateway's refusals.
		expect([400, 403, 405]).not.toContain(results["GET http://example.com/"]);
		const decisions = ((await network?.logs()) ?? "").split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as Record<string, unknown>);
		expect(decisions).toContainEqual(expect.objectContaining({ kind: "http", method: "GET", target: "http://example.com/", decision: "forwarded" }));
		expect([results["POST http://example.com/"], results["GET http://example.com:8080/"]]).toEqual([405, 403]);
	});

	test("each read-only endpoint refuses every method except GET and HEAD", () => {
		const writes = ["POST", "PUT", "PATCH", "DELETE"].flatMap(method => [`${method} :4873`, `${method} :4874`]);
		expect(Object.fromEntries(writes.map(key => [key, results[key]]))).toEqual(Object.fromEntries(writes.map(key => [key, 405])));
	});

	test("serves npm metadata with tarball URLs pointing at itself, while HTTPS to the registry is refused", () => {
		expect([results["npm GET"], results["npm tarball"], results["HTTPS registry.npmjs.org"]]).toEqual([
			200,
			"http://gateway:4873/left-pad/-/left-pad-1.3.0.tgz",
			"blocked",
		]);
	});

	test("bun install succeeds through the npm endpoint", async () => {
		mkdirSync(join(workspace, "app"));
		writeFileSync(join(workspace, "app", "package.json"), JSON.stringify({ name: "app", private: true, dependencies: { "left-pad": "1.3.0" } }));
		const install = await runIn(["sh", "-c", "cd /workspace/app && bun install --registry http://gateway:4873/ && test -f node_modules/left-pad/index.js && echo installed"]);
		expect([install.code, install.stdout.split("\n").at(-1)]).toEqual([0, "installed"]);
	}, 120_000);

	test("logs each refusal with its reason", async () => {
		const lines = (await network?.logs())?.split("\n").filter(line => line.startsWith("{")) ?? [];
		const decisions = lines.map(line => JSON.parse(line) as Record<string, unknown>);
		expect(decisions).toContainEqual(expect.objectContaining({ kind: "connect", decision: "refused", reason: 'SNI "evil.example" does not match example.com' }));
		expect(decisions).toContainEqual(expect.objectContaining({ kind: "connect", target: "169.254.169.254:443", decision: "refused" }));
	});
});
