import { dlopen, ptr, toArrayBuffer } from "bun:ffi";

/**
 * Reads the Anthropic key from a macOS keychain item through Security.framework
 * (decision 0002 §3, "Key"), and checks the item's access control without
 * reading the key. Every read of the key must show the keychain password
 * prompt: each access entry that allows reading the secret must trust no
 * application and carry the "require keychain password" prompt flag.
 *
 * These are the file-based keychain APIs (`SecKeychain*`, `SecAccess*`,
 * `SecACL*`). Apple deprecated them, but only they expose an item's access
 * control, and the login keychain is a file-based keychain.
 */

export interface KeychainItem {
	/** Generic-password service, e.g. "straight-facts/anthropic". */
	readonly service: string;
	/** Optional account; omit to match any. */
	readonly account?: string;
	/** Absolute path to a keychain file; omit for the default (login) search list. */
	readonly keychain?: string;
}

export type AccessCheck = { readonly ok: true } | { readonly ok: false; readonly problems: readonly string[] };

export class KeychainError extends Error {
	override readonly name = "KeychainError";
}

const errSecItemNotFound = -25300;
const errSecInteractionNotAllowed = -25308;
/** `kSecKeychainPromptRequirePassphase`: the prompt asks for the keychain password. */
const PROMPT_REQUIRE_PASSPHRASE = 0x0001;
/** Authorizations that allow reading the secret, or exporting it. */
const READ_AUTHORIZATIONS = ["ACLAuthorizationDecrypt", "ACLAuthorizationAny", "ACLAuthorizationExportClear", "ACLAuthorizationExportWrapped"];
/** `kSecGenericPasswordItemClass`, 'genp'. */
const GENERIC_PASSWORD_CLASS = 0x67656e70;
/** `kSecServiceItemAttr` ('svce') and `kSecAccountItemAttr` ('acct'). */
const SERVICE_ATTRIBUTE = 0x73766365;
const ACCOUNT_ATTRIBUTE = 0x61636374;
const kCFStringEncodingUTF8 = 0x08000100;

/**
 * A CoreFoundation object reference; 0n is NULL. References are passed as
 * u64, not `ptr`, because CF uses tagged pointers (such as short CFStrings)
 * whose high bits a JavaScript number would lose.
 */
type Ref = bigint;

const CF_SYMBOLS = {
	// void CFRelease(CFTypeRef)
	CFRelease: { args: ["u64"], returns: "void" },
	// CFIndex CFArrayGetCount(CFArrayRef)
	CFArrayGetCount: { args: ["u64"], returns: "i64" },
	// const void *CFArrayGetValueAtIndex(CFArrayRef, CFIndex): borrowed, not released.
	CFArrayGetValueAtIndex: { args: ["u64", "i64"], returns: "u64" },
	// CFIndex CFStringGetLength(CFStringRef): in UTF-16 units.
	CFStringGetLength: { args: ["u64"], returns: "i64" },
	// CFIndex CFStringGetMaximumSizeForEncoding(CFIndex length, CFStringEncoding)
	CFStringGetMaximumSizeForEncoding: { args: ["i64", "u32"], returns: "i64" },
	// Boolean CFStringGetCString(CFStringRef, char *buffer, CFIndex size, CFStringEncoding)
	CFStringGetCString: { args: ["u64", "ptr", "i64", "u32"], returns: "bool" },
	// CFIndex CFDataGetLength(CFDataRef)
	CFDataGetLength: { args: ["u64"], returns: "i64" },
	// const UInt8 *CFDataGetBytePtr(CFDataRef)
	CFDataGetBytePtr: { args: ["u64"], returns: "u64" },
} as const;

