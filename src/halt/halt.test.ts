import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadApprovers } from "../control-plane/roster";
import { EventLog } from "../event-log/event-log";
import { TASK_TOKEN_HEADER } from "../gateway/endpoints";
import { HALT_FILE_NAME } from "../gateway/halt";
import { buildImage } from "../images/images";
import { loadPricePolicy } from "../model-proxy/policy";
import { ModelProxy } from "../model-proxy/proxy";
import { startTaskNetwork, type TaskNetwork } from "../sandbox/network";
import { startSandbox } from "../sandbox/sandbox";
import { isRecord } from "../util/guards";
import { HaltError, HaltState, liftHalt, parseScope, raiseHalt, writeHaltFile } from "./halt";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
if (process.env.CI && !dockerAvailable) throw new Error("Docker is required for the halt tests in CI");

const approvers: ReadonlySet<string> = new Set(["@approver"]);

describe("the halt's record", () => {
	let dir: string;
	let log: EventLog;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "sf-halt-"));
		log = EventLog.open(join(dir, "events.sqlite"));
	});

	afterEach(() => {
		log.close();
		rmSync(dir, { recursive: true, force: true });
	});

	test("accepts only the factory, a lane, or a repository as a scope", () => {
		const accepted = ["factory", "lane:lane-0001", "repo:tsontario/straight-facts"];
		const rejected = ["", "Factory", "factory ", "lane:", "lane:Lane-1", "lane:-x", "lane:a,b", "repo:straight-facts", "repo:a/b/c", "repo:a/b\n", "task:t-1", "lane:a\nfactory"];
		expect(accepted.map(parseScope)).toEqual(accepted);
		expect(parseScope("repo:TSontario/Straight-Facts")).toBe("repo:tsontario/straight-facts");
		const parsed = rejected.filter(scope => {
			try {
				parseScope(scope);
				return true;
			} catch (error) {
				if (error instanceof HaltError) return false;
				throw error;
			}
		});
		expect(parsed).toEqual([]);
	});

	test("replays halts from the log as other processes append them, and honors a lift only from an approver", () => {
		const state = new HaltState(log, approvers);
		const other = EventLog.open(join(dir, "events.sqlite"));
		const raise = (scope: string, actor: string): unknown => other.append({ type: "halt.raised", actor, payload: { scope, reason: "test" } });
		const lift = (scope: string, actor: string): unknown => other.append({ type: "halt.lifted", actor, payload: { scope } });
		try {
			raise("lane:lane-0001", "control-plane");
			raise("repo:a/b", "@approver");
			expect(state.refresh().scopes).toEqual(["lane:lane-0001", "repo:a/b"]);
			lift("lane:lane-0001", "@someone");
			lift("lane:lane-0001", "control-plane");
			other.append({ type: "halt.lifted", actor: "@approver", payload: { scope: 1 } });
			expect(state.refresh().scopes).toEqual(["lane:lane-0001", "repo:a/b"]);
			lift("lane:lane-0001", "@approver");
			expect(state.refresh().scopes).toEqual(["repo:a/b"]);
			expect([state.covers({ lane: "lane-0001", repo: "a/c" }), state.covers({ lane: "lane-0002", repo: "a/b" })]).toEqual([false, true]);
			raise("lane:lane-0001", "@approver");
			expect(state.refresh().scopes).toEqual(["lane:lane-0001", "repo:a/b"]);
			expect(new HaltState(log, approvers).refresh().scopes).toEqual(["lane:lane-0001", "repo:a/b"]);
		} finally {
			other.close();
		}
	});

	test("rewrites the halt file from the log, readable by the gateway's user, and restores it if deleted", async () => {
		const haltDir = join(dir, "halt");
		const file = join(haltDir, HALT_FILE_NAME);
		log.append({ type: "halt.raised", actor: "@approver", payload: { scope: "factory", reason: "test" } });
		// Readable by the gateway's user even under the strictest umask.
		const umask = process.umask(0o077);
		try {
			expect(await writeHaltFile({ log, approvers, haltDir })).toEqual(["factory"]);
		} finally {
			process.umask(umask);
		}
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ scopes: ["factory"] });
		expect([statSync(haltDir).mode & 0o777, statSync(file).mode & 0o777]).toEqual([0o755, 0o644]);
		rmSync(file);
		log.append({ type: "halt.lifted", actor: "@approver", payload: { scope: "factory" } });
		expect(await writeHaltFile({ log, approvers, haltDir })).toEqual([]);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ scopes: [] });
		expect(readdirSync(haltDir)).toEqual([HALT_FILE_NAME]);
	});

	test("only an approver or the control plane raises a halt, and only an approver lifts one", async () => {
		const options = { log, approvers, haltDir: join(dir, "halt") };
		const refusals = [
			raiseHalt(options, "lane:lane-0001", "@someone", "test"),
			raiseHalt(options, "lane 1", "@approver", "test"),
			liftHalt(options, "lane:lane-0001", "control-plane"),
			liftHalt(options, "lane:lane-0001", "@someone"),
			liftHalt(options, "lane 1", "@approver"),
		];
		for (const refusal of refusals) await expect(refusal).rejects.toThrow(HaltError);
		expect([...log.read()]).toEqual([]);
	});

	test("an approver's lift of a repository halt matches it in any case", async () => {
		const options = { log, approvers, haltDir: join(dir, "halt") };
		log.append({ type: "halt.raised", actor: "@approver", payload: { scope: "repo:tsontario/straight-facts", reason: "test" } });
		await liftHalt(options, "repo:TSontario/Straight-Facts", "@approver");
		expect(JSON.parse(readFileSync(join(options.haltDir, HALT_FILE_NAME), "utf8"))).toEqual({ scopes: [] });
	});
});

