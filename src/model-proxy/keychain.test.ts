import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dlopen, ptr } from "bun:ffi";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkKeyAccess, KeychainError, readKey } from "./keychain";

/**
 * Each test works on a throwaway keychain file, never the login keychain. The
 * `security` CLI only builds fixtures; the module under test never uses it.
 */

/** Unlocks the throwaway keychain; random, so no fixed secret sits in source. */
const UNLOCK = crypto.randomUUID();
let dir = "";
let keychain = "";

function security(...args: string[]): void {
	const result = Bun.spawnSync(["security", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 20_000 });
	if (result.exitCode !== 0) throw new Error(`security ${args[0]} failed: ${result.stderr.toString()}`);
}

/**
 * Adds an item whose read entries trust no application and require the
 * keychain password, which the `security` CLI cannot do. Changing an existing
 * item's access (SecKeychainItemSetAccess) shows a prompt even with user
 * interaction off, so the item is created with its access already set:
 * SecAccessCreate with an empty trusted list, SecACLSetContents on its decrypt
 * entries, then SecKeychainItemCreateFromContent.
 *
 * securityd stores the prompt flags in host byte order but reads them back as
 * network order (KeychainPromptAclSubject::exportBlob byte-swaps the selector
 * in place on both of ObjectAcl::exportBlob's passes, and importBlob swaps it
 * once), so a stored item reports the flags byte-swapped: asking for 0x0001
 * yields 0x0100, which does not require the password. Asking for 0x0100 yields
 * kSecKeychainPromptRequirePassphase (0x0001), which securityd then enforces.
 */
function addPasswordProtectedItem(path: string, service: string, secret: string): void {
	const cf = dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", {
		CFRelease: { args: ["u64"], returns: "void" },
		CFArrayCreate: { args: ["ptr", "ptr", "i64", "ptr"], returns: "u64" },
		CFArrayGetCount: { args: ["u64"], returns: "i64" },
		CFArrayGetValueAtIndex: { args: ["u64", "i64"], returns: "u64" },
		CFStringCreateWithCString: { args: ["ptr", "ptr", "u32"], returns: "u64" },
	}).symbols;
	const sec = dlopen("/System/Library/Frameworks/Security.framework/Security", {
		SecKeychainOpen: { args: ["ptr", "ptr"], returns: "i32" },
		SecAccessCreate: { args: ["u64", "u64", "ptr"], returns: "i32" },
		SecAccessCopyMatchingACLList: { args: ["u64", "u64"], returns: "u64" },
		SecACLCopyContents: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
		SecACLSetContents: { args: ["u64", "u64", "u64", "u16"], returns: "i32" },
		SecKeychainItemCreateFromContent: { args: ["u32", "ptr", "u32", "ptr", "u64", "u64", "ptr"], returns: "i32" },
		SecKeychainSetUserInteractionAllowed: { args: ["bool"], returns: "i32" },
	}).symbols;
	const owned: bigint[] = [];
	const created = (out: BigUint64Array): bigint => {
		const ref = out[0] ?? 0n;
		if (ref !== 0n) owned.push(ref);
		return ref;
	};
	const ok = (status: number, call: string): void => {
		if (status !== 0) throw new Error(`${call} failed with OSStatus ${status}`);
	};
	const cfString = (text: string): bigint => {
		const ref = cf.CFStringCreateWithCString(null, Buffer.from(`${text}\0`), 0x08000100);
		owned.push(ref);
		return ref;
	};
	// With user interaction off, a call that would prompt fails instead of waiting.
	sec.SecKeychainSetUserInteractionAllowed(false);
	try {
		const keychainOut = new BigUint64Array(1);
		ok(sec.SecKeychainOpen(Buffer.from(`${path}\0`), keychainOut), "SecKeychainOpen");
		const keychainRef = created(keychainOut);
		const empty = cf.CFArrayCreate(null, null, 0, null);
		owned.push(empty);
		const accessOut = new BigUint64Array(1);
		ok(sec.SecAccessCreate(cfString(service), empty, accessOut), "SecAccessCreate");
		const access = created(accessOut);
		const acls = sec.SecAccessCopyMatchingACLList(access, cfString("ACLAuthorizationDecrypt"));
		owned.push(acls);
		const count = Number(cf.CFArrayGetCount(acls));
		if (count === 0) throw new Error("the new access has no decrypt entry");
		for (let index = 0; index < count; index++) {
			const acl = cf.CFArrayGetValueAtIndex(acls, index);
			const apps = new BigUint64Array(1);
			const description = new BigUint64Array(1);
			ok(sec.SecACLCopyContents(acl, apps, description, new Uint16Array(1)), "SecACLCopyContents");
			created(apps);
			// 0x0100 is stored and read back as 0x0001 (see above).
			ok(sec.SecACLSetContents(acl, empty, created(description), 0x0100), "SecACLSetContents");
		}
		// SecKeychainAttributeList { UInt32 count; SecKeychainAttribute *attr } with
		// SecKeychainAttribute { UInt32 tag; UInt32 length; void *data } for 'svce' and 'acct'.
		const svce = Buffer.from(service);
		const acct = Buffer.from("factory");
		const attributes = new BigUint64Array(4);
		const view = new DataView(attributes.buffer);
		view.setUint32(0, 0x73766365, true);
		view.setUint32(4, svce.length, true);
		attributes[1] = BigInt(ptr(svce));
		view.setUint32(16, 0x61636374, true);
		view.setUint32(20, acct.length, true);
		attributes[3] = BigInt(ptr(acct));
		const list = new BigUint64Array(2);
		new DataView(list.buffer).setUint32(0, 2, true);
		list[1] = BigInt(ptr(attributes));
		const data = Buffer.from(secret);
		const item = new BigUint64Array(1);
		// 0x67656e70 is 'genp', kSecGenericPasswordItemClass.
		ok(sec.SecKeychainItemCreateFromContent(0x67656e70, list, data.length, data, keychainRef, access, item), "SecKeychainItemCreateFromContent");
		created(item);
	} finally {
		for (const ref of owned.reverse()) if (ref !== 0n) cf.CFRelease(ref);
		sec.SecKeychainSetUserInteractionAllowed(true);
	}
}

