import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-log/event-log";
import { TASK_TOKEN_HEADER } from "../gateway/endpoints";
import { writeHaltFile } from "../halt/halt";
import { buildImage } from "../images/images";
import { startTaskNetwork, type TaskNetwork } from "../sandbox/network";
import { startSandbox } from "../sandbox/sandbox";
import { isRecord } from "../util/guards";
import { loadPricePolicy } from "./policy";
import { ModelProxy } from "./proxy";

/**
 * A model call end to end (decision 0002 §2 and §3): the real omp in a sandbox
 * calls its gateway's model route, which adds the task token and forwards to the
 * control plane's model proxy, which reserves, calls a fake Anthropic upstream
 * with the real key, and settles. Required in CI; skipped without Docker.
 */
const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
if (process.env.CI && !dockerAvailable) throw new Error("Docker is required for the model route tests in CI");

const KEY = "sk-the-real-key-only-the-control-plane-holds";
const TOKEN = `tok_${crypto.randomUUID().replaceAll("-", "")}`;
const sse = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

describe.skipIf(!dockerAvailable)("a model call from omp in a sandbox", () => {
	const received: { path: string; headers: Record<string, string>; body: string }[] = [];
	let upstream: ReturnType<typeof Bun.serve>;
	let proxy: ModelProxy;
	let network: TaskNetwork | undefined;
	let log: EventLog;
	let dir: string;
	let stateDir: string | undefined;
	let sandboxImage: string;
	let model: string;
	let counter = 0;

	async function runIn(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
		if (!network) throw new Error("no task network");
		counter += 1;
		const proc = startSandbox(sandboxImage, {
			taskId: `route-${process.pid}-${counter}`,
			laneId: "lane-0001",
			repo: "tsontario/straight-facts",
			network: network.name,
			workspace: dir,
			command: ["sh", "-c", script],
		});
		proc.stdin.end();
		const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
		return { code, stdout, stderr };
	}

	beforeAll(async () => {
		upstream = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			async fetch(request) {
				const path = new URL(request.url).pathname;
				const body = await request.text();
				received.push({ path, headers: Object.fromEntries(request.headers), body });
				if (path === "/v1/messages/count_tokens") return Response.json({ input_tokens: 2000 });
				const requested = (JSON.parse(body) as { model: string }).model;
				const usage = { input_tokens: 1800, output_tokens: 3, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
				return new Response(
					sse("message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: requested, content: [], usage } }) +
						sse("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }) +
						sse("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello from upstream" } }) +
						sse("content_block_stop", { type: "content_block_stop", index: 0 }) +
						sse("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } }) +
						sse("message_stop", { type: "message_stop" }),
					{ headers: { "content-type": "text/event-stream" } },
				);
			},
		});
		const policy = await loadPricePolicy();
		// The first model in the real policy (omp knows each), so no model id is written into source (L-0018).
		model = [...policy.models.keys()][0] ?? "";
		dir = mkdtempSync(join(tmpdir(), "sf-route-"));
		log = EventLog.open(join(dir, "events.sqlite"));
		stateDir = mkdtempSync(join(tmpdir(), "sf-route-state-"));
		const haltDir = join(stateDir, "halt");
		await writeHaltFile({ log, approvers: new Set(), haltDir });
		const large = { nanoUsd: 1_000_000_000_000, tokens: 1_000_000_000 };
		proxy = ModelProxy.start({
			policy: { ...policy, upstream: `http://127.0.0.1:${upstream.port}` },
			log,
			approvers: new Set(["@approver"]),
			key: KEY,
			factoryBudget: large,
			laneBudgets: new Map([["lane-0001", large]]),
			// Docker Desktop reaches the host's loopback; on Linux the gateway reaches the host's bridge address.
			hostname: process.platform === "darwin" ? "127.0.0.1" : "0.0.0.0",
			port: 0,
		});
		proxy.registerTask({ token: TOKEN, task: "route-task", lane: "lane-0001", repo: "tsontario/straight-facts", budget: large });
		sandboxImage = await buildImage("sandbox");
		network = await startTaskNetwork(await buildImage("gateway"), {
			taskId: `route-${process.pid}`,
			laneId: "lane-0001",
			repo: "tsontario/straight-facts",
			profile: { name: "none", hosts: [], methods: [], readOnly: [] },
			haltDir,
			model: { proxy: `http://host.docker.internal:${proxy.port}`, token: TOKEN },
		});
	}, 600_000);

	afterAll(async () => {
		await network?.stop();
		proxy?.stop();
		upstream?.stop(true);
		log?.close();
		if (dir) rmSync(dir, { recursive: true, force: true });
		if (stateDir) rmSync(stateDir, { recursive: true, force: true });
	});

	test("reaches the model with the real key, never the sandbox's, and is reserved and settled", async () => {
		const result = await runIn(
			`ANTHROPIC_BASE_URL=http://gateway:4080 ANTHROPIC_API_KEY=placeholder omp -p "Say hi" --model anthropic/${model} --no-session --no-lsp`,
		);
		expect({ stdout: result.stdout, stderr: result.stderr.slice(-1500), code: result.code }).toMatchObject({ stdout: expect.stringContaining("hello from upstream") });
		const call = received.find(request => request.path === "/v1/messages");
		expect([call?.headers["x-api-key"], call?.headers.authorization, call?.headers[TASK_TOKEN_HEADER]]).toEqual([KEY, undefined, undefined]);
		const events = [...log.read()];
		const settled = events.find(event => event.type === "model.call");
		expect(events.some(event => event.type === "model.reserved" && event.task === "route-task")).toBe(true);
		expect(isRecord(settled?.payload) ? settled.payload : {}).toMatchObject({ model, settled: "usage", status: 200 });
	}, 120_000);

	test("serves only the two model paths, and count_tokens at most once a second", async () => {
		writeFileSync(
			join(dir, "probe.mjs"),
			`
const post = path => fetch("http://gateway:4080" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: ${JSON.stringify(model)}, messages: [{ role: "user", content: "hi" }] }) }).then(r => r.status);
console.log(JSON.stringify({
	models: await fetch("http://gateway:4080/v1/models").then(r => r.status),
	batches: await post("/v1/messages/batches"),
	// Two at once: the gateway lets one through and limits the other, whatever the round trip takes.
	counts: (await Promise.all([post("/v1/messages/count_tokens"), post("/v1/messages/count_tokens")])).sort(),
}));`,
		);
		const result = await runIn("bun /workspace/probe.mjs");
		expect(JSON.parse(result.stdout)).toEqual({ models: 404, batches: 404, counts: [200, 429] });
		// The gateway refuses other paths itself; the proxy behind it would too, so check the gateway's log.
		const decisions = ((await network?.logs()) ?? "").split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as Record<string, unknown>);
		expect(decisions).toContainEqual(expect.objectContaining({ kind: "model", path: "/v1/models", decision: "refused" }));
		expect(decisions).toContainEqual(expect.objectContaining({ kind: "model", path: "/v1/messages/batches", decision: "refused" }));
	}, 60_000);
});
