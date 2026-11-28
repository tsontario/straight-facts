import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGES_PATH, ImageError, loadSandboxImages } from "./image";

const dir = mkdtempSync(join(tmpdir(), "sf-images-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function loadVariant(replace: [string, string]): Promise<unknown> {
	const original = await Bun.file(IMAGES_PATH).text();
	if (!original.includes(replace[0])) throw new Error(`fixture text not found: ${replace[0]}`);
	const path = join(dir, `images-${crypto.randomUUID()}.toml`);
	await Bun.write(path, original.replace(replace[0], replace[1]));
	return await loadSandboxImages(path);
}

test("the committed images file is valid", async () => {
	await expect(loadSandboxImages()).resolves.toBeDefined();
});

test("refuses build inputs that are not pinned", async () => {
	// A base image by tag alone, not digest.
	await expect(loadVariant(["-debian@sha256:", "-debian-"])).rejects.toThrow(ImageError);
	// The live Debian mirror instead of a snapshot.
	await expect(loadVariant(['debian_snapshot = "', 'debian_snapshot = "latest'])).rejects.toThrow(ImageError);
	// A missing checksum for one architecture.
	await expect(loadVariant(["arm64 = ", "arm = "])).rejects.toThrow(ImageError);
	// A registry outside ghcr.io.
	await expect(loadVariant(['repository = "ghcr.io/', 'repository = "docker.io/'])).rejects.toThrow(ImageError);
});
