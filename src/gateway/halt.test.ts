import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HALT_FILE_NAME, haltCheck, scopeCovers } from "./halt";

const dir = mkdtempSync(join(tmpdir(), "sf-halt-check-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const target = { lane: "lane-0001", repo: "tsontario/straight-facts" };

test("a halt covers the whole factory, or exactly its own lane or repository", () => {
	const scopes = ["factory", "lane:lane-0001", "repo:tsontario/straight-facts", "lane:lane-0002", "lane:lane-000", "lane:lane-00012", "repo:tsontario/straight-facts-2", "repo:other/straight-facts"];
	expect(scopes.filter(scope => scopeCovers(scope, target))).toEqual(["factory", "lane:lane-0001", "repo:tsontario/straight-facts"]);
});

test("reads the file on every check, and a missing or malformed file halts everything", () => {
	const halted = haltCheck(target, dir);
	const after = (content: string): boolean => {
		writeFileSync(join(dir, HALT_FILE_NAME), content);
		return halted();
	};
	expect(halted()).toBe(true);
	expect(after(JSON.stringify({ scopes: [] }))).toBe(false);
	expect(after(JSON.stringify({ scopes: ["lane:lane-0002", "repo:other/repo"] }))).toBe(false);
	expect(after(JSON.stringify({ scopes: ["lane:lane-0002", "repo:tsontario/straight-facts"] }))).toBe(true);
	expect(after(JSON.stringify({ scopes: [] }))).toBe(false);
	expect(after("")).toBe(true);
	expect(after("{")).toBe(true);
	expect(after(JSON.stringify({}))).toBe(true);
	expect(after(JSON.stringify({ scopes: "lane:lane-0002" }))).toBe(true);
	expect(after(JSON.stringify({ scopes: [null] }))).toBe(true);
	expect(after(JSON.stringify([]))).toBe(true);
	rmSync(join(dir, HALT_FILE_NAME));
	expect(halted()).toBe(true);
});
