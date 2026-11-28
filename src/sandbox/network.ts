import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import { CONFIG_PATH, type GatewayConfig, type GatewayProfile } from "../gateway/config";
import { GATEWAY_HOST } from "../gateway/endpoints";
import { HALT_MOUNT } from "../gateway/halt";
import { IMAGE, LABELS, SandboxError, clearedProxyEnv, dockerClientEnv, validateTask } from "./sandbox";

/**
 * A task's network (decision 0002 §2). Two Docker networks and one gateway:
 *
 * - the task network, created `--internal`, so nothing on it has a route out;
 *   the sandbox joins only this one;
 * - an egress network, a bridge that only this task's gateway joins;
 * - the gateway, on both, reachable on the task network as `gateway`. It reads
 *   the task and its network profile from a read-only mount and forwards only
 *   what the profile allows.
 *
 * Every container and network carries the task's labels, so a halt finds them.
 */

export interface TaskNetworkSpec {
	readonly taskId: string;
	readonly laneId: string;
	readonly repo: string;
	readonly profile: GatewayProfile;
	/** The halt file's directory (decision 0002 §4), which the gateway mounts read-only. */
	readonly haltDir: string;
	/** The control plane's model proxy, as the gateway reaches it, and this task's token for it. */
	readonly model?: NonNullable<GatewayConfig["model"]>;
}

export interface TaskNetwork {
	/** The internal network a sandbox joins. */
	readonly name: string;
	/** The gateway container's name. */
	readonly gateway: string;
	/** The gateway's decision log so far, one JSON line per decision. */
	logs(): Promise<string>;
	/** Removes the gateway, both networks and the gateway's config. */
	stop(): Promise<void>;
}

/** The uid:gid the gateway runs as: distroless's unprivileged `nonroot`. */
const GATEWAY_USER = "65532:65532";
const START_TIMEOUT_MS = 30_000;

export async function startTaskNetwork(gatewayImage: string, spec: TaskNetworkSpec): Promise<TaskNetwork> {
	if (!IMAGE.test(gatewayImage)) throw new SandboxError(`invalid image reference: ${JSON.stringify(gatewayImage)}`);
	validateTask(spec);
	if (!isAbsolute(spec.haltDir) || normalize(spec.haltDir) !== spec.haltDir || /[,\n]/.test(spec.haltDir)) {
		throw new SandboxError(`haltDir must be a normalized absolute path without commas or newlines: ${JSON.stringify(spec.haltDir)}`);
	}
	const name = `sf-task-${spec.taskId}`;
	const egress = `sf-egress-${spec.taskId}`;
	// Sandboxes are sf-sandbox-<task>, so no task's gateway name can be another task's sandbox.
	const gateway = `sf-gateway-${spec.taskId}`;
	const labels = [
		"--label",
		`${LABELS.task}=${spec.taskId}`,
		"--label",
		`${LABELS.lane}=${spec.laneId}`,
		"--label",
		`${LABELS.repo}=${spec.repo}`,
	];
	const configDir = await mkdtemp(join(tmpdir(), "sf-gateway-"));
	const configFile = join(configDir, "gateway.json");
	const config: GatewayConfig = { task: spec.taskId, lane: spec.laneId, repo: spec.repo, profile: spec.profile, model: spec.model };
	await writeFile(configFile, JSON.stringify(config));
	// The gateway runs as another uid and must be able to read its config, though not write it.
	await chmod(configDir, 0o755);
	await chmod(configFile, 0o644);

	// What this call created, by ID, so cleaning up after a failure never touches another
	// task's containers or networks, even if a name was already taken.
	const created: { networks: string[]; container: string | undefined } = { networks: [], container: undefined };
	const stop = async (): Promise<void> => {
		if (created.container) await docker(["rm", "--force", created.container]).catch(() => {});
		for (const id of [...created.networks].reverse()) await docker(["network", "rm", id]).catch(() => {});
		await rm(configDir, { recursive: true, force: true });
	};
	try {
		created.networks.push((await docker(["network", "create", "--internal", ...labels, name])).trim());
		created.networks.push((await docker(["network", "create", ...labels, egress])).trim());
		created.container = (
			await docker([
				"create",
				"--name",
				gateway,
				"--network",
				egress,
				"--read-only",
				// The model route reaches the control plane's model proxy on the Docker host.
				"--add-host",
				"host.docker.internal:host-gateway",
				"--tmpfs",
				"/tmp:rw,nosuid,nodev,noexec,size=16m",
				"--user",
				GATEWAY_USER,
				"--cap-drop",
				"ALL",
				"--security-opt",
				"no-new-privileges",
				"--ipc",
				"private",
				"--pids-limit",
				"256",
				"--memory",
				"512m",
				"--memory-swap",
				"512m",
				"--cpus",
				"1",
				// The decision log is bounded, so a sandbox flooding the gateway can't fill the disk.
				"--log-driver",
				"json-file",
				"--log-opt",
				"max-size=16m",
				"--log-opt",
				"max-file=4",
				...clearedProxyEnv(),
				"--mount",
				`type=bind,source=${configFile},target=${CONFIG_PATH},readonly`,
				"--mount",
				`type=bind,source=${spec.haltDir},target=${HALT_MOUNT},readonly`,
				...labels,
				"--label",
				"straight-facts.role=gateway",
				gatewayImage,
			])
		).trim();
		await docker(["network", "connect", "--alias", GATEWAY_HOST, name, created.container]);
		await docker(["start", created.container]);
		await waitForStart(created.container);
	} catch (error) {
		await stop();
		throw error;
	}
	const container = created.container;
	return { name, gateway, logs: () => docker(["logs", container]), stop };
}

/** Waits for the gateway's `gateway.started` log line, which it writes once it is listening. */
async function waitForStart(gateway: string): Promise<void> {
	const follow = Bun.spawn(["docker", "logs", "--follow", gateway], { stdout: "pipe", stderr: "pipe", env: dockerClientEnv() });
	const timer = setTimeout(() => follow.kill(), START_TIMEOUT_MS);
	let seen = "";
	try {
		for await (const chunk of follow.stdout.pipeThrough(new TextDecoderStream())) {
			seen += chunk;
			if (seen.includes('"event":"gateway.started"')) return;
		}
		const stderr = await new Response(follow.stderr).text();
		throw new SandboxError(`gateway ${gateway} did not start: ${(seen + stderr).trim().slice(-2000)}`);
	} finally {
		clearTimeout(timer);
		follow.kill();
	}
}

async function docker(args: string[]): Promise<string> {
	const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", env: dockerClientEnv() });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new SandboxError(`docker ${args[0]} failed (exit ${code}): ${stderr.trim()}`);
	return stdout;
}
