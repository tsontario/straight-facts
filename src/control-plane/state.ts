import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-log/event-log";

/**
 * Where the control plane keeps its state on the host: the event log and the halt
 * file. Outside every sandbox and workspace, so no agent can write them (L-0005).
 * `STRAIGHT_FACTS_STATE` overrides the default, `$XDG_STATE_HOME/straight-facts`.
 */

export const STATE_DIR = process.env.STRAIGHT_FACTS_STATE ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local/state"), "straight-facts");
export const EVENT_LOG_PATH = join(STATE_DIR, "events.sqlite");
/** The halt file's directory, which each gateway mounts read-only. */
export const HALT_DIR = join(STATE_DIR, "halt");

/** Opens the factory's event log, creating the state directory, private to its user, if needed. */
export function openEventLog(): EventLog {
	mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
	return EventLog.open(EVENT_LOG_PATH);
}
