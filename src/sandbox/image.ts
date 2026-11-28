import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../util/guards";

/**
 * The sandbox image (decision 0002 §1), built from the pins in
 * `images/images.toml`.
 *
 * - `buildSandboxImage` builds it locally for the engine's architecture; the
 *   containment tests run against that build.
 * - `pushArch` and `publishIndex` run only in the publishing workflow on main
 *   (`.github/workflows/sandbox-image.yml`): one native build per architecture,
 *   then a multi-arch index, which the workflow attests.
 *
 * Every image is labelled and tagged with a hash of its inputs (the Dockerfile
 * and the build pins), so an unchanged input set reuses the existing image.
 */

export type Arch = "amd64" | "arm64";

export interface SandboxBuild {
	readonly base: string;
	readonly debianSnapshot: string;
	readonly git: string;
	readonly ompVersion: string;
	readonly ompSha256: Readonly<Record<Arch, string>>;
}

export interface SandboxImages {
	/** Registry repository the publishing workflow pushes to. */
	readonly repository: string;
	readonly build: SandboxBuild;
}

const ROOT = join(import.meta.dir, "../..");
export const IMAGES_PATH = join(ROOT, "images/images.toml");
const CONTEXT = join(ROOT, "images/sandbox");
const SOURCE = "https://github.com/tsontario/straight-facts";
const SHA256 = /^[0-9a-f]{64}$/;

export class ImageError extends Error {
	override readonly name = "ImageError";
}

/** Reads and validates the sandbox entries of the images file. */
export async function loadSandboxImages(path: string = IMAGES_PATH): Promise<SandboxImages> {
	const root: unknown = Bun.TOML.parse(await Bun.file(path).text());
	const sandbox = isRecord(root) ? root.sandbox : undefined;
	if (!isRecord(sandbox) || !isRecord(sandbox.build)) throw new ImageError(`${path}: missing [sandbox] or [sandbox.build]`);
	const { repository } = sandbox;
	const { base, debian_snapshot: debianSnapshot, git, omp_version: ompVersion, omp_sha256: sha } = sandbox.build;
	if (typeof repository !== "string" || !/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(repository)) {
		throw new ImageError(`${path}: sandbox.repository must be a ghcr.io repository`);
	}
	if (typeof base !== "string" || !/^[^@\s]+@sha256:[0-9a-f]{64}$/.test(base)) {
		throw new ImageError(`${path}: sandbox.build.base must be an image reference pinned by @sha256 digest`);
	}
	if (typeof debianSnapshot !== "string" || !/^\d{8}T\d{6}Z$/.test(debianSnapshot)) {
		throw new ImageError(`${path}: sandbox.build.debian_snapshot must be a snapshot.debian.org timestamp (YYYYMMDDThhmmssZ)`);
	}
	if (typeof git !== "string" || !/^[0-9A-Za-z.+:~-]+$/.test(git)) {
		throw new ImageError(`${path}: sandbox.build.git must be a Debian package version`);
	}
	if (typeof ompVersion !== "string" || !/^\d+\.\d+\.\d+$/.test(ompVersion)) {
		throw new ImageError(`${path}: sandbox.build.omp_version must be a release version`);
	}
	const amd64 = isRecord(sha) ? sha.amd64 : undefined;
	const arm64 = isRecord(sha) ? sha.arm64 : undefined;
	if (typeof amd64 !== "string" || !SHA256.test(amd64) || typeof arm64 !== "string" || !SHA256.test(arm64)) {
		throw new ImageError(`${path}: sandbox.build.omp_sha256 needs amd64 and arm64 SHA-256 digests`);
	}
	return { repository, build: { base, debianSnapshot, git, ompVersion, ompSha256: { amd64, arm64 } } };
}

/** A hash of the Dockerfile and the build pins: the same on every architecture. */
async function inputsHash(build: SandboxBuild): Promise<string> {
	const dockerfile = await Bun.file(join(CONTEXT, "Dockerfile")).text();
	return new Bun.CryptoHasher("sha256").update(JSON.stringify({ dockerfile, build })).digest("hex");
}

function buildArgs(build: SandboxBuild, hash: string): string[] {
	return [
		"--build-arg",
		`BASE_IMAGE=${build.base}`,
		"--build-arg",
		`DEBIAN_SNAPSHOT=${build.debianSnapshot}`,
		"--build-arg",
		`GIT_VERSION=${build.git}`,
		"--build-arg",
		`OMP_VERSION=${build.ompVersion}`,
		"--build-arg",
		`OMP_SHA256_AMD64=${build.ompSha256.amd64}`,
		"--build-arg",
		`OMP_SHA256_ARM64=${build.ompSha256.arm64}`,
		"--label",
		`straight-facts.inputs=${hash}`,
		"--label",
		`org.opencontainers.image.source=${SOURCE}`,
		// Plain single-platform manifests, so the published index lists only the two images.
		"--provenance=false",
		"--sbom=false",
	];
}

