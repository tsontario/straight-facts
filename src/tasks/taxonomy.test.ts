import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { PROTECTED_CORE, TAXONOMY_PATH, TaxonomyError, gatesFor, kindOf, loadTaxonomy, parseTaxonomy, writesAllowed } from "./taxonomy";

const LAWS_DIR = join(import.meta.dir, "../../laws");

const MINIMAL = `
required_for_all = ["independent-verifier"]

[gates.independent-verifier]
law = "L-0020"
enforced = "manual"
description = "verifier"

[gates.checks]
law = "L-0014"
enforced = "ci"
description = "typecheck and tests"

[gates.approver-review]
law = "L-0001"
enforced = "review"
description = "approver"

[network.none]
hosts = []
methods = []

[[path_gates]]
paths = ["@protected-core"]
gates = ["approver-review"]

[kinds.feature]
produces = "code-change"
gates = ["checks"]
network = "none"
writes = ["**"]

[kinds.docs]
produces = "document"
gates = []
network = "none"
writes = ["**/*.md"]
`;

function problemsOf(text: string): readonly string[] {
	try {
		parseTaxonomy(text);
	} catch (error) {
		if (error instanceof TaxonomyError) return error.problems;
		throw error;
	}
	throw new Error("expected the taxonomy to be rejected");
}

const PROTECTED_PATHS: Record<string, true> = { "laws/L-0001-protected-core.md": true, "package.json": true };
const isProtected = (path: string): boolean => PROTECTED_PATHS[path] === true;

describe("the shipped taxonomy", () => {
	test("is valid; every kind needs the verifier and a secret scan suited to what it writes", async () => {
		const taxonomy = await loadTaxonomy(TAXONOMY_PATH);
		expect(taxonomy.kinds.size).toBe(10);
		for (const kind of taxonomy.kinds.values()) {
			const ids = kind.gates.map(gate => gate.id);
			const scan = kind.writes.length > 0 ? "secret-scan" : "entry-secret-scan";
			expect({ kind: kind.name, first: ids[0], scanned: ids.includes(scan) }).toEqual({
				kind: kind.name,
				first: "independent-verifier",
				scanned: true,
			});
		}
	});

	test("protected-core changes need approver review and dependency changes need the supply-chain gate, whatever the kind", async () => {
		const taxonomy = await loadTaxonomy(TAXONOMY_PATH);
		const ids = (kind: string, paths: string[]): string[] => gatesFor(taxonomy, kindOf(taxonomy, kind), paths, isProtected).map(g => g.id);

		expect(ids("docs", ["laws/L-0001-protected-core.md"])).toContain("approver-review");
		expect(ids("feature", ["bun.lock"])).toContain("supply-chain");
		expect(ids("feature", ["src/main.ts"])).not.toContain("approver-review");
		expect(ids("chore", ["scripts/install-betterleaks.sh"])).toContain("supply-chain");
		expect(writesAllowed(kindOf(taxonomy, "governance"), ["laws/L-0001-protected-core.md", "tasks/taxonomy.toml"], isProtected)).toBe(true);
		expect(writesAllowed(kindOf(taxonomy, "governance"), ["src/main.ts"], isProtected)).toBe(false);
		expect(writesAllowed(kindOf(taxonomy, "governance"), ["package.json"], isProtected)).toBe(false);
		expect(writesAllowed(kindOf(taxonomy, "docs"), ["src/main.ts"], isProtected)).toBe(false);
	});

	test("every gate cites a law that exists", async () => {
		const taxonomy = await loadTaxonomy(TAXONOMY_PATH);
		const laws = new Set(readdirSync(LAWS_DIR).map(file => file.slice(0, 6)));
		const missing = [...taxonomy.gates.values()].filter(gate => !laws.has(gate.law)).map(gate => `${gate.id} → ${gate.law}`);
		expect(missing).toEqual([]);
	});
});

