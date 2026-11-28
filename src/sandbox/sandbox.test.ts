import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSandboxImage, loadSandboxImages } from "./image";
import { DEFAULT_LIMITS, SandboxError, sandboxRunArgs, startSandbox, type SandboxSpec } from "./sandbox";

/**
 * These tests run real containers. In CI they are required (decision 0002,
 * step 1); on a machine without Docker they are skipped, never silently in CI.
 */
const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
if (process.env.CI && !dockerAvailable) throw new Error("Docker is required for the sandbox tests in CI");

let image: string;
let workspace: string;
let counter = 0;

function spec(command: string[]): SandboxSpec {
	counter += 1;
	return { taskId: `test-${process.pid}-${counter}`, laneId: "lane-0001", repo: "tsontario/straight-facts", workspace, command };
}

async function runIn(command: string[], env?: Record<string, string>): Promise<{ code: number; stdout: string }> {
	const saved = { ...process.env };
	Object.assign(process.env, env);
	try {
		const proc = startSandbox(image, spec(command));
		proc.stdin.end();
		const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return { code, stdout: stdout.trim() };
	} finally {
		for (const key of Object.keys(env ?? {})) {
			if (key in saved) process.env[key] = saved[key];
			else delete process.env[key];
		}
	}
}

describe("sandboxRunArgs", () => {
	test("refuses specs that could escape their mount or label", () => {
		const good: SandboxSpec = { taskId: "t-1", laneId: "lane-0001", repo: "a/b", workspace: "/tmp/w", command: ["true"] };
		expect(() => sandboxRunArgs("img", { ...good, workspace: "relative/w" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", { ...good, workspace: "/tmp/w,target=/etc" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", { ...good, taskId: "T 1" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", { ...good, repo: "a/b/c" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", { ...good, command: [] })).toThrow(SandboxError);
	});
});

describe.skipIf(!dockerAvailable)("a running sandbox", () => {
	beforeAll(async () => {
		image = await buildSandboxImage();
		workspace = mkdtempSync(join(tmpdir(), "sf-ws-"));
	}, 600_000);

	afterAll(() => {
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	});

	test("cannot reach the network or resolve names", async () => {
		const result = await runIn([
			"sh",
			"-c",
			"getent hosts example.com >/dev/null && echo resolved; bun -e \"try { await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(3000) }); console.log('reached') } catch { console.log('blocked') }\"",
		]);
		expect(result.stdout).toBe("blocked");
	}, 30_000);

	test("has a read-only root; only /tmp and the workspace are writable", async () => {
		// /home/bun belongs to the sandbox user, so only the read-only root stops writes there.
		const result = await runIn([
			"sh",
			"-c",
			"touch /home/bun/x 2>/dev/null && echo home; touch /usr/local/x 2>/dev/null && echo usr; touch /tmp/x && echo tmp; touch /workspace/written && echo workspace",
		]);
		expect(result.stdout.split("\n")).toEqual(["tmp", "workspace"]);
		expect(existsSync(join(workspace, "written"))).toBe(true);
	}, 30_000);

	test("runs as an unprivileged user with no capabilities and no privilege escalation", async () => {
		const result = await runIn(["sh", "-c", "id -u; grep -E '^(CapEff|CapPrm|CapBnd|NoNewPrivs):' /proc/self/status"]);
		const [uid, ...status] = result.stdout.split("\n");
		expect(uid).toBe("1000");
		// An empty bounding set means not even a setuid binary could regain a capability.
		expect(status.map(line => line.replace(/\s+/g, " "))).toEqual([
			"CapPrm: 0000000000000000",
			"CapEff: 0000000000000000",
			"CapBnd: 0000000000000000",
			"NoNewPrivs: 1",
		]);
	}, 30_000);

	test("is held to its memory, CPU and process limits", async () => {
		const result = await runIn(["cat", "/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/cpu.max", "/sys/fs/cgroup/pids.max"]);
		const cpuPeriod = 100_000;
		expect(result.stdout.split("\n")).toEqual([
			String(4 * 1024 ** 3),
			`${DEFAULT_LIMITS.cpus * cpuPeriod} ${cpuPeriod}`,
			String(DEFAULT_LIMITS.pids),
		]);
	}, 30_000);

	test("mounts nothing from the host except the workspace", async () => {
		const result = await runIn(["cat", "/proc/self/mountinfo"]);
		const mountPoints = result.stdout.split("\n").map(line => line.split(" ")[4] ?? "");
		// Docker always provides these three files; everything else is kernel filesystems.
		const allowed = new Set(["/", "/tmp", "/workspace", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf"]);
		const unexpected = mountPoints.filter(point => !allowed.has(point) && !/^\/(proc|dev|sys)(\/|$)/.test(point));
		expect(unexpected).toEqual([]);
		expect(mountPoints).toContain("/workspace");
	}, 30_000);

	test("receives none of the control plane's environment", async () => {
		const secret = `sk-ant-fake-${process.pid}`;
		const result = await runIn(["env"], { ANTHROPIC_API_KEY: secret, GH_TOKEN: secret, AWS_SECRET_ACCESS_KEY: secret });
		const keys = result.stdout.split("\n").map(line => line.split("=")[0]).sort();
		expect(result.stdout).not.toContain(secret);
		expect(keys).toEqual(["BUN_INSTALL_BIN", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "HOME", "HOSTNAME", "PATH", "PWD"]);
	}, 30_000);

	test("contains the pinned omp release", async () => {
		const result = await runIn(["omp", "--version"]);
		const { build } = await loadSandboxImages();
		expect(result.stdout).toContain(build.ompVersion);
	}, 30_000);
});