const SECURITY_SYMBOLS = {
	// OSStatus SecKeychainOpen(const char *path, SecKeychainRef *out): never prompts, even if the file is missing.
	SecKeychainOpen: { args: ["ptr", "ptr"], returns: "i32" },
	// OSStatus SecKeychainFindGenericPassword(CFTypeRef keychainOrArray, UInt32 serviceLength,
	//   const char *service, UInt32 accountLength, const char *account, UInt32 *passwordLength,
	//   void **passwordData, SecKeychainItemRef *item): finds the first match and decrypts it.
	SecKeychainFindGenericPassword: { args: ["u64", "u32", "ptr", "u32", "ptr", "ptr", "ptr", "ptr"], returns: "i32" },
	// OSStatus SecKeychainSearchCreateFromAttributes(CFTypeRef keychainOrArray, SecItemClass,
	//   const SecKeychainAttributeList *, SecKeychainSearchRef *out)
	SecKeychainSearchCreateFromAttributes: { args: ["u64", "u32", "ptr", "ptr"], returns: "i32" },
	// OSStatus SecKeychainSearchCopyNext(SecKeychainSearchRef, SecKeychainItemRef *out):
	// errSecItemNotFound once the search is exhausted.
	SecKeychainSearchCopyNext: { args: ["u64", "ptr"], returns: "i32" },
	// OSStatus SecKeychainItemFreeContent(SecKeychainAttributeList *, void *data)
	SecKeychainItemFreeContent: { args: ["ptr", "u64"], returns: "i32" },
	// OSStatus SecKeychainItemCopyAccess(SecKeychainItemRef, SecAccessRef *out)
	SecKeychainItemCopyAccess: { args: ["u64", "ptr"], returns: "i32" },
	// OSStatus SecAccessCopyACLList(SecAccessRef, CFArrayRef *out): an array of SecACLRef.
	SecAccessCopyACLList: { args: ["u64", "ptr"], returns: "i32" },
	// OSStatus SecACLCopyContents(SecACLRef, CFArrayRef *applicationList, CFStringRef *description,
	//   SecKeychainPromptSelector *prompt). A NULL application list means any application.
	SecACLCopyContents: { args: ["u64", "ptr", "ptr", "ptr"], returns: "i32" },
	// CFArrayRef SecACLCopyAuthorizations(SecACLRef): CFStrings such as "ACLAuthorizationDecrypt".
	SecACLCopyAuthorizations: { args: ["u64"], returns: "u64" },
	// OSStatus SecTrustedApplicationCopyData(SecTrustedApplicationRef, CFDataRef *out): the app's path.
	SecTrustedApplicationCopyData: { args: ["u64", "ptr"], returns: "i32" },
	// OSStatus SecKeychainGetUserInteractionAllowed(Boolean *state)
	SecKeychainGetUserInteractionAllowed: { args: ["ptr"], returns: "i32" },
	// OSStatus SecKeychainSetUserInteractionAllowed(Boolean state): process-wide.
	SecKeychainSetUserInteractionAllowed: { args: ["bool"], returns: "i32" },
} as const;

interface Frameworks {
	readonly cf: ReturnType<typeof dlopen<typeof CF_SYMBOLS>>["symbols"];
	readonly sec: ReturnType<typeof dlopen<typeof SECURITY_SYMBOLS>>["symbols"];
}

let frameworks: Frameworks | undefined;

/** Opens the two frameworks on first use, so this module loads on any platform. */
function lib(): Frameworks {
	if (process.platform !== "darwin") throw new KeychainError(`the keychain is only available on macOS, not ${process.platform}`);
	frameworks ??= {
		cf: dlopen("/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation", CF_SYMBOLS).symbols,
		sec: dlopen("/System/Library/Frameworks/Security.framework/Security", SECURITY_SYMBOLS).symbols,
	};
	return frameworks;
}

/** Reads only the item's access control, never its secret, and never prompts. */
export function checkKeyAccess(item: KeychainItem): AccessCheck {
	const { cf, sec } = lib();
	// Turn off keychain UI for this process while checking, so a locked keychain
	// fails with errSecInteractionNotAllowed instead of asking to be unlocked.
	const allowed = new Uint8Array(1);
	check(sec.SecKeychainGetUserInteractionAllowed(allowed), "SecKeychainGetUserInteractionAllowed");
	check(sec.SecKeychainSetUserInteractionAllowed(false), "SecKeychainSetUserInteractionAllowed");
	const owned: Ref[] = [];
	try {
		const found = findItems(item, openKeychain(item, owned), owned);
		if (found === errSecInteractionNotAllowed) return { ok: false, problems: [`${describe(item)}: the keychain is locked`] };
		if (typeof found === "number") throw new KeychainError(`searching the keychain failed with OSStatus ${found}`);
		if (found.length === 0) return { ok: false, problems: [`${describe(item)}: not found`] };
		// Every matching item is checked, so a second one (say, a rotated key that
		// trusts /usr/bin/security) cannot sit unchecked behind the first.
		const problems = found.length > 1 ? [`${found.length} items match; keep exactly one`] : [];
		found.forEach((ref, index) => {
			const which = found.length > 1 ? `item ${index + 1} of ${found.length}: ` : "";
			problems.push(...accessProblems(ref, owned).map(problem => `${which}${problem}`));
		});
		return problems.length === 0 ? { ok: true } : { ok: false, problems: problems.map(problem => `${describe(item)}: ${problem}`) };
	} finally {
		for (const ref of owned.reverse()) cf.CFRelease(ref);
		sec.SecKeychainSetUserInteractionAllowed(allowed[0] !== 0);
	}
}

