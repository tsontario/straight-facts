import { join } from "node:path";

/**
 * Loads and validates the task taxonomy (L-0009) from `tasks/taxonomy.toml`,
 * and works out which gates a task must pass.
 *
 * The file is protected core; this module is how code reads it. Validation is
 * strict, so a typo cannot quietly drop a gate. It rejects duplicate keys
 * (the TOML parser does this), unknown or missing fields, unknown gates and
 * network profiles, bad values, and path patterns that are not plain
 * repository-relative globs.
 */

export type Enforcement = "ci" | "review" | "manual";
export type Output = "code-change" | "document" | "finding" | "decision" | "revert" | "memory-promotion" | "amendment";

export interface Gate {
	readonly id: string;
	/** The law the gate puts into practice, e.g. `L-0021`. */
	readonly law: string;
	readonly enforced: Enforcement;
	readonly description: string;
}

export interface NetworkProfile {
	readonly name: string;
	/** Hosts reachable beyond the control plane; `*` means any host. */
	readonly hosts: readonly string[];
	readonly methods: readonly string[];
}

export interface TaskKind {
	readonly name: string;
	readonly produces: Output;
	/** The kind's own gates, the gates required for all kinds first. */
	readonly gates: readonly Gate[];
	readonly network: NetworkProfile;
	/** Repository path patterns the kind may change; empty means none. */
	readonly writes: readonly string[];
}

/** Gates that apply to any task whose changes touch `paths`, whatever its kind. */
export interface PathGate {
	readonly paths: readonly string[];
	readonly gates: readonly Gate[];
}

export interface Taxonomy {
	readonly gates: ReadonlyMap<string, Gate>;
	readonly network: ReadonlyMap<string, NetworkProfile>;
	readonly pathGates: readonly PathGate[];
	readonly kinds: ReadonlyMap<string, TaskKind>;
}

export class TaxonomyError extends Error {
	override readonly name = "TaxonomyError";
	constructor(readonly problems: readonly string[]) {
		super(`invalid task taxonomy:\n- ${problems.join("\n- ")}`);
	}
}

export const TAXONOMY_PATH = join(import.meta.dir, "../../tasks/taxonomy.toml");

/** Stands for the paths declared in `.github/CODEOWNERS`, the protected core (L-0001 §3). */
export const PROTECTED_CORE = "@protected-core";

const ID = /^[a-z][a-z0-9-]*$/;
const LAW = /^L-\d{4}$/;
const ENFORCEMENTS: readonly Enforcement[] = ["ci", "review", "manual"];
const OUTPUTS: readonly Output[] = ["code-change", "document", "finding", "decision", "revert", "memory-promotion", "amendment"];
const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];
const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Reads and validates the taxonomy file. */
export async function loadTaxonomy(path: string = TAXONOMY_PATH): Promise<Taxonomy> {
	return parseTaxonomy(await Bun.file(path).text());
}

/** Returns the declared kind, or throws: a task may only have a declared kind (L-0009 §1). */
export function kindOf(taxonomy: Taxonomy, name: string): TaskKind {
	const kind = taxonomy.kinds.get(name);
	if (!kind) throw new TaxonomyError([`undeclared task kind: ${JSON.stringify(name)}`]);
	return kind;
}

/**
 * The gates a task must pass: its kind's gates, plus every path gate whose
 * paths match a changed path. `isProtected` decides membership of the
 * protected core.
 */
export function gatesFor(
	taxonomy: Taxonomy,
	kind: TaskKind,
	changedPaths: readonly string[],
	isProtected: (path: string) => boolean,
): Gate[] {
	const gates = [...kind.gates];
	for (const rule of taxonomy.pathGates) {
		if (!changedPaths.some(path => rule.paths.some(pattern => matches(pattern, path, isProtected)))) continue;
		for (const gate of rule.gates) if (!gates.includes(gate)) gates.push(gate);
	}
	return gates;
}

/** True if every changed path is one the kind may write (L-0009 §4). */
export function writesAllowed(kind: TaskKind, changedPaths: readonly string[], isProtected: (path: string) => boolean): boolean {
	return changedPaths.every(path => kind.writes.some(pattern => matches(pattern, path, isProtected)));
}

function matches(pattern: string, path: string, isProtected: (path: string) => boolean): boolean {
	return pattern === PROTECTED_CORE ? isProtected(path) : new Bun.Glob(pattern).match(path);
}

