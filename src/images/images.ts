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
 *   run against that build, and in CI against the pinned image too (`testImage`).
 * - `isPublished`, `pushArch` and `publishIndex` run only in the publishing
 *   workflow on main (`.github/workflows/images.yml`): one native build per
 *   architecture, tested and scanned, then a multi-arch index, which the
 *   workflow attests.
 * - `verifyPins` runs in CI: every pin's attestation, its commit on main, and
 *   whether it was built from the current inputs.
 * - `rescan` runs in the scheduled rescan (`.github/workflows/rescan.yml`): each
 *   pinned image's critical findings and the pin's age.
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

export interface Pin {
	/** The multi-arch index digest, `sha256:<hex>`. */
	readonly digest: string;
	/** The commit on main the publishing workflow built and attested it from. */
	readonly commit: string;
}

/** The images file without its pins: enough to build an image, or to hash its inputs. */
export interface ImageBuilds {
	readonly sandbox: { readonly repository: string; readonly build: SandboxBuild };
	readonly gateway: { readonly repository: string; readonly build: GatewayBuild };
	/** The Trivy image that scans each build before it is pushed, and each pinned image weekly. */
	readonly trivy: string;
}

export interface Images extends ImageBuilds {
	readonly sandbox: ImageBuilds["sandbox"] & { readonly pin: Pin };
	readonly gateway: ImageBuilds["gateway"] & { readonly pin: Pin };
}

