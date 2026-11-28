import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	IMAGES_PATH,
	ImageError,
	findingsOf,
	inputsAt,
	inputsOf,
	loadImages,
	pinState,
	pinnedForTest,
	pinnedReference,
	pinsAt,
	rescanEntry,
	setsPin,
	type Finding,
	type Pin,
} from "./images";

const dir = mkdtempSync(join(tmpdir(), "sf-images-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Loads the committed images file with `pattern` replaced, anchored on its structure so routine pin and input updates keep matching. */
async function loadVariant(replace: [string | RegExp, string]): Promise<unknown> {
	const [pattern, replacement] = replace;
	const original = await Bun.file(IMAGES_PATH).text();
	if (typeof pattern === "string" ? !original.includes(pattern) : !pattern.test(original)) throw new Error(`fixture text not found: ${String(pattern)}`);
	const path = join(dir, `images-${crypto.randomUUID()}.toml`);
	await Bun.write(path, original.replace(pattern, replacement));
	return await loadImages(path);
}

test("the committed images file is valid", async () => {
	await expect(loadImages()).resolves.toBeDefined();
});

test("refuses build inputs that are not pinned", async () => {
	// A sandbox base image by tag alone, not digest.
	await expect(loadVariant(["-debian@sha256:", "-debian-"])).rejects.toThrow(ImageError);
	// A gateway base image by tag alone.
	await expect(loadVariant(["-distroless@sha256:", "-distroless-"])).rejects.toThrow(ImageError);
	// The live Debian mirror instead of a snapshot.
	await expect(loadVariant(['debian_snapshot = "', 'debian_snapshot = "latest'])).rejects.toThrow(ImageError);
	// A missing checksum for one architecture.
	await expect(loadVariant(["arm64 = ", "arm = "])).rejects.toThrow(ImageError);
	// A registry outside ghcr.io.
	await expect(loadVariant(['repository = "ghcr.io/tsontario/straight-facts-gateway', 'repository = "docker.io/tsontario/straight-facts-gateway'])).rejects.toThrow(
		ImageError,
	);
	// A scanner image by tag alone.
	await expect(loadVariant([/(trivy:[^@"]+)@sha256:/, "$1-"])).rejects.toThrow(ImageError);
});

test("refuses an image without a well-formed pin", async () => {
	await expect(loadVariant(["[gateway.pin]", "[gateway.pinned]"])).rejects.toThrow(/\[gateway\.pin\]/);
	await expect(loadVariant([/(\[sandbox\.pin\][^[]*digest = ")sha256:/, "$1"])).rejects.toThrow(/\[sandbox\.pin\]/);
	await expect(loadVariant([/(\[sandbox\.pin\][^[]*commit = "[0-9a-f]{7})[0-9a-f]{33}/, "$1"])).rejects.toThrow(/\[sandbox\.pin\]/);
});

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const labelled = (hash: unknown) => ({ config: { Labels: { "straight-facts.inputs": hash } } });

test("reads the inputs hash only from an index of both architectures labelled alike", () => {
	expect(inputsOf({ "linux/amd64": labelled(HASH_A), "linux/arm64": labelled(HASH_A) }, "ref")).toBe(HASH_A);
	const refused = [
		{ "linux/amd64": labelled(HASH_A) },
		{ "linux/amd64": labelled(HASH_A), "linux/arm64": labelled(HASH_B) },
		{ "linux/amd64": labelled(HASH_A), "linux/arm64": labelled(undefined) },
		{ "linux/amd64": labelled("short"), "linux/arm64": labelled("short") },
		{ "linux/amd64": labelled(HASH_A), "linux/arm64": labelled(HASH_A), "linux/s390x": labelled(HASH_A) },
		null,
	];
	for (const images of refused) expect(() => inputsOf(images, "ref")).toThrow(ImageError);
});

test("a change sets a pin when it adds it or replaces its digest or commit", () => {
	const pin: Pin = { digest: `sha256:${"1".repeat(64)}`, commit: "2".repeat(40) };
	expect(setsPin({ gateway: pin }, "gateway", pin)).toBe(false);
	expect(setsPin({ sandbox: pin }, "gateway", pin)).toBe(true);
	expect(setsPin({ gateway: { ...pin, digest: `sha256:${"3".repeat(64)}` } }, "gateway", pin)).toBe(true);
	expect(setsPin({ gateway: { ...pin, commit: "4".repeat(40) } }, "gateway", pin)).toBe(true);
});

test("a pin may lag the inputs unless the change sets it; a pin it sets must be built from its base's inputs, which it leaves alone", () => {
	// Not set by the change: current or lagging, never refused.
	expect(pinState("gateway", HASH_A, HASH_A, undefined)).toBe("current");
	expect(pinState("gateway", HASH_A, HASH_B, undefined)).toBe("lagging");
	// Set to the image built from the inputs on the base, which the change leaves alone.
	expect(pinState("gateway", HASH_A, HASH_A, HASH_A)).toBe("current");
	// Refused: an image built from older inputs than the base's.
	expect(() => pinState("gateway", HASH_A, HASH_B, HASH_B)).toThrow(/\[gateway\.pin\] is set to an image built from other inputs than its base's/);
	// Refused: the same change also sets the inputs back to the old image's.
	expect(() => pinState("gateway", HASH_A, HASH_A, HASH_B)).toThrow(/than its base's/);
	// Refused: the change pins the base's image but changes its inputs too.
	expect(() => pinState("gateway", HASH_A, HASH_B, HASH_A)).toThrow(/than this change's/);
});

test("hashes an image's inputs in any checkout: its Dockerfile directory, its sources and its build arguments", async () => {
	const root = join(dir, `checkout-${crypto.randomUUID()}`);
	for (const path of ["images", "src/gateway", "src/util"]) cpSync(join(IMAGES_PATH, "../..", path), join(root, path), { recursive: true });
	const [sandbox, gateway] = [await inputsAt("sandbox"), await inputsAt("gateway")];
	expect([await inputsAt("sandbox", root), await inputsAt("gateway", root)]).toEqual([sandbox, gateway]);
	// Tests are not inputs; a source file is, and only of the image built from it.
	writeFileSync(join(root, "src/gateway/extra.test.ts"), "");
	expect(await inputsAt("gateway", root)).toBe(gateway);
	const source = join(root, "src/gateway/config.ts");
	writeFileSync(source, `${readFileSync(source, "utf8")}\n`);
	expect([await inputsAt("sandbox", root), (await inputsAt("gateway", root)) === gateway]).toEqual([sandbox, false]);
	// A build argument in the checkout's images file.
	const toml = join(root, "images/images.toml");
	const text = readFileSync(toml, "utf8");
	const snapshot = /debian_snapshot = "\d{8}T\d{6}Z"/;
	if (!snapshot.test(text)) throw new Error("fixture text not found");
	// A date before any real snapshot, so it always differs from the committed one.
	writeFileSync(toml, text.replace(snapshot, 'debian_snapshot = "20000101T000000Z"'));
	expect((await inputsAt("sandbox", root)) === sandbox).toBe(false);
});

test("reads a base's pins as far as they are well-formed", () => {
	const text = ['[sandbox.pin]', `digest = "sha256:${"1".repeat(64)}"`, `commit = "${"2".repeat(40)}"`, "[gateway.pin]", 'digest = "latest"', `commit = "${"2".repeat(40)}"`].join("\n");
	expect(pinsAt(text)).toEqual({ sandbox: { digest: `sha256:${"1".repeat(64)}`, commit: "2".repeat(40) } });
	expect(pinsAt("")).toEqual({});
});

test("takes every finding from a Trivy report, and refuses one that scanned no Debian packages", () => {
	const report = {
		Metadata: { OS: { Family: "debian" } },
		Results: [
			{ Class: "os-pkgs", Vulnerabilities: [{ VulnerabilityID: "CVE-1", PkgName: "libc6", Severity: "CRITICAL", SeveritySource: "debian", VendorSeverity: { debian: 4 } }] },
			{ Class: "lang-pkgs", Vulnerabilities: [{ VulnerabilityID: "CVE-2", PkgName: "x", Severity: "HIGH" }] },
		],
	};
	expect(findingsOf(report, "img")).toEqual([
		{ id: "CVE-1", pkg: "libc6", severity: "CRITICAL", severitySource: "debian", vendorSeverity: { debian: 4 } },
		{ id: "CVE-2", pkg: "x", severity: "HIGH", severitySource: "", vendorSeverity: {} },
	]);
	expect(() => findingsOf({ ...report, Metadata: { OS: { Family: "alpine" } } }, "img")).toThrow(/no Debian packages/);
	expect(() => findingsOf({ ...report, Results: [report.Results[1]] }, "img")).toThrow(/no Debian packages/);
	expect(() => findingsOf({}, "img")).toThrow(/no Debian packages/);
});

test("a rescan flags critical findings on either architecture, and a pin more than 31 days old", () => {
	const finding = (id: string, severity: string, platform: string): Finding & { platform: string } => ({ id, pkg: "p", severity, severitySource: "", vendorSeverity: {}, platform });
	const scanned = { image: "sandbox" as const, reference: "ref", commit: "2".repeat(40), pinnedAt: "2026-10-01T00:00:00Z", findings: [] };
	const day = 86_400_000;
	const at = (ms: number) => new Date(Date.parse(scanned.pinnedAt) + ms);
	expect(rescanEntry(scanned, at(31 * day))).toMatchObject({ ageDays: 31, stale: false, critical: [] });
	expect(rescanEntry(scanned, at(31 * day + 1))).toMatchObject({ ageDays: 31, stale: true });
	const findings = [finding("CVE-1", "CRITICAL", "linux/amd64"), finding("CVE-1", "CRITICAL", "linux/arm64"), finding("CVE-2", "CRITICAL", "linux/arm64"), finding("CVE-3", "HIGH", "linux/amd64")];
	expect(rescanEntry({ ...scanned, findings }, at(day)).critical).toEqual(["CVE-1", "CVE-2"]);
	expect(() => rescanEntry({ ...scanned, pinnedAt: "" }, at(day))).toThrow(ImageError);
});

test("tests take the pinned image only for the images listed, by name", async () => {
	const images = await loadImages();
	const choices = (value: string | undefined) => [pinnedForTest(value, images, "sandbox"), pinnedForTest(value, images, "gateway")];
	expect(choices(undefined)).toEqual([undefined, undefined]);
	expect(choices("")).toEqual([undefined, undefined]);
	expect(choices("sandbox")).toEqual([pinnedReference(images, "sandbox"), undefined]);
	expect(choices("gateway")).toEqual([undefined, pinnedReference(images, "gateway")]);
	expect(choices("sandbox,gateway")).toEqual([pinnedReference(images, "sandbox"), pinnedReference(images, "gateway")]);
	expect(() => pinnedForTest("pinned", images, "sandbox")).toThrow(/lists "pinned"/);
	expect(() => pinnedForTest("sandbox,", images, "sandbox")).toThrow(ImageError);
});