/** Builds the image locally for the engine's architecture, unless it exists. Returns its tag. */
export async function buildSandboxImage(): Promise<string> {
	const { build } = await loadSandboxImages();
	const hash = await inputsHash(build);
	const tag = `straight-facts/sandbox:${hash.slice(0, 16)}`;
	if ((await exitCode(["docker", "image", "inspect", tag])) === 0) return tag;
	await run(["docker", "build", "--quiet", ...buildArgs(build, hash), "--tag", tag, CONTEXT]);
	return tag;
}

/**
 * Publishing workflow only: whether an index for the current inputs is already
 * published. Merging a pin changes the images file and so triggers the
 * workflow, but must not publish a new digest for the same inputs.
 */
export async function isPublished(): Promise<boolean> {
	const { repository, build } = await loadSandboxImages();
	return (await exitCode(["docker", "buildx", "imagetools", "inspect", `${repository}:${await inputsHash(build)}`])) === 0;
}

/**
 * Publishing workflow only: pushes the locally built image, the one the tests
 * just ran against, as `<repository>:<hash>-<arch>`. Each architecture is built
 * natively, so the engine must be that architecture.
 */
export async function pushArch(arch: Arch): Promise<void> {
	const engine = await dockerArch();
	if (engine !== arch) throw new ImageError(`this engine is ${engine}, not ${arch}: each architecture is built on a native runner`);
	const { repository, build } = await loadSandboxImages();
	const tag = `${repository}:${await inputsHash(build)}-${arch}`;
	await run(["docker", "tag", await buildSandboxImage(), tag]);
	await run(["docker", "push", "--quiet", tag]);
}

/**
 * Publishing workflow only: combines the two architecture images into the
 * index `<repository>:<hash>` and returns its name and digest, which the
 * workflow attests and a pin pull request records.
 */
export async function publishIndex(): Promise<{ name: string; digest: string }> {
	const { repository, build } = await loadSandboxImages();
	const hash = await inputsHash(build);
	const tag = `${repository}:${hash}`;
	await run(["docker", "buildx", "imagetools", "create", "--tag", tag, `${tag}-amd64`, `${tag}-arm64`]);
	const manifest: unknown = JSON.parse(await run(["docker", "buildx", "imagetools", "inspect", tag, "--format", "{{json .Manifest}}"]));
	const digest = isRecord(manifest) ? manifest.digest : undefined;
	const platforms = isRecord(manifest) && Array.isArray(manifest.manifests) ? manifest.manifests.map(platformOf).sort() : [];
	if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new ImageError(`${tag}: no index digest`);
	if (platforms.join(",") !== "linux/amd64,linux/arm64") throw new ImageError(`${tag}: index lists ${platforms.join(", ")}`);
	return { name: repository, digest };
}

function platformOf(descriptor: unknown): string {
	const platform = isRecord(descriptor) ? descriptor.platform : undefined;
	return isRecord(platform) ? `${String(platform.os)}/${String(platform.architecture)}` : "unknown";
}

async function dockerArch(): Promise<Arch> {
	const arch = (await run(["docker", "version", "--format", "{{.Server.Arch}}"])).trim();
	if (arch !== "amd64" && arch !== "arm64") throw new ImageError(`unsupported Docker engine architecture: ${arch}`);
	return arch;
}

async function exitCode(cmd: string[]): Promise<number> {
	const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
	return await proc.exited;
}

async function run(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	if (code !== 0) throw new ImageError(`${cmd.slice(0, 3).join(" ")} failed (exit ${code}): ${stderr.trim()}`);
	return stdout;
}

if (import.meta.main) {
	const [command, arg] = process.argv.slice(2);
	if (command === "published") {
		const published = await isPublished();
		console.log(`published=${published}`);
		if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `published=${published}\n`);
	} else if (command === "push" && (arg === "amd64" || arg === "arm64")) {
		await pushArch(arg);
	} else if (command === "publish-index") {
		const { name, digest } = await publishIndex();
		console.log(`${name}@${digest}`);
		if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `name=${name}\ndigest=${digest}\n`);
	} else {
		console.error("usage: bun src/sandbox/image.ts published | push <amd64|arm64> | publish-index");
		process.exit(2);
	}
}