/** Validates taxonomy TOML text, reporting every problem at once. */
export function parseTaxonomy(text: string): Taxonomy {
	let parsed: unknown;
	try {
		parsed = Bun.TOML.parse(text);
	} catch (error) {
		throw new TaxonomyError([`not valid TOML: ${error instanceof Error ? error.message : String(error)}`]);
	}
	const problems: string[] = [];
	const root = asRecord(parsed, "taxonomy", problems);
	if (!root) throw new TaxonomyError(problems);
	onlyKeys(root, ["required_for_all", "gates", "network", "path_gates", "kinds"], "taxonomy", problems);

	const declaredGates = new Set<string>();
	const gates = new Map<string, Gate>();
	for (const [id, raw] of entries(root.gates, "gates", problems)) {
		const where = `gates.${id}`;
		declaredGates.add(id);
		if (!ID.test(id)) problems.push(`${where}: id must match ${ID}`);
		const gate = asRecord(raw, where, problems);
		if (!gate) continue;
		onlyKeys(gate, ["law", "enforced", "description"], where, problems);
		const law = str(gate.law, `${where}.law`, problems);
		if (law !== undefined && !LAW.test(law)) problems.push(`${where}.law: must look like L-0001`);
		const enforced = oneOf(gate.enforced, ENFORCEMENTS, `${where}.enforced`, problems);
		const description = str(gate.description, `${where}.description`, problems);
		if (law !== undefined && enforced !== undefined && description !== undefined) {
			gates.set(id, { id, law, enforced, description });
		}
	}
	const resolve = (value: unknown, where: string): Gate[] | undefined => {
		const ids = strList(value, where, problems);
		if (!ids) return undefined;
		const resolved: Gate[] = [];
		for (const id of ids) {
			const gate = gates.get(id);
			if (gate) resolved.push(gate);
			// A declared but invalid gate has already been reported; don't repeat it as unknown.
			else if (!declaredGates.has(id)) problems.push(`${where}: unknown gate ${JSON.stringify(id)}`);
		}
		return resolved.length === ids.length ? resolved : undefined;
	};

	const network = new Map<string, NetworkProfile>();
	for (const [name, raw] of entries(root.network, "network", problems)) {
		const where = `network.${name}`;
		if (!ID.test(name)) problems.push(`${where}: name must match ${ID}`);
		const profile = asRecord(raw, where, problems);
		if (!profile) continue;
		onlyKeys(profile, ["hosts", "methods"], where, problems);
		const hosts = strList(profile.hosts, `${where}.hosts`, problems);
		const methods = strList(profile.methods, `${where}.methods`, problems);
		for (const host of hosts ?? []) {
			const problem = hostProblem(host);
			if (problem) problems.push(`${where}.hosts: ${JSON.stringify(host)} ${problem}`);
		}
		for (const method of methods ?? []) {
			if (!METHODS.includes(method)) problems.push(`${where}.methods: unknown method ${JSON.stringify(method)}`);
		}
		if (hosts && methods && (hosts.length === 0) !== (methods.length === 0)) {
			problems.push(`${where}: hosts and methods must both be empty or both be non-empty`);
		}
		if (hosts && methods) network.set(name, { name, hosts, methods });
	}

	const requiredForAll = resolve(root.required_for_all, "required_for_all");

	const pathGates: PathGate[] = [];
	if (!Array.isArray(root.path_gates)) problems.push("path_gates: must be a list of tables");
	else {
		root.path_gates.forEach((raw: unknown, i: number) => {
			const where = `path_gates[${i}]`;
			const rule = asRecord(raw, where, problems);
			if (!rule) return;
			onlyKeys(rule, ["paths", "gates"], where, problems);
			const paths = patterns(rule.paths, `${where}.paths`, problems, false);
			const ruleGates = resolve(rule.gates, `${where}.gates`);
			if (paths?.length === 0) problems.push(`${where}.paths: must not be empty`);
			if (ruleGates?.length === 0) problems.push(`${where}.gates: must not be empty`);
			if (paths && ruleGates) pathGates.push({ paths, gates: ruleGates });
		});
	}

	const kinds = new Map<string, TaskKind>();
	for (const [name, raw] of entries(root.kinds, "kinds", problems)) {
		const where = `kinds.${name}`;
		if (!ID.test(name)) problems.push(`${where}: name must match ${ID}`);
		const kind = asRecord(raw, where, problems);
		if (!kind) continue;
		onlyKeys(kind, ["produces", "gates", "network", "writes"], where, problems);
		const produces = oneOf(kind.produces, OUTPUTS, `${where}.produces`, problems);
		const own = resolve(kind.gates, `${where}.gates`);
		const networkName = str(kind.network, `${where}.network`, problems);
		const profile = networkName === undefined ? undefined : network.get(networkName);
		if (networkName !== undefined && !profile) {
			problems.push(`${where}.network: unknown profile ${JSON.stringify(networkName)}`);
		}
		const writes = patterns(kind.writes, `${where}.writes`, problems, true);
		if (produces && own && requiredForAll && profile && writes) {
			const all = [...requiredForAll, ...own.filter(gate => !requiredForAll.includes(gate))];
			kinds.set(name, { name, produces, gates: all, network: profile, writes });
		}
	}
	if (kinds.size === 0 && problems.length === 0) problems.push("kinds: at least one kind is required");

	if (problems.length > 0) throw new TaxonomyError(problems);
	return { gates, network, pathGates, kinds };
}