const ROOT = join(import.meta.dir, "../..");
export const IMAGES_PATH = join(ROOT, "images/images.toml");
const SOURCE_REPO = "tsontario/straight-facts";
const PUBLISHING_WORKFLOW = `${SOURCE_REPO}/.github/workflows/images.yml`;
const SHA256 = /^[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const PINNED_IMAGE = /^[^@\s]+@sha256:[0-9a-f]{64}$/;
const REPOSITORY = /^ghcr\.io\/[a-z0-9-]+\/[a-z0-9._-]+$/;
/** The label every build carries: the hash of its inputs. */
const INPUTS_LABEL = "straight-facts.inputs";
/** A pin older than this is due for a rebuild (decision 0002 §6). */
const PIN_MAX_AGE_DAYS = 31;
const DAY_MS = 86_400_000;

export class ImageError extends Error {
	override readonly name = "ImageError";
}

/** Reads and validates the images file, pins included. */
export async function loadImages(path: string = IMAGES_PATH): Promise<Images> {
	const root = await readImagesFile(path);
	const builds = buildsIn(root, path);
	return {
		...builds,
		sandbox: { ...builds.sandbox, pin: requiredPin(root, "sandbox", path) },
		gateway: { ...builds.gateway, pin: requiredPin(root, "gateway", path) },
	};
}

async function readImagesFile(path: string): Promise<Record<string, unknown>> {
	const root: unknown = Bun.TOML.parse(await Bun.file(path).text());
	if (!isRecord(root)) throw new ImageError(`${path}: not a table`);
	return root;
}

function buildsIn(root: Record<string, unknown>, path: string): ImageBuilds {
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

/** An image's `[<image>.pin]`, if it is there and well-formed. */
function pinIn(root: Record<string, unknown>, name: ImageName): Pin | undefined {
	const image = root[name];
	const pin = isRecord(image) ? image.pin : undefined;
	const digest = isRecord(pin) ? pin.digest : undefined;
	const commit = isRecord(pin) ? pin.commit : undefined;
	return typeof digest === "string" && DIGEST.test(digest) && typeof commit === "string" && COMMIT.test(commit) ? { digest, commit } : undefined;
}

function requiredPin(root: Record<string, unknown>, name: ImageName, path: string): Pin {
	const pin = pinIn(root, name);
	if (!pin) throw new ImageError(`${path}: [${name}.pin] needs the index digest (sha256:…) and the 40-character commit it was published from`);
	return pin;
}

/** An image's pinned reference, `<repository>@sha256:…`. */
export function pinnedReference(images: Images, name: ImageName): string {
	return `${images[name].repository}@${images[name].pin.digest}`;
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

function recipe(images: ImageBuilds, name: ImageName): Recipe {
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
		`${INPUTS_LABEL}=${hash}`,
		"--label",
		`org.opencontainers.image.source=https://github.com/${SOURCE_REPO}`,
		"--provenance=false",
		"--sbom=false",
	];
}

/** Assembles an image's build context from the checkout at `root` in a temporary directory, hashes it, and runs `use`. */
async function withContext<T>(build: Recipe, use: (context: string, hash: string) => Promise<T>, root: string = ROOT): Promise<T> {
	const context = await mkdtemp(join(tmpdir(), `sf-${build.name}-`));
	try {
		await cp(join(root, build.dockerfileDir), context, { recursive: true });
		for (const source of build.sources) {
			await cp(join(root, source), join(context, source), { recursive: true, filter: path => !path.endsWith(".test.ts") });
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

/** The hash of an image's inputs in the checkout at `root`: by default, this one. */
export async function inputsAt(name: ImageName, root: string = ROOT): Promise<string> {
	const path = join(root, "images/images.toml");
	return withContext(recipe(buildsIn(await readImagesFile(path), path), name), async (_context, hash) => hash, root);
}

/**
 * The pinned reference a test should run against, or undefined to build the image
 * locally from the current inputs. `pinned` is `STRAIGHT_FACTS_TEST_IMAGES`: a
 * comma-separated list of the images to take pinned.
 */
export function pinnedForTest(pinned: string | undefined, images: Images, name: ImageName): string | undefined {
	const names = pinned === undefined || pinned === "" ? [] : pinned.split(",");
	const unknown = names.find(entry => !isImageName(entry));
	if (unknown !== undefined) throw new ImageError(`STRAIGHT_FACTS_TEST_IMAGES lists ${JSON.stringify(unknown)}; it takes image names: ${IMAGE_NAMES.join(", ")}`);
	return names.includes(name) ? pinnedReference(images, name) : undefined;
}

/**
 * The image a test runs against: built locally from the current inputs, or the pinned
 * one, pulled by digest, for the images `STRAIGHT_FACTS_TEST_IMAGES` lists. CI runs
 * each image's tests against both (decision 0002 §6).
 */
export async function testImage(name: ImageName): Promise<string> {
	const reference = pinnedForTest(process.env.STRAIGHT_FACTS_TEST_IMAGES, await loadImages(), name);
	if (reference === undefined) return buildImage(name);
	await run(["docker", "pull", "--quiet", reference]);
	return reference;
}

async function publishedTag(name: ImageName): Promise<{ build: Recipe; tag: string }> {
	const build = recipe(await loadImages(), name);
	return withContext(build, async (_context, hash) => ({ build, tag: `${build.repository}:${hash}` }));
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
	if (typeof digest !== "string" || !DIGEST.test(digest)) throw new ImageError(`${tag}: no index digest`);
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
		const report: unknown = JSON.parse(await run(["docker", "run", "--rm", "--volume", `${dir}:/scan:ro`, trivy, "image", ...TRIVY_SCAN, "--input", "/scan/image.tar"]));
		const findings = findingsOf(report, image);
		for (const finding of findings) console.log(findingLine(finding));
		const critical = criticalOf(findings);
		if (critical.length > 0) throw new ImageError(`${image} has critical vulnerabilities: ${critical.join(", ")}`);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

const TRIVY_SCAN = ["--quiet", "--scanners", "vuln", "--format", "json"];

export interface Finding {
	readonly id: string;
	readonly pkg: string;
	readonly severity: string;
	/** Empty when another vendor's rating was used; `vendorSeverity` shows every vendor's. */
	readonly severitySource: string;
	readonly vendorSeverity: Readonly<Record<string, unknown>>;
}

/**
 * Every finding in a Trivy JSON report, with its severity and where that severity came
 * from. A report that scanned no Debian packages would otherwise pass as clean, so it
 * is refused.
 */
export function findingsOf(report: unknown, image: string): Finding[] {
	const results = isRecord(report) && Array.isArray(report.Results) ? report.Results.filter(isRecord) : [];
	const metadata = isRecord(report) ? report.Metadata : undefined;
	const os = isRecord(metadata) ? metadata.OS : undefined;
	if (!isRecord(os) || os.Family !== "debian" || !results.some(result => result.Class === "os-pkgs")) {
		throw new ImageError(`${image}: Trivy found no Debian packages to scan`);
	}
	return results
		.flatMap(result => (Array.isArray(result.Vulnerabilities) ? result.Vulnerabilities.filter(isRecord) : []))
		.map(finding => ({
			id: String(finding.VulnerabilityID),
			pkg: String(finding.PkgName),
			severity: String(finding.Severity),
			severitySource: typeof finding.SeveritySource === "string" ? finding.SeveritySource : "",
			vendorSeverity: isRecord(finding.VendorSeverity) ? finding.VendorSeverity : {},
		}));
}

function criticalOf(findings: readonly Finding[]): string[] {
	return findings.filter(finding => finding.severity === "CRITICAL").map(finding => finding.id);
}

function findingLine(finding: Finding): string {
	return [finding.id, finding.pkg, finding.severity, finding.severitySource || "(none)", JSON.stringify(finding.vendorSeverity)].join("\t");
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
	if (typeof digest !== "string" || !DIGEST.test(digest)) throw new ImageError(`${tag}: no index digest`);
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

/**
 * The inputs hash a published index's images are labelled with. The index must hold
 * exactly the amd64 and arm64 images, labelled with the same hash. `images` is
 * `docker buildx imagetools inspect --format '{{json .Image}}'`: config by platform.
 */
export function inputsOf(images: unknown, reference: string): string {
	if (!isRecord(images)) throw new ImageError(`${reference}: no image configurations`);
	const platforms = Object.keys(images).sort();
	if (platforms.join(",") !== "linux/amd64,linux/arm64") throw new ImageError(`${reference}: holds ${platforms.join(", ") || "nothing"}, not linux/amd64 and linux/arm64`);
	const hashes = new Set(
		platforms.map(platform => {
			const image = images[platform];
			const config = isRecord(image) ? image.config : undefined;
			const labels = isRecord(config) ? config.Labels : undefined;
			const hash = isRecord(labels) ? labels[INPUTS_LABEL] : undefined;
			return typeof hash === "string" && SHA256.test(hash) ? hash : "";
		}),
	);
	const [hash = ""] = hashes;
	if (hashes.size !== 1 || hash === "") throw new ImageError(`${reference}: its images are not labelled with one inputs hash`);
	return hash;
}

/** The well-formed pins in a version of the images file, to compare with the current one. */
export function pinsAt(text: string): Partial<Record<ImageName, Pin>> {
	const root: unknown = Bun.TOML.parse(text);
	const pins: Partial<Record<ImageName, Pin>> = {};
	if (!isRecord(root)) return pins;
	for (const name of IMAGE_NAMES) {
		const pin = pinIn(root, name);
		if (pin) pins[name] = pin;
	}
	return pins;
}

/** Whether a change sets an image's pin, new or replaced, given the pins on its base. */
export function setsPin(before: Partial<Record<ImageName, Pin>>, name: ImageName, pin: Pin): boolean {
	const prior = before[name];
	return prior?.digest !== pin.digest || prior.commit !== pin.commit;
}

/**
 * Whether a pin is current: built from the current inputs. A pin may lag the inputs,
 * between an inputs pull request and its pin pull request. But a change that sets a
 * pin, new or replaced, must set it to the image built from the inputs on its base,
 * which the change itself leaves alone: one pull request changes an image's inputs,
 * the next pins it (decision 0002 §6). `baseInputs` is the base's inputs hash when the
 * change sets the pin, and undefined otherwise.
 */
export function pinState(name: ImageName, pinnedInputs: string, current: string, baseInputs: string | undefined): "current" | "lagging" {
	if (baseInputs !== undefined && (pinnedInputs !== baseInputs || pinnedInputs !== current)) {
		throw new ImageError(
			`[${name}.pin] is set to an image built from other inputs than ${pinnedInputs === baseInputs ? "this change's" : "its base's"}; pin the image the publishing workflow built from the base's inputs, and change no inputs in the same pull request`,
		);
	}
	return pinnedInputs === current ? "current" : "lagging";
}

/** `gh attestation verify --source-digest` needs gh 2.68.0 or later. */
async function requireGh(): Promise<void> {
	const version = /gh version (\d+)\.(\d+)\.(\d+)/.exec(await run(["gh", "--version"]));
	const [major, minor] = [Number(version?.[1] ?? 0), Number(version?.[2] ?? 0)];
	if (major < 2 || (major === 2 && minor < 68)) throw new ImageError(`verifying pins needs gh 2.68.0 or later, not ${version?.[0] ?? "an unknown version"}`);
}

/**
 * CI: verifies every pin (decision 0002 §6). Each pinned index must carry the
 * publishing workflow's build provenance attestation, from main, for the pinned
 * commit, built on a GitHub-hosted runner; and that commit must be on main. On a pull
 * request, `baseRoot` is a checkout of its base: a pin the change sets must be built
 * from the base's inputs (`pinState`). Returns which pins are current and which lag
 * the inputs; a lagging pin is only reported.
 */
export async function verifyPins(baseRoot: string | undefined): Promise<{ readonly current: readonly ImageName[]; readonly lagging: readonly ImageName[] }> {
	await requireGh();
	const images = await loadImages();
	const before = baseRoot === undefined ? undefined : pinsAt(await Bun.file(join(baseRoot, "images/images.toml")).text());
	const current: ImageName[] = [];
	const lagging: ImageName[] = [];
	for (const name of IMAGE_NAMES) {
		const { pin } = images[name];
		const reference = pinnedReference(images, name);
		await run([
			"gh",
			"attestation",
			"verify",
			`oci://${reference}`,
			"--repo",
			SOURCE_REPO,
			"--signer-workflow",
			PUBLISHING_WORKFLOW,
			"--source-ref",
			"refs/heads/main",
			"--source-digest",
			pin.commit,
			"--deny-self-hosted-runners",
		]);
		// main is ahead of the commit, or is the commit, only when the commit is on main.
		const onMain = (await run(["gh", "api", `repos/${SOURCE_REPO}/compare/${pin.commit}...main`, "--jq", ".status"])).trim();
		if (onMain !== "ahead" && onMain !== "identical") throw new ImageError(`[${name}.pin]: commit ${pin.commit} is not on main`);
		const pinnedInputs = inputsOf(JSON.parse(await run(["docker", "buildx", "imagetools", "inspect", reference, "--format", "{{json .Image}}"])), reference);
		// Only a pin the change sets needs the base's inputs; hashing the base for the others
		// would hold unrelated pull requests to the base's recipe.
		const baseInputs = before !== undefined && baseRoot !== undefined && setsPin(before, name, pin) ? await inputsAt(name, baseRoot) : undefined;
		(pinState(name, pinnedInputs, await inputsAt(name), baseInputs) === "current" ? current : lagging).push(name);
	}
	return { current, lagging };
}

export interface RescanEntry {
	readonly image: ImageName;
	readonly reference: string;
	readonly commit: string;
	/** When the pinned commit was committed to main. */
	readonly pinnedAt: string;
	readonly ageDays: number;
	/** The pin is more than 31 days old, so the image is due for a rebuild. */
	readonly stale: boolean;
	readonly findings: readonly (Finding & { readonly platform: string })[];
	/** The critical findings' ids, on either architecture. */
	readonly critical: readonly string[];
}

export interface RescanReport {
	readonly scannedAt: string;
	readonly trivy: string;
	readonly images: readonly RescanEntry[];
	/** No critical finding and no stale pin. */
	readonly ok: boolean;
}

/** Judges one pinned image's scan and age. */
export function rescanEntry(
	scanned: { image: ImageName; reference: string; commit: string; pinnedAt: string; findings: readonly (Finding & { readonly platform: string })[] },
	now: Date,
): RescanEntry {
	const pinnedAt = Date.parse(scanned.pinnedAt);
	if (Number.isNaN(pinnedAt)) throw new ImageError(`${scanned.reference}: no commit date for ${scanned.commit}`);
	const age = now.getTime() - pinnedAt;
	const critical = [...new Set(criticalOf(scanned.findings))];
	return { ...scanned, ageDays: Math.floor(age / DAY_MS), stale: age > PIN_MAX_AGE_DAYS * DAY_MS, critical };
}

/**
 * The scheduled rescan (decision 0002 §6): scans both architectures of every pinned
 * image with the pinned Trivy, which fetches them from the registry itself, and
 * reports each pin's age. The launcher reads this report before starting a task.
 */
export async function rescan(now: Date = new Date()): Promise<RescanReport> {
	const images = await loadImages();
	const entries: RescanEntry[] = [];
	// One vulnerability database for all four scans, downloaded by the first. A Docker
	// volume, not a host directory: Trivy runs as root, and its files must not be left
	// where the runner's user can't remove them.
	const cache = `sf-trivy-cache-${crypto.randomUUID()}`;
	await run(["docker", "volume", "create", cache]);
	try {
		for (const name of IMAGE_NAMES) {
			const reference = pinnedReference(images, name);
			const { commit } = images[name].pin;
			const pinnedAt = (await run(["gh", "api", `repos/${SOURCE_REPO}/commits/${commit}`, "--jq", ".commit.committer.date"])).trim();
			const findings: (Finding & { platform: string })[] = [];
			for (const arch of ARCHES) {
				const platform = `linux/${arch}`;
				const scanArgs = [...TRIVY_SCAN, "--cache-dir", "/cache", "--image-src", "remote", "--platform", platform, reference];
				const report: unknown = JSON.parse(await run(["docker", "run", "--rm", "--volume", `${cache}:/cache`, images.trivy, "image", ...scanArgs]));
				for (const finding of findingsOf(report, `${reference} (${platform})`)) findings.push({ ...finding, platform });
			}
			entries.push(rescanEntry({ image: name, reference, commit, pinnedAt, findings }, now));
		}
	} finally {
		await exec(["docker", "volume", "rm", "--force", cache]);
	}
	return { scannedAt: now.toISOString(), trivy: images.trivy, images: entries, ok: entries.every(entry => !entry.stale && entry.critical.length === 0) };
}

/** The rescan report as Markdown, for the workflow's summary. */
function rescanSummary(report: RescanReport): string {
	const lines = [`### Rescan of the pinned images: ${report.ok ? "clean" : "action needed"}`, "", "| Image | Pinned | Age (days) | Findings | Critical |", "|---|---|---|---|---|"];
	for (const entry of report.images) {
		lines.push(`| ${entry.image} | \`${entry.reference}\` | ${entry.ageDays}${entry.stale ? " (stale)" : ""} | ${entry.findings.length} | ${entry.critical.join(", ") || "none"} |`);
	}
	return `${lines.join("\n")}\n`;
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
	} else if (command === "verify-pins") {
		// The second argument is a checkout of the pull request's base; it is empty on a push.
		const { current, lagging } = await verifyPins(image === undefined || image === "" ? undefined : image);
		for (const name of lagging) console.log(`::warning title=Pin lags its inputs::[${name}.pin] was not built from the current inputs; pin the next published image.`);
		const all = await loadImages();
		await output({ current: current.join(","), lagging: lagging.join(","), tests: IMAGE_NAMES.map(name => recipe(all, name).tests).join(" ") });
	} else if (command === "rescan" && image !== undefined) {
		const report = await rescan();
		await Bun.write(image, `${JSON.stringify(report, null, 2)}\n`);
		for (const entry of report.images) for (const finding of entry.findings) console.log(`${entry.image}\t${finding.platform}\t${findingLine(finding)}`);
		if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, rescanSummary(report));
		if (!report.ok) {
			console.error(rescanSummary(report));
			process.exit(1);
		}
	} else {
		console.error(
			"usage: bun src/images/images.ts unpublished | push <sandbox|gateway> <amd64|arm64> | publish-index <sandbox|gateway> | verify-pins [base-checkout] | rescan <report.json>",
		);
		process.exit(2);
	}
}
