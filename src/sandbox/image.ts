import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../util/guards";

/**
 * The sandbox image (decision 0002 §1 and §6), built from the pins in
 * `images/images.toml`.
 *
 * - `buildSandboxImage` builds it locally for the engine's architecture; the
 *   containment tests run against that build.
 * - `isPublished`, `pushArch` and `publishIndex` run only in the publishing
 *   workflow on main (`.github/workflows/images.yml`): one native build
 *   per architecture, tested and scanned, then a multi-arch index, which the
 *   workflow attests.
 *
 * Every image is labelled and tagged with a hash of its inputs: the build pins,
 * the build arguments, and every file in the build context.
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
	/** The Trivy image that scans each build before it is pushed. */
	readonly trivy: string;
}

const ROOT = join(import.meta.dir, "../..");
export const IMAGES_PATH = join(ROOT, "images/images.toml");
const CONTEXT = join(ROOT, "images/sandbox");
const SOURCE_REPO = "tsontario/straight-facts";
const PUBLISHING_WORKFLOW = `${SOURCE_REPO}/.github/workflows/images.yml`;
const SHA256 = /^[0-9a-f]{64}$/;
const PINNED_IMAGE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;

export class ImageError extends Error {
	override readonly name = "ImageError";
}

/** Reads and validates the sandbox entries of the images file. */
export async function loadSandboxImages(path: string = IMAGES_PATH): Promise<SandboxImages> {
	const root: unknown = Bun.TOML.parse(await Bun.file(path).text());
	const sandbox = isRecord(root) ? root.sandbox : undefined;
	const tools = isRecord(root) ? root.tools : undefined;
	if (!isRecord(sandbox) || !isRecord(sandbox.build)) throw new ImageError(`${path}: missing [sandbox] or [sandbox.build]`);
	const { repository } = sandbox;
	const { base, debian_snapshot: debianSnapshot, git, omp_version: ompVersion, omp_sha256: sha } = sandbox.build;
	const trivy = isRecord(tools) ? tools.trivy : undefined;
	if (typeof repository !== "string" || !/^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._-]+$/.test(repository)) {
		throw new ImageError(`${path}: sandbox.repository must be a ghcr.io repository`);
	}
	if (typeof base !== "string" || !PINNED_IMAGE.test(base)) {
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
	if (typeof trivy !== "string" || !PINNED_IMAGE.test(trivy)) {
		throw new ImageError(`${path}: tools.trivy must be an image reference pinned by @sha256 digest`);
	}
	return { repository, build: { base, debianSnapshot, git, ompVersion, ompSha256: { amd64, arm64 } }, trivy };
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
		`org.opencontainers.image.source=https://github.com/${SOURCE_REPO}`,
		// Plain single-platform manifests, so the published index lists only the two images.
		"--provenance=false",
		"--sbom=false",
	];
}

/** A hash of the build arguments and every file in the build context: the same on every architecture. */
async function inputsHash(build: SandboxBuild): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(JSON.stringify(buildArgs(build, "")));
	const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: CONTEXT, dot: true }))).sort();
	for (const file of files) {
		hasher.update(`\0${file}\0`);
		hasher.update(new Uint8Array(await Bun.file(join(CONTEXT, file)).arrayBuffer()));
	}
	return hasher.digest("hex");
}

/** Builds the image locally for the engine's architecture, unless it exists. Returns its tag. */
export async function buildSandboxImage(): Promise<string> {
	const { build } = await loadSandboxImages();
	const hash = await inputsHash(build);
	const tag = `straight-facts/sandbox:${hash.slice(0, 16)}`;
	if ((await exec(["docker", "image", "inspect", tag])).code === 0) return tag;
	await run(["docker", "build", "--quiet", ...buildArgs(build, hash), "--tag", tag, CONTEXT]);
	return tag;
}

/**
 * Publishing workflow only: whether the index for the current inputs is
 * published and attested by this workflow on main. Merging a pin changes the
 * images file and triggers the workflow, but must not republish the same inputs.
 *
 * Unpublished: no index, or an index that was never attested (a run that
 * failed between pushing and attesting). Any other failure is an error, and so
 * is an attestation that exists but does not verify.
 */