/** Returns why `host` is not a valid DNS name (or `*`), or undefined if it is. */
function hostProblem(host: string): string | undefined {
	if (host === "*") return undefined;
	if (host.length > 253) return "is longer than 253 characters";
	const labels = host.split(".");
	if (labels.length < 2) return "must be a fully qualified domain name";
	if (!labels.every(label => LABEL.test(label))) return "is not a valid domain name";
	if (/^\d+$/.test(labels[labels.length - 1]!)) return "must be a domain name, not an IP address";
	return undefined;
}

/** Validates repository path patterns; `allowEmpty` controls whether an empty list is valid. */
function patterns(value: unknown, where: string, problems: string[], allowEmpty: boolean): string[] | undefined {
	const items = strList(value, where, problems);
	if (!items) return undefined;
	if (!allowEmpty && items.length === 0) return items;
	let ok = true;
	for (const pattern of items) {
		const problem = patternProblem(pattern);
		if (problem) {
			problems.push(`${where}: ${JSON.stringify(pattern)} ${problem}`);
			ok = false;
		}
	}
	return ok ? items : undefined;
}

/** Returns why `pattern` is not a plain repository-relative glob (or the protected-core token). */
function patternProblem(pattern: string): string | undefined {
	if (pattern === PROTECTED_CORE) return undefined;
	if (pattern.startsWith("@")) return `is an unknown token; only ${PROTECTED_CORE} is defined`;
	if (pattern !== pattern.trim()) return "has leading or trailing whitespace";
	if (pattern.startsWith("/") || pattern.startsWith("./")) return "must be relative to the repository root, without / or ./";
	if (pattern.startsWith("!")) return "cannot be a negation; writes lists only what is allowed";
	if (pattern.endsWith("/")) return "ends with /, so it matches nothing; use dir/**";
	if (pattern.includes("\\")) return "contains a backslash";
	if (pattern.split("/").some(segment => segment === "" || segment === "." || segment === "..")) {
		return "has an empty, . or .. segment";
	}
	if (pattern.split("/").some(segment => segment.includes("**") && segment !== "**")) {
		return "joins ** to other characters, which makes it behave like *; use ** as a whole segment";
	}
	if (pattern.includes("[]") || pattern.includes("{}")) return "has an empty [] or {} group";
	let square = 0;
	let curly = 0;
	for (const char of pattern) {
		if (char === "[") square += 1;
		else if (char === "]") square -= 1;
		else if (char === "{") curly += 1;
		else if (char === "}") curly -= 1;
		if (square < 0 || curly < 0) break;
	}
	if (square !== 0 || curly !== 0) return "has unbalanced brackets or braces";
	return undefined;
}

function asRecord(value: unknown, where: string, problems: string[]): Record<string, unknown> | undefined {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as Record<string, unknown>;
	problems.push(`${where}: must be a table`);
	return undefined;
}

function entries(value: unknown, where: string, problems: string[]): Array<[string, unknown]> {
	const record = asRecord(value, where, problems);
	return record ? Object.entries(record) : [];
}

function onlyKeys(record: Record<string, unknown>, allowed: readonly string[], where: string, problems: string[]): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) problems.push(`${where}: unknown field ${JSON.stringify(key)}`);
	}
	for (const key of allowed) {
		if (!(key in record)) problems.push(`${where}: missing field ${JSON.stringify(key)}`);
	}
}

function str(value: unknown, where: string, problems: string[]): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) return value;
	problems.push(`${where}: must be a non-empty string`);
	return undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], where: string, problems: string[]): T | undefined {
	const found = allowed.find(option => option === value);
	if (found === undefined) problems.push(`${where}: must be one of ${allowed.join(", ")}`);
	return found;
}

function strList(value: unknown, where: string, problems: string[]): string[] | undefined {
	if (!Array.isArray(value)) {
		problems.push(`${where}: must be a list`);
		return undefined;
	}
	const items = value.filter((item): item is string => typeof item === "string" && item.length > 0);
	if (items.length !== value.length) problems.push(`${where}: every item must be a non-empty string`);
	if (new Set(items).size !== items.length) problems.push(`${where}: duplicate items`);
	return items;
}