describe("parseTaxonomy", () => {
	test("rejects a duplicated key instead of letting it replace a gate", () => {
		const duplicated = MINIMAL.replace('gates = ["checks"]', 'gates = ["checks"]\ngates = []');
		expect(problemsOf(duplicated)[0]).toStartWith("not valid TOML");
	});

	test("puts the gates required for all kinds first, without duplicates", () => {
		const taxonomy = parseTaxonomy(MINIMAL.replace('gates = ["checks"]', 'gates = ["checks", "independent-verifier"]'));
		expect(kindOf(taxonomy, "feature").gates.map(gate => gate.id)).toEqual(["independent-verifier", "checks"]);
	});

	test("reports every problem at once, without repeating a bad gate as unknown", () => {
		const broken = MINIMAL.replace('law = "L-0014"', 'law = "L-14"')
			.replace('enforced = "ci"', 'enforced = "sometimes"')
			.replace('description = "approver"', 'description = "   "')
			.replace('required_for_all = ["independent-verifier"]', 'required_for_all = ["independent-verifier", "typo-gate"]')
			.replace('produces = "code-change"', 'produces = "binary"\nextra = true')
			.replace('network = "none"\nwrites = ["**"]', 'network = "internet"\nwrites = ["**"]');
		const problems = problemsOf(broken);
		expect(problems).toEqual(
			expect.arrayContaining([
				"gates.checks.law: must look like L-0001",
				"gates.checks.enforced: must be one of ci, review, manual",
				"gates.approver-review.description: must be a non-empty string",
				'required_for_all: unknown gate "typo-gate"',
				"kinds.feature.produces: must be one of code-change, document, finding, decision, revert, memory-promotion, amendment",
				'kinds.feature: unknown field "extra"',
				'kinds.feature.network: unknown profile "internet"',
			]),
		);
		expect(problems.filter(problem => problem.includes('unknown gate "approver-review"') || problem.includes('unknown gate "checks"'))).toEqual([]);
	});

	test("rejects unknown fields and bad names at every level", () => {
		const problems = problemsOf(
			`extra = 1\n${MINIMAL}`
				.replace('description = "verifier"', 'description = "verifier"\nnote = "x"')
				.replace("[network.none]\nhosts = []", "[network.none]\nproxy = true\nhosts = []")
				.replace("[kinds.docs]", "[kinds.Bad_Name]"),
		);
		expect(problems).toEqual(
			expect.arrayContaining([
				'taxonomy: unknown field "extra"',
				'gates.independent-verifier: unknown field "note"',
				'network.none: unknown field "proxy"',
				"kinds.Bad_Name: name must match /^[a-z][a-z0-9-]*$/",
			]),
		);
	});

	test("rejects path patterns that are not plain repository-relative globs", () => {
		const bad = ["/etc/**", "./docs/**", "../**", "docs//research/**", "docs/./research/**", "!laws/**", "docs/research/", "docs\\x", " docs/**", "[abc", "]x[", "{a,b", "@everything", "src/***", "**.md", "docs/[]", "docs/{}"];
		const problems = problemsOf(MINIMAL.replace('writes = ["**/*.md"]', `writes = [${bad.map(p => JSON.stringify(p)).join(", ")}]`));
		const flagged = bad.filter(pattern => problems.some(problem => problem.startsWith(`kinds.docs.writes: ${JSON.stringify(pattern)}`)));
		expect(flagged).toEqual(bad);
	});

	test("rejects hosts that are not domain names, and unknown methods", () => {
		const problems = problemsOf(
			MINIMAL.replace("hosts = []\nmethods = []", `hosts = ["999.999.999.999", "${"a".repeat(64)}.com", "bad host.com", "localhost"]\nmethods = ["FETCH"]`),
		);
		expect(problems).toEqual(
			expect.arrayContaining([
				'network.none.hosts: "999.999.999.999" must be a domain name, not an IP address',
				`network.none.hosts: "${"a".repeat(64)}.com" is not a valid domain name`,
				'network.none.hosts: "bad host.com" is not a valid domain name',
				'network.none.hosts: "localhost" must be a fully qualified domain name',
				'network.none.methods: unknown method "FETCH"',
			]),
		);
	});

	test("rejects a taxonomy with no kinds, and text that is not TOML", () => {
		expect(problemsOf(MINIMAL.replace(/\[kinds\.[\s\S]*$/, "[kinds]\n"))).toEqual(["kinds: at least one kind is required"]);
		expect(problemsOf("kinds = [unclosed")[0]).toStartWith("not valid TOML");
	});

	test("rejects bad gate ids and profile names, and malformed path gates", () => {
		const problems = problemsOf(
			MINIMAL.replace("[gates.checks]", "[gates.Bad_Id]")
				.replace('gates = ["checks"]', "gates = []")
				.replace("[network.none]\nhosts = []\nmethods = []", '[network.none]\nhosts = []\nmethods = []\n\n[network.Bad_Name]\nhosts = ["example.com"]\nmethods = []')
				.replace('paths = ["@protected-core"]\ngates = ["approver-review"]', 'paths = []\ngates = []\nextra = 1'),
		);
		expect(problems).toEqual(
			expect.arrayContaining([
				"gates.Bad_Id: id must match /^[a-z][a-z0-9-]*$/",
				"network.Bad_Name: name must match /^[a-z][a-z0-9-]*$/",
				"network.Bad_Name: hosts and methods must both be empty or both be non-empty",
				'path_gates[0]: unknown field "extra"',
				"path_gates[0].paths: must not be empty",
				"path_gates[0].gates: must not be empty",
			]),
		);
		expect(problemsOf(MINIMAL.replace('[[path_gates]]\npaths = ["@protected-core"]\ngates = ["approver-review"]', 'path_gates = "none"'))).toContain(
			"path_gates: must be a list of tables",
		);
	});

	test("rejects a host name longer than 253 characters", () => {
		const long = `${Array.from({ length: 5 }, () => "a".repeat(60)).join(".")}.com`;
		expect(problemsOf(MINIMAL.replace("hosts = []\nmethods = []", `hosts = ["${long}"]\nmethods = ["GET"]`))).toContain(
			`network.none.hosts: "${long}" is longer than 253 characters`,
		);
	});
});

describe("kindOf", () => {
	test("rejects a kind the taxonomy does not declare (L-0009 §1)", () => {
		const taxonomy = parseTaxonomy(MINIMAL);
		expect(() => kindOf(taxonomy, "hotfix")).toThrow(/undeclared task kind: "hotfix"/);
		expect(kindOf(taxonomy, "feature").network.name).toBe("none");
	});
});

describe("gatesFor and writesAllowed", () => {
	test("add path gates only when a changed path matches, and honor the protected-core token", () => {
		const taxonomy = parseTaxonomy(MINIMAL);
		const docs = kindOf(taxonomy, "docs");
		expect(gatesFor(taxonomy, docs, ["README.md"], isProtected).map(g => g.id)).toEqual(["independent-verifier"]);
		expect(gatesFor(taxonomy, docs, ["README.md", "laws/L-0001-protected-core.md"], isProtected).map(g => g.id)).toEqual([
			"independent-verifier",
			"approver-review",
		]);
		expect(writesAllowed(docs, ["README.md", "docs/a.md"], isProtected)).toBe(true);
		expect(writesAllowed(docs, ["README.md", "src/a.ts"], isProtected)).toBe(false);
		expect(PROTECTED_CORE).toBe("@protected-core");
	});

	test("list a gate once when a kind's own gate is also triggered by a path", () => {
		const taxonomy = parseTaxonomy(MINIMAL.replace('gates = ["checks"]', 'gates = ["checks", "approver-review"]'));
		const ids = gatesFor(taxonomy, kindOf(taxonomy, "feature"), ["laws/L-0001-protected-core.md"], isProtected).map(g => g.id);
		expect(ids).toEqual(["independent-verifier", "checks", "approver-review"]);
	});
});
