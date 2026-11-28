import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventLog } from "../event-log/event-log";
import { HALT_FILE_NAME, scopeCovers, type HaltTarget } from "../gateway/halt";
import { LABELS, dockerClientEnv } from "../sandbox/sandbox";
import { isRecord } from "../util/guards";
import { ID_PATTERN, REPO_PATTERN } from "../util/ids";

/**
 * The halt (L-0005, decision 0002 §4).
 *
 * Raising one does three things itself, so it never depends on a healthy watcher:
 * it appends `halt.raised`, rewrites the halt file, and runs `docker kill` on every
 * container labelled with the scope. The halt state is the event log's: the file is
 * a cache, rewritten from the log, that the gateways read. Only an approver can lift
 * a halt; a `halt.lifted` event from anyone else changes nothing.
 */

const REASON_LIMIT = 500;

export class HaltError extends Error {
	override readonly name = "HaltError";
}

/** Validates a scope: `factory`, `lane:<id>`, or `repo:<owner>/<name>`. */
export function parseScope(text: string): string {
	// Repository names are case-insensitive on GitHub, and tasks are labelled in lowercase.
	const scope = text.startsWith("repo:") ? text.toLowerCase() : text;
	const valid =
		scope === "factory" ||
		(scope.startsWith("lane:") && ID_PATTERN.test(scope.slice(5))) ||
		(scope.startsWith("repo:") && REPO_PATTERN.test(scope.slice(5)));
	if (!valid) throw new HaltError(`not a halt scope: ${JSON.stringify(text)} (use factory, lane:<id> or repo:<owner>/<name>)`);
	return scope;
}

/** The halts raised and not yet lifted by an approver, replayed from the event log. */
export class HaltState {
	readonly #log: EventLog;
	readonly #approvers: ReadonlySet<string>;
	readonly #active = new Set<string>();
	#next = 1;

	constructor(log: EventLog, approvers: ReadonlySet<string>) {
		this.#log = log;
		this.#approvers = approvers;
	}

