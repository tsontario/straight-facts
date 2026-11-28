import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/** Runs a command in a fresh sandbox, with `env` added to the control plane's environment meanwhile. */
async function runIn(command: string[], env: Record<string, string> = {}): Promise<string> {
	const saved = { ...process.env };
	Object.assign(process.env, env);
	try {
		const proc = startSandbox(image, spec(command));
		proc.stdin.end();
		const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return stdout.trim();
	} finally {
		for (const key of Object.keys(env)) {
			if (key in saved) process.env[key] = saved[key];
			else delete process.env[key];
		}
	}
}

function bytes(size: string): number {
	const units: Record<string, number> = { k: 1024, m: 1024 ** 2, g: 1024 ** 3 };
	return Number.parseInt(size, 10) * (units[size.slice(-1)] ?? 1);
}

describe("sandboxRunArgs", () => {
	test("refuses specs and limits that could add docker flags, mounts or labels", () => {
		const good: SandboxSpec = { taskId: "t-1", laneId: "lane-0001", repo: "a/b", workspace: "/tmp/w", command: ["true"] };
		expect(() => sandboxRunArgs("--privileged", good)).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", { ...good, workspace: "relative/w" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", { ...good, workspace: "/tmp/w/../../etc" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", { ...good, workspace: "/tmp/w,target=/etc" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", { ...good, taskId: "T 1" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", { ...good, repo: "a/b/c" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", { ...good, command: [] })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", good, { ...DEFAULT_LIMITS, tmpfsSize: "1g,exec,suid" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", good, { ...DEFAULT_LIMITS, memory: "4g --privileged" })).toThrow(SandboxError);
		expect(() => sandboxRunArgs("img", good, { ...DEFAULT_LIMITS, cpus: Number.POSITIVE_INFINITY })).toThrow(SandboxError);
	});

	test("refuses to run a sandbox as root", () => {
		const good: SandboxSpec = { taskId: "t-1", laneId: "lane-0001", repo: "a/b", workspace: "/tmp/w", command: ["true"] };
		const getuid = spyOn(process, "getuid").mockReturnValue(0);
		try {
			expect(() => sandboxRunArgs("img", good)).toThrow(SandboxError);
		} finally {
			getuid.mockRestore();
		}
	});
});

