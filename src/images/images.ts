import { appendFile, chmod, cp, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord } from "../util/guards";

/**
 * The factory-built images (decision 0002 §1, §2 and §6), built from the pins in
 * `images/images.toml`: the sandbox, where agent sessions run, and the gateway,
 * each task's only way out.
 *
 * - `buildImage` builds one locally for the engine's architecture; the tests
 *   run against that build.
 * - `isPublished`, `pushArch` and `publishIndex` run only in the publishing
 *   workflow on main (`.github/workflows/images.yml`): one native build per
 *   architecture, tested and scanned, then a multi-arch index, which the
 *   workflow attests.
 *
 * Every image is labelled and tagged with a hash of its inputs: its build
 * arguments and every file in its build context.
 */

export type Arch = "amd64" | "arm64";
export type ImageName = "sandbox" | "gateway";
export const IMAGE_NAMES: readonly ImageName[] = ["sandbox", "gateway"];
const ARCHES: readonly Arch[] = ["amd64", "arm64"];
/** The GitHub-hosted runner that builds each architecture natively. */
const RUNNERS: Record<Arch, string> = { amd64: "ubuntu-24.04", arm64: "ubuntu-24.04-arm" };

export interface SandboxBuild {
	readonly base: string;
	readonly debianSnapshot: string;
	readonly git: string;
	readonly ompVersion: string;
	readonly ompSha256: Readonly<Record<Arch, string>>;
}

export interface GatewayBuild {
	readonly base: string;
}

export interface Images {
	readonly sandbox: { readonly repository: string; readonly build: SandboxBuild };
	readonly gateway: { readonly repository: string; readonly build: GatewayBuild };
	/** The Trivy image that scans each build before it is pushed. */
	readonly trivy: string;
}

const ROOT = join(import.meta.dir, "../..");
export const IMAGES_PATH = join(ROOT, "images/images.toml");
const SOURCE_REPO = "tsontario/straight-facts";
const PUBLISHING_WORKFLOW = `${SOURCE_REPO}/.github/workflows/images.yml`;
const SHA256 = /^[0-9a-f]{64}$/;
const PINNED_IMAGE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._-]+$/;

export class ImageError extends Error {
	override readonly name = "ImageError";
}

/** Reads and validates the images file. */
export async function loadImages(path: string = IMAGES_PATH): Promise<Images> {
	const root: unknown = Bun.TOML.parse(await Bun.file(path).text());
	if (!isRecord(root)) throw new ImageError(`${path}: not a table`);
	const sandbox = section(root, "sandbox", path);
	const gateway = section(root, "gateway", path);
	const { base, debian_snapshot: debianSnapshot, git, omp_version: ompVersion, omp_sha256: sha } = sandbox.build;
	pinned(base, "sandbox.build.base", path);
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
	const gatewayBase = gateway.build.base;
	pinned(gatewayBase, "gateway.build.base", path);
	const trivy = isRecord(root.tools) ? root.tools.trivy : undefined;
	pinned(trivy, "tools.trivy", path);
	return {
		sandbox: { repository: sandbox.repository, build: { base, debianSnapshot, git, ompVersion, ompSha256: { amd64, arm64 } } },
		gateway: { repository: gateway.repository, build: { base: gatewayBase } },
		trivy,
	};
}

function section(root: Record<string, unknown>, name: ImageName, path: string): { repository: string; build: Record<string, unknown> } {
	const value = root[name];
	if (!isRecord(value) || !isRecord(value.build)) throw new ImageError(`${path}: missing [${name}] or [${name}.build]`);
	if (typeof value.repository !== "string" || !REPOSITORY.test(value.repository)) {
		throw new ImageError(`${path}: ${name}.repository must be a ghcr.io repository`);
	}
	return { repository: value.repository, build: value.build };
}

function pinned(value: unknown, where: string, path: string): asserts value is string {
	if (typeof value !== "string" || !PINNED_IMAGE.test(value)) throw new ImageError(`${path}: ${where} must be an image reference pinned by @sha256 digest`);
}