/** Reads the secret (this may show the keychain password prompt). Throws KeychainError if absent. */
export function readKey(item: KeychainItem): string {
	const { cf, sec } = lib();
	const owned: Ref[] = [];
	try {
		const service = Buffer.from(item.service, "utf8");
		const account = item.account === undefined ? null : Buffer.from(item.account, "utf8");
		const length = new Uint32Array(1);
		const data = new BigUint64Array(1);
		const ref = new BigUint64Array(1);
		// Asking for the data decrypts the secret, which may prompt.
		const status = sec.SecKeychainFindGenericPassword(
			openKeychain(item, owned),
			service.length,
			service,
			account?.length ?? 0,
			account,
			length,
			data,
			ref,
		);
		if (status === errSecItemNotFound) throw new KeychainError(`${describe(item)}: not found`);
		check(status, "SecKeychainFindGenericPassword");
		own(ref, owned);
		const secret = data[0] ?? 0n;
		if (secret === 0n) throw new KeychainError("SecKeychainFindGenericPassword returned no data");
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(toArrayBuffer(secret, 0, length[0] ?? 0));
		} finally {
			sec.SecKeychainItemFreeContent(null, secret);
		}
	} finally {
		for (const ref of owned.reverse()) cf.CFRelease(ref);
	}
}

/** The keychain at `item.keychain`, opened with SecKeychainOpen, or 0n (NULL) for the default search list. */
function openKeychain(item: KeychainItem, owned: Ref[]): Ref {
	if (item.keychain === undefined) return 0n;
	const out = new BigUint64Array(1);
	check(lib().sec.SecKeychainOpen(Buffer.from(`${item.keychain}\0`, "utf8"), out), "SecKeychainOpen");
	return own(out, owned);
}

/**
 * Every generic password matching the service (and the account, if given),
 * found with SecKeychainSearchCreateFromAttributes and SecKeychainSearchCopyNext.
 * The search matches attributes only, so it never decrypts. Returns the
 * OSStatus on failure.
 */
function findItems(item: KeychainItem, keychain: Ref, owned: Ref[]): Ref[] | number {
	const { sec } = lib();
	const values = [{ tag: SERVICE_ATTRIBUTE, data: Buffer.from(item.service, "utf8") }];
	if (item.account !== undefined) values.push({ tag: ACCOUNT_ATTRIBUTE, data: Buffer.from(item.account, "utf8") });
	// SecKeychainAttribute { UInt32 tag; UInt32 length; void *data }: 16 bytes each.
	const attributes = new BigUint64Array(values.length * 2);
	const view = new DataView(attributes.buffer);
	values.forEach(({ tag, data }, index) => {
		view.setUint32(index * 16, tag, true);
		view.setUint32(index * 16 + 4, data.length, true);
		attributes[index * 2 + 1] = BigInt(ptr(data));
	});
	// SecKeychainAttributeList { UInt32 count; SecKeychainAttribute *attr }: 16 bytes.
	const list = new BigUint64Array(2);
	new DataView(list.buffer).setUint32(0, values.length, true);
	list[1] = BigInt(ptr(attributes));
	const search = new BigUint64Array(1);
	const status = sec.SecKeychainSearchCreateFromAttributes(keychain, GENERIC_PASSWORD_CLASS, list, search);
	if (status !== 0) return status;
	const searchRef = own(search, owned);
	const items: Ref[] = [];
	for (;;) {
		const next = new BigUint64Array(1);
		const status = sec.SecKeychainSearchCopyNext(searchRef, next);
		if (status === errSecItemNotFound) return items;
		if (status !== 0) return status;
		items.push(own(next, owned));
	}
}

