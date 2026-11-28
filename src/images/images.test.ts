import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IMAGES_PATH, ImageError, loadImages } from "./images";

const dir = mkdtempSync(join(tmpdir(), "sf-images-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function loadVariant(replace: [string, string]): Promise<unknown> {
	const original = await Bun.file(IMAGES_PATH).text();
	if (!original.includes(replace[0])) throw new Error(`fixture text not found: ${replace[0]}`);
	const path = join(dir, `images-${crypto.randomUUID()}.toml`);
	await Bun.write(path, original.replace(replace[0], replace[1]));
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
	await expect(loadVariant(["trivy:0.76.2@sha256:", "trivy:0.76.2-"])).rejects.toThrow(ImageError);
});