/** How an image is built: its arguments, its Dockerfile's directory, the source directories copied in, and its tests. */
interface Recipe {
	readonly name: ImageName;
	readonly repository: string;
	readonly args: readonly string[];
	readonly dockerfileDir: string;
	/** Repository directories copied into the build context at the same paths, without tests. */
	readonly sources: readonly string[];
	/** The tests the publishing workflow runs against the image before pushing it. */
	readonly tests: string;
}

function recipe(images: Images, name: ImageName): Recipe {
	if (name === "sandbox") {
		const build = images.sandbox.build;
		return {
			name,
			repository: images.sandbox.repository,
			args: buildArgs({
				BASE_IMAGE: build.base,
				DEBIAN_SNAPSHOT: build.debianSnapshot,
				GIT_VERSION: build.git,
				OMP_VERSION: build.ompVersion,
				OMP_SHA256_AMD64: build.ompSha256.amd64,
				OMP_SHA256_ARM64: build.ompSha256.arm64,
			}),
			dockerfileDir: "images/sandbox",
			sources: [],
			tests: "src/sandbox",
		};
	}
	return {
		name,
		repository: images.gateway.repository,
		args: buildArgs({ BASE_IMAGE: images.gateway.build.base }),
		dockerfileDir: "images/gateway",
		sources: ["src/gateway", "src/util"],
		tests: "src/gateway",
	};
}

function buildArgs(values: Record<string, string>): string[] {
	return Object.entries(values).flatMap(([name, value]) => ["--build-arg", `${name}=${value}`]);
}

/** Labels and flags every build gets. Plain single-platform manifests, so a published index lists only the two images. */
function buildFlags(hash: string): string[] {
	return [
		"--label",
		`straight-facts.inputs=${hash}`,
		"--label",
		`org.opencontainers.image.source=https://github.com/${SOURCE_REPO}`,
		"--provenance=false",
		"--sbom=false",
	];
}

/** Assembles an image's build context in a temporary directory, hashes it, and runs `use`. */
async function withContext<T>(build: Recipe, use: (context: string, hash: string) => Promise<T>): Promise<T> {
	const context = await mkdtemp(join(tmpdir(), `sf-${build.name}-`));
	try {
		await cp(join(ROOT, build.dockerfileDir), context, { recursive: true });
		for (const source of build.sources) {
			await cp(join(ROOT, source), join(context, source), { recursive: true, filter: path => !path.endsWith(".test.ts") });
		}
		// The image must not depend on the host's file modes, which the inputs hash doesn't cover:
		// an owner-only source file would build an image its non-root user can't read.
		for (const entry of await Array.fromAsync(new Bun.Glob("**").scan({ cwd: context, dot: true, onlyFiles: false }))) {
			const path = join(context, entry);
			await chmod(path, (await stat(path)).isDirectory() ? 0o755 : 0o644);
		}
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(JSON.stringify([build.args, buildFlags("")]));
		const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: context, dot: true }))).sort();
		for (const file of files) {
			hasher.update(`\0${file}\0`);
			hasher.update(new Uint8Array(await Bun.file(join(context, file)).arrayBuffer()));
		}
		return await use(context, hasher.digest("hex"));
	} finally {
		await rm(context, { recursive: true, force: true });
	}
}

/** Builds an image locally for the engine's architecture, unless it exists. Returns its tag. */
export async function buildImage(name: ImageName): Promise<string> {
	const build = recipe(await loadImages(), name);
	return withContext(build, async (context, hash) => {
		const tag = `straight-facts/${name}:${hash.slice(0, 16)}`;
		if ((await exec(["docker", "image", "inspect", tag])).code === 0) return tag;
		await run(["docker", "build", "--quiet", ...build.args, ...buildFlags(hash), "--tag", tag, context]);
		return tag;
	});
}

async function publishedTag(name: ImageName): Promise<{ build: Recipe; tag: string }> {
	const build = recipe(await loadImages(), name);
	const hash = await withContext(build, async (_context, inputs) => inputs);
	return { build, tag: `${build.repository}:${hash}` };
}