describe.skipIf(!dockerAvailable)("a halt, end to end", () => {
	const pid = process.pid;
	let sandboxImage: string;
	let gatewayImage: string;
	let stateDir: string | undefined;
	let workspace: string | undefined;
	let log: EventLog | undefined;
	let options: { log: EventLog; approvers: ReadonlySet<string>; haltDir: string };
	let approver: string;
	const networks: TaskNetwork[] = [];
	/** Sandboxes that ignore SIGTERM outlive a failed test unless removed by name. */
	const sandboxes: string[] = [];
	/** The control plane's model proxy, on the same log, in front of an upstream that must never be reached once halted. */
	let proxy: ModelProxy | undefined;
	let upstream: ReturnType<typeof Bun.serve> | undefined;
	let upstreamCalls = 0;
	let model: string;
	const large = { nanoUsd: 1_000_000_000_000, tokens: 1_000_000_000 };

	beforeAll(async () => {
		[sandboxImage, gatewayImage] = await Promise.all([buildImage("sandbox"), buildImage("gateway")]);
		stateDir = mkdtempSync(join(tmpdir(), "sf-halt-state-"));
		workspace = mkdtempSync(join(tmpdir(), "sf-halt-ws-"));
		log = EventLog.open(join(stateDir, "events.sqlite"));
		// The real roster, as the halt command loads it.
		const roster = await loadApprovers();
		approver = [...roster][0] ?? "";
		options = { log, approvers: roster, haltDir: join(stateDir, "halt") };
		await writeHaltFile(options);
		upstream = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => {
				upstreamCalls += 1;
				return new Response("{}", { status: 500 });
			},
		});
		const policy = await loadPricePolicy();
		model = [...policy.models.keys()][0] ?? "";
		proxy = ModelProxy.start({
			policy: { ...policy, upstream: `http://127.0.0.1:${upstream.port}` },
			log,
			approvers: roster,
			key: "unused",
			factoryBudget: large,
			laneBudgets: new Map([[`halt-a-${pid}`, large]]),
			hostname: "127.0.0.1",
			port: 0,
		});
	}, 600_000);

	afterAll(async () => {
		if (sandboxes.length > 0) Bun.spawnSync(["docker", "rm", "--force", ...sandboxes], { stdout: "ignore", stderr: "ignore" });
		proxy?.stop();
		upstream?.stop(true);
		for (const network of networks) await network.stop();
		log?.close();
		if (stateDir) rmSync(stateDir, { recursive: true, force: true });
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	});

	async function taskNetwork(taskId: string, laneId: string, repo: string): Promise<TaskNetwork> {
		const network = await startTaskNetwork(gatewayImage, {
			taskId,
			laneId,
			repo,
			profile: { name: "test", hosts: [], methods: [], readOnly: ["registry.npmjs.org"] },
			haltDir: options.haltDir,
			// Nothing listens there: the halt and the route's own refusals answer before it is reached.
			model: { proxy: "http://host.docker.internal:9", token: "t".repeat(40) },
		});
		networks.push(network);
		return network;
	}

	/** What the gateway's forward proxy, npm endpoint and model route answer, asked from inside the gateway. */
	function answers(gateway: string): unknown {
		const script = [
			"const status = (url, init) => fetch(url, init).then(response => response.status, () => 0);",
			"console.log(JSON.stringify({",
			'proxy: await status("http://example.com/", { proxy: "http://127.0.0.1:3128" }),',
			'npm: await status("http://127.0.0.1:4873/left-pad", { method: "POST", body: "x" }),',
			'model: await status("http://127.0.0.1:4080/v1/models"),',
			"}));",
		].join(" ");
		const exec = Bun.spawnSync(["docker", "exec", gateway, "/usr/local/bin/bun", "-e", script]);
		return JSON.parse(exec.stdout.toString() || "null");
	}

	const containerId = (name: string): string => Bun.spawnSync(["docker", "inspect", "--format", "{{.Id}}", name]).stdout.toString().trim();

	/** A model call through the proxy, as the task's gateway would make it. */
	const callModel = (token: string): Promise<number> =>
		fetch(`http://127.0.0.1:${proxy?.port}/v1/messages`, {
			method: "POST",
			headers: { "content-type": "application/json", [TASK_TOKEN_HEADER]: token },
			body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] }),
		}).then(response => response.status);

	/** Starts a sandbox that ignores SIGTERM, and resolves once its loop runs. */
	async function stubborn(taskId: string, laneId: string, repo: string, network: string): Promise<Bun.Subprocess<"pipe", "pipe", "pipe">> {
		sandboxes.push(`sf-sandbox-${taskId}`);
		const proc = startSandbox(sandboxImage, {
			taskId,
			laneId,
			repo,
			network,
			workspace: workspace ?? "",
			command: ["sh", "-c", 'trap "" TERM; echo ready; while true; do sleep 1; done'],
		});
		proc.stdin.end();
		const reader = proc.stdout.getReader();
		const { value } = await reader.read();
		reader.releaseLock();
		if (!new TextDecoder().decode(value).includes("ready")) throw new Error(`sandbox ${taskId} did not start: ${await new Response(proc.stderr).text()}`);
		return proc;
	}

	/** Each server's own refusal under the test profile, which allows no method and no host. */
	const unhalted = { proxy: 405, npm: 405, model: 404 };

	test("kills every container in the halted scope at once, even one that ignores SIGTERM, and nothing outside it", async () => {
		const [laneA, repoA, laneB, repoB] = [`halt-a-${pid}`, `halt-test/a-${pid}`, `halt-b-${pid}`, `halt-test/b-${pid}`];
		const network = await taskNetwork(`halt-a-${pid}`, laneA, repoA);
		expect(answers(network.gateway)).toEqual(unhalted);
		// Both on the same task network; only their labels put them in different scopes.
		const inA = await stubborn(`halt-a-${pid}-1`, laneA, repoA, network.name);
		const inB = await stubborn(`halt-b-${pid}-1`, laneB, repoB, network.name);
		// Created in lane A but never started: it must not be able to start after the halt.
		const created = Bun.spawnSync(["docker", "create", "--label", `straight-facts.task=halt-a-${pid}-2`, "--label", `straight-facts.lane=${laneA}`, sandboxImage, "true"]);
		const createdId = created.stdout.toString().trim();
		sandboxes.push(createdId);
		const expected = [containerId(`sf-sandbox-halt-a-${pid}-1`), containerId(network.gateway), createdId].sort();
		const token = `tok_${crypto.randomUUID().replaceAll("-", "")}`;
		proxy?.registerTask({ token, task: `halt-a-${pid}-1`, lane: laneA, repo: repoA, budget: large });
		// Before the halt the proxy counts the call at the upstream, which fails it.
		expect([await callModel(token), upstreamCalls]).toEqual([502, 1]);
		const started = performance.now();
		const { killed } = await raiseHalt(options, `lane:${laneA}`, approver, "x".repeat(600));
		expect(performance.now() - started).toBeLessThan(60_000);
		expect([...killed].sort()).toEqual(expected);
		expect(await inA.exited).toBe(137);
		expect(Bun.spawnSync(["docker", "container", "inspect", createdId], { stdout: "ignore", stderr: "ignore" }).exitCode).not.toBe(0);
		expect([await callModel(token), upstreamCalls]).toEqual([503, 1]);
		expect(Bun.spawnSync(["docker", "inspect", "--format", "{{.State.Running}}", `sf-sandbox-halt-b-${pid}-1`]).stdout.toString().trim()).toBe("true");
		const raised = [...(log?.read() ?? [])].find(event => event.type === "halt.raised");
		expect([raised?.actor, isRecord(raised?.payload) ? raised.payload.scope : undefined, isRecord(raised?.payload) ? String(raised.payload.reason).length : 0]).toEqual([
			approver,
			`lane:${laneA}`,
			500,
		]);
		const sandboxB = containerId(`sf-sandbox-halt-b-${pid}-1`);
		expect((await raiseHalt(options, `repo:${repoB.toUpperCase()}`, "control-plane", "test")).killed).toEqual([sandboxB]);
		expect(await inB.exited).toBe(137);
		expect(JSON.parse(readFileSync(join(options.haltDir, HALT_FILE_NAME), "utf8")).scopes).toContain(`repo:${repoB}`);
	}, 180_000);

	test("kills the scope even when the halt file can't be written, then reports it", async () => {
		const lane = `halt-d-${pid}`;
		const network = await taskNetwork(`halt-d-${pid}`, lane, `halt-test/d-${pid}`);
		const inD = await stubborn(`halt-d-${pid}-1`, lane, `halt-test/d-${pid}`, network.name);
		const notADirectory = join(stateDir ?? "", "not-a-directory");
		writeFileSync(notADirectory, "");
		await expect(raiseHalt({ ...options, haltDir: notADirectory }, `lane:${lane}`, approver, "test")).rejects.toThrow(/2 container\(s\) killed, but the halt file was not written/);
		expect(await inD.exited).toBe(137);
	}, 180_000);

	test("reports both failures when neither the kill nor the halt file can be done", async () => {
		const notADirectory = join(stateDir ?? "", "not-a-directory-either");
		writeFileSync(notADirectory, "");
		// The docker client can't reach any daemon at this socket, so `docker ps` fails.
		const saved = process.env.DOCKER_HOST;
		process.env.DOCKER_HOST = `unix://${join(stateDir ?? "", "no-docker.sock")}`;
		try {
			await expect(raiseHalt({ ...options, haltDir: notADirectory }, `lane:halt-e-${pid}`, approver, "test")).rejects.toThrow(
				/^docker ps failed \(exit \d+\): .*; and the halt file was not written: /s,
			);
		} finally {
			if (saved === undefined) delete process.env.DOCKER_HOST;
			else process.env.DOCKER_HOST = saved;
		}
	});

	test("a gateway in a halted scope refuses everything until an approver lifts the halt; deleting the halt file lifts nothing", async () => {
		const lane = `halt-c-${pid}`;
		const repo = `halt-test/c-${pid}`;
		const scope = `lane:${lane}`;
		expect((await raiseHalt(options, scope, "control-plane", "test")).killed).toEqual([]);
		const network = await taskNetwork(`halt-c-${pid}`, lane, repo);
		// The gateway can't rewrite the halt file it reads, on Docker Desktop or Linux.
		const write = 'try { require("fs").writeFileSync("/etc/straight-facts/halt/halt.json", "{\\"scopes\\":[]}"); console.log("written") } catch (error) { console.log(error.code) }';
		expect(Bun.spawnSync(["docker", "exec", network.gateway, "/usr/local/bin/bun", "-e", write]).stdout.toString().trim()).toBe("EROFS");
		const halted = { proxy: 503, npm: 503, model: 503 };
		expect(answers(network.gateway)).toEqual(halted);
		rmSync(join(options.haltDir, HALT_FILE_NAME));
		expect(answers(network.gateway)).toEqual(halted);
		await expect(liftHalt(options, scope, "@not-an-approver")).rejects.toThrow(HaltError);
		expect(answers(network.gateway)).toEqual(halted);
		await liftHalt(options, scope, approver);
		expect(answers(network.gateway)).toEqual(unhalted);
		// The gateway checks its repository too. Written straight to the file, the halt kills nothing.
		writeFileSync(join(options.haltDir, HALT_FILE_NAME), JSON.stringify({ scopes: [`repo:${repo}`] }));
		expect(answers(network.gateway)).toEqual(halted);
		await writeHaltFile(options);
		expect(answers(network.gateway)).toEqual(unhalted);
		const decisions = (await network.logs()).split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as Record<string, unknown>);
		expect(decisions.filter(decision => decision.decision === "refused" && decision.reason === "halted").length).toBe(12);
	}, 180_000);
});
