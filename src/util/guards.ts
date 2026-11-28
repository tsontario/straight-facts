/**
 * Shared type guards for data parsed at a boundary (TOML, JSON). This is the
 * one place they are defined; import them rather than redefining them locally.
 */

/** True for a plain table/object: not null, not an array. Its fields stay `unknown`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