/**
 * Publishing workflow only: whether the index for an image's current inputs is
 * published and attested by this workflow on main. Merging a pin changes the
 * images file and triggers the workflow, but must not republish the same inputs.
 *
 * Unpublished: no index, or an index that was never attested (a run that
 * failed between pushing and attesting). Any other failure is an error, and so
 * is an attestation that exists but does not verify.
 */
export async function isPublished(name: ImageName): Promise<boolean> {
	const { build, tag } = await publishedTag(name);
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
		`oci://${build.repository}@${digest}`,
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
export async function pushArch(name: ImageName, arch: Arch): Promise<void> {
	const engine = await dockerArch();
	if (engine !== arch) throw new ImageError(`this engine is ${engine}, not ${arch}: each architecture is built on a native runner`);
	const local = await buildImage(name);
	await scan(local, (await loadImages()).trivy);
	const { tag } = await publishedTag(name);
	await run(["docker", "tag", local, `${tag}-${arch}`]);
	await run(["docker", "push", "--quiet", `${tag}-${arch}`]);
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
			await run(["docker", "run", "--rm", "--volume", `${dir}:/scan:ro`, trivy, "image", "--quiet", "--scanners", "vuln", "--format", "json", "--input", "/scan/image.tar"]),
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
 * Publishing workflow only: combines an image's two architecture builds into
 * the index `<repository>:<hash>` and returns its name and digest, which the
 * workflow attests and a pin pull request records.
 */
export async function publishIndex(name: ImageName): Promise<{ name: string; digest: string }> {
	const { build, tag } = await publishedTag(name);
	await run(["docker", "buildx", "imagetools", "create", "--tag", tag, `${tag}-amd64`, `${tag}-arm64`]);
	const manifest: unknown = JSON.parse(await run(["docker", "buildx", "imagetools", "inspect", tag, "--format", "{{json .Manifest}}"]));
	const digest = isRecord(manifest) ? manifest.digest : undefined;
	const platforms = isRecord(manifest) && Array.isArray(manifest.manifests) ? manifest.manifests.map(platformOf).sort() : [];
	if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new ImageError(`${tag}: no index digest`);
	if (platforms.join(",") !== "linux/amd64,linux/arm64") throw new ImageError(`${tag}: index lists ${platforms.join(", ")}`);
	return { name: build.repository, digest };
}

/** Publishing workflow only: the images to publish, and one native build per image and architecture. */
export async function unpublished(): Promise<{ images: ImageName[]; builds: { image: ImageName; arch: Arch; runner: string; tests: string }[] }> {
	const images: ImageName[] = [];
	for (const name of IMAGE_NAMES) if (!(await isPublished(name))) images.push(name);
	const all = await loadImages();
	const builds = images.flatMap(image => ARCHES.map(arch => ({ image, arch, runner: RUNNERS[arch], tests: recipe(all, image).tests })));
	return { images, builds };
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

function isImageName(value: string | undefined): value is ImageName {
	return value === "sandbox" || value === "gateway";
}

async function output(values: Record<string, string>): Promise<void> {
	for (const [key, value] of Object.entries(values)) console.log(`${key}=${value}`);
	if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(""));
}

if (import.meta.main) {
	const [command, image, arch] = process.argv.slice(2);
	if (command === "unpublished") {
		const { images, builds } = await unpublished();
		await output({ images: JSON.stringify(images), builds: JSON.stringify(builds) });
	} else if (command === "push" && isImageName(image) && (arch === "amd64" || arch === "arm64")) {
		await pushArch(image, arch);
	} else if (command === "publish-index" && isImageName(image)) {
		const { name, digest } = await publishIndex(image);
		await output({ name, digest });
	} else {
		console.error("usage: bun src/images/images.ts unpublished | push <sandbox|gateway> <amd64|arm64> | publish-index <sandbox|gateway>");
		process.exit(2);
	}
}
