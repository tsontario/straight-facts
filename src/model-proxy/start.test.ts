import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLog } from "../event-log/event-log";
import { startModelProxy } from "./start";

/**
 * The model proxy refuses to start with a key that is missing or that some
 * application could read without the password prompt. A throwaway keychain file
 * holds the fixtures; the login keychain is never touched. macOS only.
 */
describe.skipIf(process.platform !== "darwin")("startModelProxy", () => {
	/** Unlocks the throwaway keychain; random, so no fixed secret sits in source. */
	const UNLOCK = crypto.randomUUID();
	let dir = "";
	let keychain = "";
	let log: EventLog;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "sf-start-"));
		keychain = join(dir, "test.keychain-db");
		for (const args of [
			["create-keychain", "-p", UNLOCK, keychain],
			["unlock-keychain", "-p", UNLOCK, keychain],
			// Readable by any application without a prompt: exactly what the proxy must refuse.
			["add-generic-password", "-s", "sf-start-open", "-a", "factory", "-w", "sk-not-a-real-key", "-A", keychain],
		]) {
			const result = Bun.spawnSync(["security", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
			if (result.exitCode !== 0) throw new Error(`security ${args[0]} failed: ${result.stderr.toString()}`);
		}
		log = EventLog.open(join(dir, "events.sqlite"));
	});

	afterAll(() => {
		log?.close();
		Bun.spawnSync(["security", "delete-keychain", keychain], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
		rmSync(dir, { recursive: true, force: true });
	});

	test("refuses a key that any application can read without the password", async () => {
		const started = startModelProxy({ log, hostname: "127.0.0.1", port: 0, item: { service: "sf-start-open", keychain } });
		await expect(started).rejects.toThrow(/trusts any application/);
	});

	test("refuses a missing key", async () => {
		const started = startModelProxy({ log, hostname: "127.0.0.1", port: 0, item: { service: "sf-start-missing", keychain } });
		await expect(started).rejects.toThrow(/not found/);
	});
});
