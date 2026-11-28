import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../util/guards";

/**
 * The halt as the gateway sees it (decision 0002 §4): the control plane writes the
 * halt file, and each gateway mounts its directory read-only and checks it on every
 * request. A halted scope is the whole factory (`factory`), a lane (`lane:<id>`), or
 * a repository (`repo:<owner>/<name>`).
 */

/** Where the halt file's directory is mounted in a gateway. */
export const HALT_MOUNT = "/etc/straight-facts/halt";
export const HALT_FILE_NAME = "halt.json";

export interface HaltTarget {
	readonly lane: string;
	readonly repo: string;
}

export function scopeCovers(scope: string, target: HaltTarget): boolean {
	return scope === "factory" || scope === `lane:${target.lane}` || scope === `repo:${target.repo}`;
}

/**
 * The halted scopes the file lists. A file that is missing or malformed counts as a
 * factory-wide halt: deleting or corrupting it lifts nothing.
 */
export function readHaltFile(path: string): readonly string[] {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		const scopes = isRecord(parsed) ? parsed.scopes : undefined;
		if (Array.isArray(scopes) && scopes.every(scope => typeof scope === "string")) return scopes;
	} catch {}
	return ["factory"];
}

/** A check, read fresh on every call, of whether a halt covers `target`. */
export function haltCheck(target: HaltTarget, dir: string = HALT_MOUNT): () => boolean {
	const path = join(dir, HALT_FILE_NAME);
	return () => readHaltFile(path).some(scope => scopeCovers(scope, target));
}