	/** Reads the events appended since the last refresh, from this or any other process. */
	refresh(): this {
		for (const event of this.#log.read(this.#next)) {
			this.#next = event.seq + 1;
			const scope = isRecord(event.payload) ? event.payload.scope : undefined;
			if (typeof scope !== "string") continue;
			if (event.type === "halt.raised") this.#active.add(scope);
			else if (event.type === "halt.lifted" && this.#approvers.has(event.actor)) this.#active.delete(scope);
		}
		return this;
	}

	get scopes(): readonly string[] {
		return [...this.#active].sort();
	}

	covers(target: HaltTarget): boolean {
		return this.scopes.some(scope => scopeCovers(scope, target));
	}
}

export interface HaltOptions {
	readonly log: EventLog;
	readonly approvers: ReadonlySet<string>;
	/** The halt file's directory, which every gateway mounts read-only. */
	readonly haltDir: string;
}

/**
 * Rewrites the halt file from the log, atomically, readable by the gateways' user,
 * and returns the scopes it lists. Each halt event is followed by a rewrite, so a
 * deleted or edited file is restored from the record; the launcher (decision 0002
 * step 5) will also rewrite it at start-up.
 */
export async function writeHaltFile(options: HaltOptions): Promise<readonly string[]> {
	const state = new HaltState(options.log, options.approvers);
	await mkdir(options.haltDir, { recursive: true });
	await chmod(options.haltDir, 0o755);
	for (;;) {
		const scopes = state.refresh().scopes;
		const temporary = join(options.haltDir, `.${HALT_FILE_NAME}.${crypto.randomUUID()}`);
		await writeFile(temporary, JSON.stringify({ scopes }));
		await chmod(temporary, 0o644);
		await rename(temporary, join(options.haltDir, HALT_FILE_NAME));
		// Another process may have recorded a halt event and renamed its own file into
		// place before this rename. Rewriting until the record agrees after the rename
		// means the last file renamed always reflects every halt event before it.
		if (state.refresh().scopes.join("\n") === scopes.join("\n")) return scopes;
	}
}

/**
 * Raises a halt: appends `halt.raised`, rewrites the halt file, then kills every
 * container in the scope. Any approver may raise one (L-0005 §1), and so may the
 * control plane itself. The kill never depends on the file: if the file can't be
 * written, that is reported after the kill, together with any failure of the kill.
 */
export async function raiseHalt(options: HaltOptions, scope: string, by: string, reason: string): Promise<{ readonly killed: readonly string[] }> {
	const halted = parseScope(scope);
	if (by !== "control-plane" && !options.approvers.has(by)) throw new HaltError(`${by} is not an approver`);
	options.log.append({ type: "halt.raised", actor: by, payload: { scope: halted, reason: reason.slice(0, REASON_LIMIT) } });
	const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
	const unwritten = await writeHaltFile(options).then(() => undefined, message);
	const outcome = await killScope(halted).then(
		killed => ({ killed, error: undefined }),
		(error: unknown) => ({ killed: [], error: message(error) }),
	);
	if (outcome.error !== undefined) throw new HaltError(unwritten === undefined ? outcome.error : `${outcome.error}; and the halt file was not written: ${unwritten}`);
	if (unwritten !== undefined) throw new HaltError(`halt recorded and ${outcome.killed.length} container(s) killed, but the halt file was not written: ${unwritten}`);
	return { killed: outcome.killed };
}

/**
 * Lifts a halt. Only an approver can (L-0005 §6); the approval channel (§5) calls
 * this once it has verified that the reply came from a roster handle.
 */
export async function liftHalt(options: HaltOptions, scope: string, by: string): Promise<void> {
	const lifted = parseScope(scope);
	if (!options.approvers.has(by)) throw new HaltError("only an approver can lift a halt");
	options.log.append({ type: "halt.lifted", actor: by, payload: { scope: lifted } });
	await writeHaltFile(options);
}

/** Container states that are running, or could be started. */
const LIVE_STATES = ["created", "running", "paused", "restarting"];
/** How long a halt keeps clearing its scope; L-0005 §3 allows 60 seconds in all. */
const KILL_DEADLINE_MS = 30_000;
const KILL_RETRY_MS = 250;

/**
 * Kills every running container labelled with the scope, sandboxes and gateways, and
 * removes any not yet started, so none can start later. Lists the scope again until
 * it is empty, so a container created or started meanwhile goes too; throws if that
 * takes longer than the deadline. Returns the ids of every container it stopped.
 */
export async function killScope(scope: string): Promise<readonly string[]> {
	const label =
		scope === "factory" ? `label=${LABELS.task}` : scope.startsWith("lane:") ? `label=${LABELS.lane}=${scope.slice(5)}` : `label=${LABELS.repo}=${scope.slice(5)}`;
	const states = LIVE_STATES.flatMap(state => ["--filter", `status=${state}`]);
	const live = async (): Promise<{ id: string; state: string }[]> =>
		(await docker(["ps", "--all", "--no-trunc", "--filter", label, ...states, "--format", "{{.ID}} {{.State}}"]))
			.split("\n")
			.filter(Boolean)
			.map(line => {
				const [id = "", state = ""] = line.split(" ");
				return { id, state };
			});
	const stopped = new Set<string>();
	const deadline = performance.now() + KILL_DEADLINE_MS;
	for (let found = await live(); found.length > 0; found = await live()) {
		if (performance.now() > deadline) throw new HaltError(`${found.length} container(s) in ${scope} still alive after docker kill`);
		if (found.every(({ id }) => stopped.has(id))) await Bun.sleep(KILL_RETRY_MS);
		// A container that exits on its own meanwhile fails its command alone.
		await Promise.allSettled(found.map(({ id, state }) => docker(state === "running" ? ["kill", id] : ["rm", "--force", id])));
		for (const { id } of found) stopped.add(id);
	}
	return [...stopped];
}

async function docker(args: string[]): Promise<string> {
	const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", env: dockerClientEnv() });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new HaltError(`docker ${args[0]} failed (exit ${code}): ${stderr.trim()}`);
	return stdout;
}
