import { isAbsolute, normalize } from "node:path";
import { GATEWAY_HOST, PROXY_PORT } from "../gateway/endpoints";

/**
 * Runs one task in its own sandbox container (L-0024, decision 0002 §1).
 *
 * The container gets a read-only root filesystem with a tmpfs at `/tmp`, the
 * control plane's own non-root uid and gid (so it can write the workspace the
 * control plane owns, and nothing else of the host's), no capabilities, no
 * privilege escalation, resource limits, and exactly one host path: the task's
 * workspace. Its only network is the task's internal network (see network.ts),
 * where the one thing it can reach is the task's gateway. No host environment
 * reaches it, including the proxy settings the docker client would copy in from
 * its own config; it gets only `HOME` and the gateway's proxy settings. The
 * labels let a halt find and kill it.
 */

export interface SandboxSpec {
	readonly taskId: string;
	readonly laneId: string;
	/** The repository the task works on, as `owner/name`. */
	readonly repo: string;
	/** The task's internal network, from `startTaskNetwork`. */
	readonly network: string;
	/** Absolute host path of the task's workspace: the only host path mounted. */
	readonly workspace: string;
	/** The command to run inside the sandbox. */
	readonly command: readonly string[];
}

export interface SandboxLimits {
	readonly memory: string;
	readonly cpus: number;
	readonly pids: number;
	readonly tmpfsSize: string;
}

export const DEFAULT_LIMITS: SandboxLimits = { memory: "4g", cpus: 2, pids: 512, tmpfsSize: "1g" };

/** Label keys the halt uses to find a scope's containers (decision 0002 §4). */
export const LABELS = {
	sandbox: "straight-facts.sandbox",
	task: "straight-facts.task",
	lane: "straight-facts.lane",
	repo: "straight-facts.repo",
} as const;

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const TASK_NETWORK = /^sf-task-[a-z0-9][a-z0-9-]{0,62}$/;
/** An image reference; it cannot start with `-`, so it can't be read as a flag. */
export const IMAGE = /^[a-z0-9][a-z0-9._\/:@-]*$/;
const SIZE = /^[1-9]\d*[kmg]?$/;
const PROXY = `http://${GATEWAY_HOST}:${PROXY_PORT}`;
/**
 * The docker client copies `proxies` from its config file into a container's
 * environment. Setting each variable, or naming it bare with no value, overrides that.
 */
const PROXY_VARIABLES = ["HTTP_PROXY", "HTTPS_PROXY", "FTP_PROXY", "NO_PROXY", "ALL_PROXY"].flatMap(name => [name, name.toLowerCase()]);

/** `--env` arguments that leave every proxy variable unset, whatever the docker client's config says. */
export function clearedProxyEnv(): string[] {
	return PROXY_VARIABLES.flatMap(name => ["--env", name]);
}

/** `--env` arguments that send a sandbox's HTTP and HTTPS through its gateway, and reach the gateway's own endpoints directly. */
function gatewayProxyEnv(): string[] {
	const values: Record<string, string> = { HTTP_PROXY: PROXY, HTTPS_PROXY: PROXY, NO_PROXY: GATEWAY_HOST };
	return PROXY_VARIABLES.flatMap(name => {
		const value = values[name.toUpperCase()];
		return ["--env", value === undefined ? name : `${name}=${value}`];
	});
}

/** Validates the ids a task's containers and networks are named and labelled with. */
export function validateTask(task: { readonly taskId: string; readonly laneId: string; readonly repo: string }): void {
	if (!ID.test(task.taskId)) throw new SandboxError(`invalid task id: ${JSON.stringify(task.taskId)}`);
	if (!ID.test(task.laneId)) throw new SandboxError(`invalid lane id: ${JSON.stringify(task.laneId)}`);
	if (!REPO.test(task.repo)) throw new SandboxError(`invalid repository: ${JSON.stringify(task.repo)}`);
}

export class SandboxError extends Error {
	override readonly name = "SandboxError";
}

/** The `docker run` arguments for a sandbox. Validates the spec first. */
export function sandboxRunArgs(image: string, spec: SandboxSpec, limits: SandboxLimits = DEFAULT_LIMITS): string[] {
	if (!IMAGE.test(image)) throw new SandboxError(`invalid image reference: ${JSON.stringify(image)}`);
	validateTask(spec);
	if (!TASK_NETWORK.test(spec.network)) throw new SandboxError(`invalid task network: ${JSON.stringify(spec.network)}`);
	if (!isAbsolute(spec.workspace) || normalize(spec.workspace) !== spec.workspace || /[,\n]/.test(spec.workspace)) {
		throw new SandboxError(`workspace must be a normalized absolute path without commas or newlines: ${JSON.stringify(spec.workspace)}`);
	}
	if (spec.command.length === 0) throw new SandboxError("command must not be empty");
	if (!SIZE.test(limits.memory) || !SIZE.test(limits.tmpfsSize)) throw new SandboxError("memory and tmpfs limits must be sizes such as 4g");
	if (!Number.isInteger(limits.pids) || limits.pids < 1 || !Number.isFinite(limits.cpus) || limits.cpus <= 0) {
		throw new SandboxError("pids and cpus limits must be positive");
	}
	return [
		"run",
		"--rm",
		"--interactive",
		"--name",
		`sf-sandbox-${spec.taskId}`,
		// Its stdout is the RPC channel the control plane reads by attaching; nothing is stored,
		// so a session cannot fill the Docker host's disk through its log.
		"--log-driver",
		"none",
		"--network",
		spec.network,
		"--read-only",
		"--tmpfs",
		`/tmp:rw,nosuid,nodev,size=${limits.tmpfsSize}`,
		"--user",
		sandboxUser(),
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit",
		String(limits.pids),
		"--memory",
		limits.memory,
		// Equal to --memory, so the task gets no swap on top of its memory limit.
		"--memory-swap",
		limits.memory,
		"--cpus",
		String(limits.cpus),
		"--ipc",
		"private",
		"--shm-size",
		"64m",
		"--env",
		"HOME=/tmp",
		...gatewayProxyEnv(),
		"--mount",
		`type=bind,source=${spec.workspace},target=/workspace`,
		"--workdir",
		"/workspace",
		"--label",
		`${LABELS.sandbox}=true`,
		"--label",
		`${LABELS.task}=${spec.taskId}`,
		"--label",
		`${LABELS.lane}=${spec.laneId}`,
		"--label",
		`${LABELS.repo}=${spec.repo}`,
		image,
		...spec.command,
	];
}

/** The control plane's uid:gid, which the sandbox runs as. Refuses root. */
function sandboxUser(): string {
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (uid === undefined || gid === undefined) throw new SandboxError("cannot determine the control plane's uid and gid");
	if (uid === 0 || gid === 0) throw new SandboxError("the control plane must not run as root: the sandbox runs as its uid and gid");
	return `${uid}:${gid}`;
}

/**
 * Starts a sandbox. Its stdin and stdout are the only channel to the control
 * plane. The docker client itself gets an empty environment apart from what it
 * needs to reach the engine, so nothing from the control plane's environment
 * can be forwarded by accident.
 */
export function startSandbox(image: string, spec: SandboxSpec, limits: SandboxLimits = DEFAULT_LIMITS): Bun.Subprocess<"pipe", "pipe", "pipe"> {
	return Bun.spawn(["docker", ...sandboxRunArgs(image, spec, limits)], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: dockerClientEnv(),
	});
}

/** The environment the docker client needs to reach the engine, and nothing else. */
export function dockerClientEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}
