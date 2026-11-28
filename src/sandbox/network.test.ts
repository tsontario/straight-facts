import { describe, expect, test } from "bun:test";
import { buildImage } from "../images/images";
import { startTaskNetwork } from "./network";

const dockerAvailable = Bun.spawnSync(["docker", "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0;
if (process.env.CI && !dockerAvailable) throw new Error("Docker is required for the task network tests in CI");

describe.skipIf(!dockerAvailable)("startTaskNetwork", () => {
	test("on failure removes only what it created, never a container that already held a name", async () => {
		const taskId = `net-${process.pid}`;
		const [sandboxImage, gatewayImage] = await Promise.all([buildImage("sandbox"), buildImage("gateway")]);
		// Another container already holds the gateway's name, so creating the gateway fails.
		const squatter = Bun.spawnSync(["docker", "create", "--name", `sf-gateway-${taskId}`, sandboxImage, "true"]).stdout.toString().trim();
		try {
			const started = startTaskNetwork(gatewayImage, {
				taskId,
				laneId: "lane-0001",
				repo: "tsontario/straight-facts",
				profile: { name: "none", hosts: [], methods: [], readOnly: [] },
			});
			await expect(started).rejects.toThrow(/already in use/);
			expect(Bun.spawnSync(["docker", "container", "inspect", squatter]).exitCode).toBe(0);
			const networks = Bun.spawnSync(["docker", "network", "ls", "--quiet", "--filter", `label=straight-facts.task=${taskId}`]).stdout.toString().trim();
			expect(networks).toBe("");
		} finally {
			Bun.spawnSync(["docker", "rm", "--force", squatter]);
		}
	}, 600_000);
});
