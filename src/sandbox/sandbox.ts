import { isAbsolute } from "node:path";

/**
 * Runs one task in its own sandbox container (L-0024, decision 0002 §1).
 *
 * The container gets no network, a read-only root filesystem with a tmpfs at
 * `/tmp`, a non-root user, no capabilities, no privilege escalation, resource
 * limits, and exactly one host path: the task's workspace. No host environment
 * reaches it; only `HOME` is set. The labels let a halt find and kill it.
 *
 * Network: step 1 of decision 0002 uses `--network none`. Step 2 replaces it
 * with the task's internal network and gateway.
 */

export interface SandboxSpec {
	readonly taskId: string;
	readonly laneId: string;
	/** The repository the task works on, as `owner/name`. */
	readonly repo: string;
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

/** The uid:gid of the image's unprivileged `bun` user. */
const USER = "1000:1000";
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export class SandboxError extends Error {
	override readonly name = "SandboxError";
}

/** The `docker run` arguments for a sandbox. Validates the spec first. */
export function sandboxRunArgs(image: string, spec: SandboxSpec, limits: SandboxLimits = DEFAULT_LIMITS): string[] {
	if (!ID.test(spec.taskId)) throw new SandboxError(`invalid task id: ${JSON.stringify(spec.taskId)}`);
	if (!ID.test(spec.laneId)) throw new SandboxError(`invalid lane id: ${JSON.stringify(spec.laneId)}`);
	if (!REPO.test(spec.repo)) throw new SandboxError(`invalid repository: ${JSON.stringify(spec.repo)}`);
	if (!isAbsolute(spec.workspace) || /[,\n]/.test(spec.workspace)) {
		throw new SandboxError(`workspace must be an absolute path without commas or newlines: ${JSON.stringify(spec.workspace)}`);
	}
	if (spec.command.length === 0) throw new SandboxError("command must not be empty");
	return [
		"run",
		"--rm",
		"--interactive",
		"--name",
		`sf-${spec.taskId}`,
		"--network",
		"none",
		"--read-only",
		"--tmpfs",
		`/tmp:rw,nosuid,nodev,size=${limits.tmpfsSize}`,
		"--user",
		USER,
		"--cap-drop",
		"ALL",
		"--security-opt",
		"no-new-privileges",
		"--pids-limit",
		String(limits.pids),
		"--memory",
		limits.memory,
		"--cpus",
		String(limits.cpus),
		"--env",
		"HOME=/tmp",
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
function dockerClientEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG"]) {
		const value = process.env[key];
		if (value !== undefined) env[key] = value;
	}
	return env;
}