describe.skipIf(process.platform !== "darwin")("keychain access check", () => {
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "straight-facts-keychain-"));
		keychain = join(dir, "test.keychain");
		security("create-keychain", "-p", UNLOCK, keychain);
		security("unlock-keychain", "-p", UNLOCK, keychain);
		// -A: any application may read without a prompt.
		security("add-generic-password", "-s", "test/any-app", "-a", "factory", "-w", "secret-any", "-A", keychain);
		// Default access: trusts the creating app, /usr/bin/security.
		security("add-generic-password", "-s", "test/default", "-a", "factory", "-w", "secret-default", keychain);
		// -T "": no trusted application, but the prompt is the plain "allow" one.
		security("add-generic-password", "-s", "test/no-apps", "-a", "factory", "-w", "secret-no-apps", "-T", "", keychain);
		addPasswordProtectedItem(keychain, "test/password", "secret-password");
		// A rotated key added beside a protected one; it trusts /usr/bin/security.
		addPasswordProtectedItem(keychain, "test/rotated", "secret-old");
		security("add-generic-password", "-s", "test/rotated", "-a", "rotated", "-w", "secret-new", keychain);
	}, 60_000);

	afterAll(() => {
		if (keychain !== "") security("delete-keychain", keychain);
		if (dir !== "") rmSync(dir, { recursive: true, force: true });
	}, 60_000);

	test("refuses an item any application can read, which reads without a prompt", () => {
		const result = checkKeyAccess({ service: "test/any-app", keychain });
		expect(result.ok).toBe(false);
		const problems = result.ok ? [] : result.problems;
		expect(problems.some(problem => problem.endsWith("trusts any application"))).toBe(true);
		expect(problems.some(problem => problem.includes("does not require the keychain password (prompt selector 0x0000)"))).toBe(true);
		expect(readKey({ service: "test/any-app", account: "factory", keychain })).toBe("secret-any");
	}, 30_000);

	test("refuses an item that trusts the security tool", () => {
		const result = checkKeyAccess({ service: "test/default", account: "factory", keychain });
		expect(result.ok).toBe(false);
		expect(result.ok ? [] : result.problems.filter(problem => problem.endsWith("trusts /usr/bin/security"))).toHaveLength(1);
	}, 30_000);

	test("refuses an item that trusts no application but does not ask for the keychain password", () => {
		const result = checkKeyAccess({ service: "test/no-apps", keychain });
		expect(result.ok).toBe(false);
		const problems = result.ok ? [] : result.problems;
		expect(problems.some(problem => problem.includes(" trusts "))).toBe(false);
		expect(problems.some(problem => problem.includes("does not require the keychain password (prompt selector 0x0000)"))).toBe(true);
	}, 30_000);

	test("accepts an item whose every read asks for the keychain password", () => {
		expect(checkKeyAccess({ service: "test/password", keychain })).toEqual({ ok: true });
	}, 30_000);

	test("refuses a service that more than one item matches, and checks each of them", () => {
		const result = checkKeyAccess({ service: "test/rotated", keychain });
		expect(result.ok).toBe(false);
		const problems = result.ok ? [] : result.problems;
		expect(problems).toContain(`keychain item "test/rotated" in ${keychain}: 2 items match; keep exactly one`);
		expect(problems.some(problem => / item [12] of 2: access entry .* trusts \/usr\/bin\/security$/.test(problem))).toBe(true);
		// Naming the account narrows the match to the protected item alone.
		expect(checkKeyAccess({ service: "test/rotated", account: "factory", keychain })).toEqual({ ok: true });
	}, 30_000);

	test("reports a missing item", () => {
		expect(checkKeyAccess({ service: "test/missing", keychain })).toEqual({
			ok: false,
			problems: [`keychain item "test/missing" in ${keychain}: not found`],
		});
		expect(() => readKey({ service: "test/missing", keychain })).toThrow(KeychainError);
	}, 30_000);
});

describe.skipIf(process.platform === "darwin")("keychain off macOS", () => {
	test("refuses to run", () => {
		expect(() => checkKeyAccess({ service: "test/any" })).toThrow(KeychainError);
		expect(() => readKey({ service: "test/any" })).toThrow(KeychainError);
	});
});