/**
 * Problems with one item's access entries: each entry that allows reading the
 * secret must trust no application and require the keychain password.
 */
function accessProblems(item: Ref, owned: Ref[]): string[] {
	const { cf, sec } = lib();
	const access = new BigUint64Array(1);
	check(sec.SecKeychainItemCopyAccess(item, access), "SecKeychainItemCopyAccess");
	const list = new BigUint64Array(1);
	check(sec.SecAccessCopyACLList(own(access, owned), list), "SecAccessCopyACLList");
	const problems: string[] = [];
	arrayOf(own(list, owned)).forEach((acl, index) => {
		const authorizations = sec.SecACLCopyAuthorizations(acl);
		if (authorizations === 0n) throw new KeychainError("SecACLCopyAuthorizations failed");
		owned.push(authorizations);
		const names = arrayOf(authorizations).map(stringOf);
		if (!names.some(name => READ_AUTHORIZATIONS.includes(name))) return;
		const apps = new BigUint64Array(1);
		const description = new BigUint64Array(1);
		const prompt = new Uint16Array(1);
		check(sec.SecACLCopyContents(acl, apps, description, prompt), "SecACLCopyContents");
		const appList = own(apps, owned);
		const label = own(description, owned);
		const entry = `access entry ${index} (${label === 0n ? "no description" : JSON.stringify(stringOf(label))}; ${names.join(", ")})`;
		if (appList === 0n) problems.push(`${entry} trusts any application`);
		else if (Number(cf.CFArrayGetCount(appList)) > 0) problems.push(`${entry} trusts ${appPaths(appList, owned).join(", ")}`);
		const selector = prompt[0] ?? 0;
		if ((selector & PROMPT_REQUIRE_PASSPHRASE) === 0) {
			problems.push(`${entry} does not require the keychain password (prompt selector 0x${selector.toString(16).padStart(4, "0")})`);
		}
	});
	return problems;
}

/** Paths of the SecTrustedApplicationRefs in an access entry's application list. */
function appPaths(appList: Ref, owned: Ref[]): string[] {
	const { cf, sec } = lib();
	return arrayOf(appList).map(app => {
		const out = new BigUint64Array(1);
		check(sec.SecTrustedApplicationCopyData(app, out), "SecTrustedApplicationCopyData");
		const data = own(out, owned);
		// The data is the application's path, NUL-terminated.
		const bytes = toArrayBuffer(cf.CFDataGetBytePtr(data), 0, Number(cf.CFDataGetLength(data)));
		return new TextDecoder().decode(bytes).replace(/\0+$/, "");
	});
}

/** The elements of a CFArray, borrowed from it. */
function arrayOf(array: Ref): Ref[] {
	const { cf } = lib();
	return Array.from({ length: Number(cf.CFArrayGetCount(array)) }, (_, index) => cf.CFArrayGetValueAtIndex(array, index));
}

/** Copies a CFString out as UTF-8 with CFStringGetCString. */
function stringOf(string: Ref): string {
	const { cf } = lib();
	const size = Number(cf.CFStringGetMaximumSizeForEncoding(cf.CFStringGetLength(string), kCFStringEncodingUTF8)) + 1;
	const buffer = new Uint8Array(size);
	if (!cf.CFStringGetCString(string, buffer, size, kCFStringEncodingUTF8)) throw new KeychainError("CFStringGetCString failed");
	return new TextDecoder().decode(buffer.subarray(0, buffer.indexOf(0)));
}

/** Takes ownership of the reference a Copy call wrote to `out`, to release later. 0n (NULL) is not recorded. */
function own(out: BigUint64Array, owned: Ref[]): Ref {
	const ref = out[0] ?? 0n;
	if (ref !== 0n) owned.push(ref);
	return ref;
}

function check(status: number, call: string): void {
	if (status !== 0) throw new KeychainError(`${call} failed with OSStatus ${status}`);
}

function describe(item: KeychainItem): string {
	const account = item.account === undefined ? "" : ` (account ${JSON.stringify(item.account)})`;
	const keychain = item.keychain === undefined ? "" : ` in ${item.keychain}`;
	return `keychain item ${JSON.stringify(item.service)}${account}${keychain}`;
}
