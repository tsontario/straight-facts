import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-log/event-log";
import { writeHaltFile } from "../halt/halt";
import { testImage } from "../images/images";
import { startTaskNetwork } from "./network";

test("refuses a halt directory that is relative, unnormalized, or could add mount options", async () => {
	const spec = { taskId: "t-1", laneId: "lane-0001", repo: "a/b", profile: { name: "none", hosts: [], methods: [], readOnly: [] } };
	for (const haltDir of ["halt", "/state/../halt", "/state/./halt", "/state/halt,target=/etc", "/state/halt\n"]) {
		await expect(startTaskNetwork("img", { ...spec, haltDir })).rejects.toThrow(/^haltDir must be/);
	}
});

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
if (process.env.CI && !dockerAvailable) throw new Error("Docker is required for the task network tests in CI");

describe.skipIf(!dockerAvailable)("startTaskNetwork", () => {
	test("on failure removes only what it created, never a container that already held a name", async () => {
		const taskId = `net-${process.pid}`;
		const [sandboxImage, gatewayImage] = await Promise.all([testImage("sandbox"), testImage("gateway")]);
		// Another container already holds the gateway's name, so creating the gateway fails.
		const squatter = Bun.spawnSync(["docker", "create", "--name", `sf-gateway-${taskId}`, sandboxImage, "true"]).stdout.toString().trim();
		const stateDir = mkdtempSync(join(tmpdir(), "sf-net-state-"));
		try {
			const haltDir = join(stateDir, "halt");
			await writeHaltFile({ log: EventLog.open(":memory:"), approvers: new Set(), haltDir });
			const started = startTaskNetwork(gatewayImage, {
				taskId,
				laneId: "lane-0001",
				repo: "tsontario/straight-facts",
				profile: { name: "none", hosts: [], methods: [], readOnly: [] },
				haltDir,
			});
			await expect(started).rejects.toThrow(/already in use/);
			expect(Bun.spawnSync(["docker", "container", "inspect", squatter]).exitCode).toBe(0);
			const networks = Bun.spawnSync(["docker", "network", "ls", "--quiet", "--filter", `label=straight-facts.task=${taskId}`]).stdout.toString().trim();
			expect(networks).toBe("");
		} finally {
			Bun.spawnSync(["docker", "rm", "--force", squatter]);
			rmSync(stateDir, { recursive: true, force: true });
		}
	}, 600_000);
});