describe.skipIf(!dockerAvailable)("a running sandbox", () => {
	let dockerHost: string;

	beforeAll(async () => {
		image = await buildSandboxImage();
		workspace = mkdtempSync(join(tmpdir(), "sf-ws-"));
		dockerHost =
			process.env.DOCKER_HOST ??
			Bun.spawnSync(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]).stdout.toString().trim();
	}, 600_000);

	afterAll(() => {
		if (workspace) rmSync(workspace, { recursive: true, force: true });
	});

	test("cannot reach the network or resolve names", async () => {
		const out = await runIn([
			"sh",
			"-c",
			"getent hosts example.com >/dev/null && echo resolved; bun -e \"try { await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(3000) }); console.log('reached') } catch { console.log('blocked') }\"",
		]);
		expect(out).toBe("blocked");
	}, 30_000);

	test("cannot write its root filesystem; /tmp and the workspace stay writable", async () => {
		// /var/tmp is world-writable on the root filesystem, so only the read-only root stops writes there.
		const out = await runIn([
			"sh",
			"-c",
			"touch /var/tmp/x 2>/dev/null && echo var-tmp; touch /usr/local/x 2>/dev/null && echo usr; touch /tmp/x && echo tmp; touch /workspace/written && echo workspace",
		]);
		expect(out.split("\n")).toEqual(["tmp", "workspace"]);
		// Files the task writes belong to the control plane's own user.
		expect(statSync(join(workspace, "written")).uid).toBe(process.getuid?.() ?? -1);
	}, 30_000);

	test("runs as the control plane's non-root user with no capabilities and no privilege escalation", async () => {
		const out = await runIn(["sh", "-c", "id -u; grep -E '^(CapEff|CapPrm|CapBnd|NoNewPrivs|Seccomp):' /proc/self/status"]);
		const [uid, ...status] = out.split("\n");
		expect(uid).toBe(String(process.getuid?.()));
		expect(uid).not.toBe("0");
		// An empty bounding set means not even a setuid binary could regain a capability.
		// Seccomp 2 is filter mode: Docker's default syscall filter is in force.
		expect(status.map(line => line.replace(/\s+/g, " "))).toEqual([
			"CapPrm: 0000000000000000",
			"CapEff: 0000000000000000",
			"CapBnd: 0000000000000000",
			"NoNewPrivs: 1",
			"Seccomp: 2",
		]);
	}, 30_000);

	test("is confined by AppArmor wherever the host kernel has it", async () => {
		const out = await runIn(["sh", "-c", "cat /sys/module/apparmor/parameters/enabled 2>/dev/null || echo N; cat /proc/self/attr/current 2>/dev/null"]);
		const [enabled, profile] = out.split("\n");
		// GitHub's runners are Ubuntu, which has AppArmor, so there the check can't pass vacuously.
		if (process.env.GITHUB_ACTIONS === "true") expect(enabled).toBe("Y");
		if (enabled === "Y") expect(profile).toStartWith("docker-default");
	}, 30_000);

	test("sees only its own processes, IPC and hostname", async () => {
		const out = await runIn(["sh", "-c", "tr '\\0' ' ' < /proc/1/cmdline; echo; df -k /dev/shm | tail -1 | awk '{print $2}'; hostname"]);
		const [pid1, shmKiB, hostname] = out.split("\n");
		// PID 1 is the sandbox's own command: no host processes are visible.
		expect(pid1).toStartWith("sh -c tr");
		// A private 64 MiB /dev/shm, not the host's.
		expect(shmKiB).toBe("65536");
		// Docker names a container's own UTS namespace after its id.
		expect(hostname).toMatch(/^[0-9a-f]{12}$/);
	}, 30_000);

	test("has no host devices and no host sockets", async () => {
		// A host socket can only arrive as a bind mount. Docker creates its mount point as a
		// regular file, so `find -type s` misses it; testing each mount point catches it.
		const out = await runIn([
			"sh",
			"-c",
			"find /dev \\( -type c -o -type b \\) | sort | tr '\\n' ' '; echo; awk '{print $5}' /proc/self/mountinfo | while read -r point; do [ -S \"$point\" ] && echo \"$point\"; done; true",
		]);
		const [devices, ...sockets] = out.split("\n");
		expect(devices?.trim().split(" ")).toEqual(["/dev/full", "/dev/null", "/dev/pts/ptmx", "/dev/random", "/dev/tty", "/dev/urandom", "/dev/zero"]);
		expect(sockets).toEqual([]);
	}, 30_000);

	test("is held to its memory, swap, CPU and process limits", async () => {
		const cgroup = "/sys/fs/cgroup";
		const out = await runIn(["cat", `${cgroup}/memory.max`, `${cgroup}/memory.swap.max`, `${cgroup}/cpu.max`, `${cgroup}/pids.max`]);
		const cpuPeriod = 100_000;
		expect(out.split("\n")).toEqual([
			String(bytes(DEFAULT_LIMITS.memory)),
			"0",
			`${DEFAULT_LIMITS.cpus * cpuPeriod} ${cpuPeriod}`,
			String(DEFAULT_LIMITS.pids),
		]);
	}, 30_000);

	test("mounts nothing from the host except the workspace", async () => {
		const out = await runIn(["cat", "/proc/self/mountinfo"]);
		const mounts = out.split("\n").map(line => {
			const fields = line.split(" ");
			return { point: fields[4] ?? "", type: fields[fields.indexOf("-") + 1] ?? "" };
		});
		// Docker always provides these three files.
		const allowed = new Set(["/", "/tmp", "/workspace", "/etc/hosts", "/etc/hostname", "/etc/resolv.conf"]);
		// Under /proc, /dev and /sys only kernel and memory filesystems may appear, never a host directory.
		const kernelTypes = new Set(["proc", "sysfs", "tmpfs", "devpts", "mqueue", "cgroup2"]);
		const unexpected = mounts.filter(
			({ point, type }) => !allowed.has(point) && !(/^\/(proc|dev|sys)(\/|$)/.test(point) && kernelTypes.has(type)),
		);
		expect(unexpected).toEqual([]);
		// Docker's masked and read-only kernel paths are still covered.
		expect(mounts.map(mount => mount.point)).toEqual(expect.arrayContaining(["/workspace", "/proc/kcore", "/proc/sys", "/sys/firmware"]));
	}, 30_000);

	test("receives none of the control plane's environment or the docker client's proxy settings", async () => {
		const secret = `sk-ant-fake-${process.pid}`;
		// The docker client copies `proxies` from its config into containers unless the runner stops it.
		const dockerConfig = mkdtempSync(join(tmpdir(), "sf-docker-config-"));
		const proxy = `http://user:${secret}@proxy.invalid:3128`;
		writeFileSync(join(dockerConfig, "config.json"), JSON.stringify({ proxies: { default: { httpProxy: proxy, httpsProxy: proxy, noProxy: secret } } }));
		try {
			const out = await runIn(["env"], {
				ANTHROPIC_API_KEY: secret,
				GH_TOKEN: secret,
				HTTPS_PROXY: proxy,
				DOCKER_CONFIG: dockerConfig,
				DOCKER_HOST: dockerHost,
			});
			const keys = out.split("\n").map(line => line.split("=")[0]).sort();
			expect(out).not.toContain(secret);
			expect(keys).toEqual(["BUN_INSTALL_BIN", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "HOME", "HOSTNAME", "PATH", "PWD"]);
		} finally {
			rmSync(dockerConfig, { recursive: true, force: true });
		}
	}, 30_000);

	test("contains the pinned omp release, which runs under the sandbox's restrictions", async () => {
		const version = await runIn(["omp", "--version"]);
		const { build } = await loadSandboxImages();
		expect(version).toContain(build.ompVersion);
		// `--help` loads omp's native addon, which a read-only root and a noexec /tmp would break.
		const help = await runIn(["sh", "-c", "omp --help >/dev/null && echo ran"]);
		expect(help).toBe("ran");
	}, 60_000);
});
