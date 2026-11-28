import { join } from "node:path";

/**
 * The approver roster (L-0004), read from `APPROVERS.md`, the protected file that
 * declares it. Approvers are listed by platform handle, as `[@handle](url)` in its
 * table.
 */

export const APPROVERS_PATH = join(import.meta.dir, "../../APPROVERS.md");

/** Every approver's handle, with its `@`. */
export async function loadApprovers(path: string = APPROVERS_PATH): Promise<ReadonlySet<string>> {
	return parseApprovers(await Bun.file(path).text());
}

export function parseApprovers(text: string): ReadonlySet<string> {
	const handles = new Set<string>();
	for (const line of text.split("\n")) {
		const match = /^\|\s*\[(@[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\]\(/.exec(line);
		if (match?.[1]) handles.add(match[1]);
	}
	if (handles.size === 0) throw new Error("the approver roster lists no approvers");
	return handles;
}