export async function isPublished(): Promise<boolean> {
	const { repository, build } = await loadSandboxImages();
	const tag = `${repository}:${await inputsHash(build)}`;
	const inspect = await exec(["docker", "buildx", "imagetools", "inspect", tag, "--format", "{{json .Manifest}}"]);
	if (inspect.code !== 0) {
		// GHCR answers "denied" rather than "not found" for a package that has never been published.
		if (/not found|manifest unknown|denied|403 Forbidden/i.test(inspect.stderr)) return false;
		throw new ImageError(`inspecting ${tag}: ${inspect.stderr.trim()}`);
	}
	const manifest: unknown = JSON.parse(inspect.stdout);
	const digest = isRecord(manifest) ? manifest.digest : undefined;
	if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new ImageError(`${tag}: no index digest`);
	const lookup = await exec(["gh", "api", `repos/${SOURCE_REPO}/attestations/${digest}`, "--jq", ".attestations | length"]);
	if (lookup.code !== 0 && !/HTTP 404/.test(lookup.stderr)) {
		throw new ImageError(`looking up attestations for ${digest}: ${lookup.stderr.trim()}`);
	}
	if (lookup.code !== 0 || lookup.stdout.trim() === "0") return false;
	await run([
		"gh",
		"attestation",
		"verify",
		`oci://${repository}@${digest}`,
		"--repo",
		SOURCE_REPO,
		"--signer-workflow",
		PUBLISHING_WORKFLOW,
		"--source-ref",
		"refs/heads/main",
		"--deny-self-hosted-runners",
	]);
	return true;
}

/**
 * Publishing workflow only: scans the locally built image, the one the tests
 * just ran against, and pushes it as `<repository>:<hash>-<arch>`. Each
 * architecture is built natively, so the engine must be that architecture.
 */
export async function pushArch(arch: Arch): Promise<void> {
	const engine = await dockerArch();
	if (engine !== arch) throw new ImageError(`this engine is ${engine}, not ${arch}: each architecture is built on a native runner`);
	const { repository, build, trivy } = await loadSandboxImages();
	const local = await buildSandboxImage();
	await scan(local, trivy);
	const tag = `${repository}:${await inputsHash(build)}-${arch}`;
	await run(["docker", "tag", local, tag]);
	await run(["docker", "push", "--quiet", tag]);
}

/**
 * Scans an image with the pinned Trivy and refuses it on any critical finding
 * (decision 0002 §6). Logs every finding's severity and where that severity
 * came from. Trivy reads a saved copy of the image; it gets no Docker socket.
 */
async function scan(image: string, trivy: string): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "sf-scan-"));
	try {
		await run(["docker", "save", "--output", join(dir, "image.tar"), image]);
		const report: unknown = JSON.parse(
			await run([
				"docker",
				"run",
				"--rm",
				"--volume",
				`${dir}:/scan:ro`,
				trivy,
				"image",
				"--quiet",
				"--scanners",
				"vuln",
				"--format",
				"json",
				"--input",
				"/scan/image.tar",
			]),
		);
		// A report with no Debian packages scanned would otherwise pass as clean.
		const results = isRecord(report) && Array.isArray(report.Results) ? report.Results.filter(isRecord) : [];
		const metadata = isRecord(report) ? report.Metadata : undefined;
		const os = isRecord(metadata) ? metadata.OS : undefined;
		if (!isRecord(os) || os.Family !== "debian" || !results.some(result => result.Class === "os-pkgs")) {
			throw new ImageError(`${image}: Trivy found no Debian packages to scan`);
		}
		const findings = results.flatMap(result => (Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities.filter(isRecord) : []));
		// SeveritySource is empty when another vendor's rating was used, so the full map is logged too.
		for (const finding of findings) {
			const fields = [finding.VulnerabilityID, finding.PkgName, finding.Severity, finding.SeveritySource || "(none)"].map(String);
			console.log([...fields, JSON.stringify(finding.VendorSeverity ?? {})].join("\t"));
		}
		const critical = findings.filter(finding => finding.Severity === "CRITICAL").map(finding => String(finding.VulnerabilityID));
		if (critical.length > 0) throw new ImageError(`${image} has critical vulnerabilities: ${critical.join(", ")}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * Publishing workflow only: combines the two architecture images into the
 * index `<repository>:<hash>` and returns its name and digest, which the
 * workflow attests and a pin pull request records.
 */
export async function publishIndex(): Promise<{ name: string; digest: string }> {
	const { repository, build } = await loadSandboxImages();
	const tag = `${repository}:${await inputsHash(build)}`;
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

async function exec(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
	return { code, stdout, stderr };
}

async function run(cmd: string[]): Promise<string> {
	const { code, stdout, stderr } = await exec(cmd);
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
