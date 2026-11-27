import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson, type JsonValue } from "./canonical-json";
import { EventLog, EventLogError, GENESIS_HASH, type EventInput, type LoggedEvent, type VerifyResult } from "./event-log";

let dir: string;
let path: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "event-log-"));
	path = join(dir, "events.db");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const sample: EventInput[] = [
	{ type: "lane.opened", actor: "@tsontario", lane: "lane-0001", payload: { title: "Containment" } },
	{ type: "task.started", actor: "agent-1", lane: "lane-0001", task: "task-1", payload: { kind: "feature" } },
	{ type: "memory.write", actor: "agent-1", lane: "lane-0001", task: "task-1", payload: { text: "ok", tags: ["a", "b"] } },
];

function seeded(): LoggedEvent[] {
	const log = EventLog.open(path);
	for (const input of sample) log.append(input);
	const events = [...log.read()];
	log.close();
	return events;
}

/** Runs SQL against the log file from a separate connection, as an out-of-band writer would. */
function raw(...statements: Array<string | [string, Array<string | number | null>]>): void {
	const db = new Database(path);
	try {
		for (const statement of statements) {
			if (typeof statement === "string") db.run(statement);
			else db.run(statement[0], statement[1]);
		}
	} finally {
		db.close();
	}
}

function hashOf(event: Omit<LoggedEvent, "hash">): string {
	return new Bun.CryptoHasher("sha256").update(canonicalJson(event)).digest("hex");
}

function verifyFile(): VerifyResult {
	const log = EventLog.open(path);
	try {
		return log.verify();
	} finally {
		log.close();
	}
}

const INSERT = "INSERT OR REPLACE INTO events (seq, id, ts, type, actor, lane, task, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

function rowValues(e: LoggedEvent): Array<string | number | null> {
	return [e.seq, e.id, e.ts, e.type, e.actor, e.lane, e.task, canonicalJson(e.payload), e.prevHash, e.hash];
}

describe("EventLog", () => {
	test("appends events in order, chaining each hash to the previous one", () => {
		const log = EventLog.open(path);
		const appended = sample.map(input => log.append(input));
		const read = [...log.read()];

		expect(read.map(e => e.seq)).toEqual([1, 2, 3]);
		expect(read).toEqual(appended);
		expect(read[0]?.prevHash).toBe(GENESIS_HASH);
		expect(read[1]?.prevHash).toBe(read[0]?.hash);
		expect(read[2]?.prevHash).toBe(read[1]?.hash);
		expect(read[2]?.payload).toEqual({ text: "ok", tags: ["a", "b"] });
		expect(log.verify()).toEqual({ ok: true, count: 3 });
		log.close();
	});

	test("keeps events across reopen and continues the chain", () => {
		const first = EventLog.open(path);
		const [a, b] = [first.append(sample[0]!), first.append(sample[1]!)];
		first.close();

		const second = EventLog.open(path);
		const c = second.append(sample[2]!);
		expect([...second.read()].map(e => e.id)).toEqual([a.id, b.id, c.id]);
		expect(c.seq).toBe(3);
		expect(c.prevHash).toBe(b.hash);
		expect(second.verify()).toEqual({ ok: true, count: 3 });
		second.close();
	});

	test("reads from a given sequence number", () => {
		seeded();
		const log = EventLog.open(path);
		expect([...log.read(2)].map(e => e.seq)).toEqual([2, 3]);
		log.close();
	});

	test("the storage refuses UPDATE of any column and DELETE, from any connection", () => {
		seeded();
		expect(() => raw("UPDATE events SET actor = 'someone-else' WHERE seq = 1")).toThrow(/UPDATE refused/);
		expect(() => raw(`UPDATE events SET payload = '{"kind":"bugfix"}' WHERE seq = 2`)).toThrow(/UPDATE refused/);
		expect(() => raw("DELETE FROM events WHERE seq = 3")).toThrow(/DELETE refused/);
		expect(() => raw("DELETE FROM events")).toThrow(/DELETE refused/);
		expect(verifyFile()).toEqual({ ok: true, count: 3 });
	});

	test("the storage refuses INSERT OR REPLACE over an existing event", () => {
		const events = seeded();
		const replaceWith = (changes: Partial<LoggedEvent>): LoggedEvent => {
			const { hash: _stale, ...unhashed } = { ...events[1]!, ...changes };
			return { ...unhashed, hash: hashOf(unhashed) };
		};

		// Same seq and id, rewritten content: caught by the seq check and the id/hash check.
		expect(() => raw([INSERT, rowValues(replaceWith({ actor: "mallory" }))])).toThrow(/INSERT must append/);
		// Same seq, fresh id and hash: only the seq check stands between this and a silent rewrite.
		expect(() => raw([INSERT, rowValues(replaceWith({ id: "evt-fresh", actor: "mallory" }))])).toThrow(/INSERT must append/);
		// Next seq and correctly chained, but reusing seq 2's id to evict it: only the id check catches this.
		expect(() => raw([INSERT, rowValues(replaceWith({ seq: 4, prevHash: events[2]!.hash, actor: "mallory" }))])).toThrow(
			/INSERT must append/,
		);
		// Next seq, but reusing an existing hash to evict that row: caught by the id/hash check.
		expect(() => raw([INSERT, rowValues({ ...replaceWith({ id: "evt-new", seq: 4, prevHash: events[2]!.hash }), hash: events[2]!.hash })])).toThrow(
			/INSERT must append/,
		);
		expect(verifyFile()).toEqual({ ok: true, count: 3 });
	});

	test("the storage refuses an INSERT that skips a sequence number or breaks the chain", () => {
		const events = seeded();
		const next = { seq: 5, id: "evt-x", ts: "2026-11-27T00:00:00.000Z", type: "x.y", actor: "a", lane: null, task: null, payload: {}, prevHash: events[2]!.hash };
		expect(() => raw([INSERT, rowValues({ ...next, hash: hashOf(next) })])).toThrow(/INSERT must append/);

		const unchained = { ...next, seq: 4, prevHash: GENESIS_HASH };
		expect(() => raw([INSERT, rowValues({ ...unchained, hash: hashOf(unchained) })])).toThrow(/INSERT must append/);
	});

	test("verify reports the first event edited with the triggers removed", () => {
		seeded();
		raw("DROP TRIGGER events_no_update", `UPDATE events SET payload = '{"kind":"bugfix"}' WHERE seq = 2`);
		expect(verifyFile()).toEqual({ ok: false, seq: 2, reason: "hash does not match the event's contents" });
	});

	test("verify reports a broken link when an edited event's hash is also rewritten", () => {
		const events = seeded();
		const forged = { ...events[1]!, payload: { kind: "bugfix" } };
		const { hash: _stale, ...unhashed } = forged;
		raw("DROP TRIGGER events_no_update", [
			"UPDATE events SET payload = ?, hash = ? WHERE seq = 2",
			[canonicalJson(forged.payload), hashOf(unhashed)],
		]);
		expect(verifyFile()).toEqual({ ok: false, seq: 3, reason: "prev_hash does not match the previous event's hash" });
	});

	test("verify reports a sequence gap left by an out-of-band insert", () => {
		const events = seeded();
		const skipped = { seq: 5, id: "evt-gap", ts: "2026-11-27T00:00:00.000Z", type: "x.y", actor: "a", lane: null, task: null, payload: {}, prevHash: events[2]!.hash };
		raw("DROP TRIGGER events_append_only", [INSERT, rowValues({ ...skipped, hash: hashOf(skipped) })]);
		expect(verifyFile()).toEqual({ ok: false, seq: 5, reason: "expected seq 4" });
	});

	test("verify reports corrupt or non-canonical payload text instead of throwing", () => {
		const cases: Array<[stored: string, reason: string]> = [
			["not json", "payload is not JSON the log accepts"],
			['{"n":1e999}', "payload is not JSON the log accepts"],
			['{"kind":"evil", "kind" : "feature"}', "payload is not stored in canonical form"],
		];
		for (const [stored, reason] of cases) {
			rmSync(path, { force: true });
			for (const suffix of ["-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
			seeded();
			raw("DROP TRIGGER events_no_update", ["UPDATE events SET payload = ? WHERE seq = 2", [stored]]);
			expect(verifyFile()).toEqual({ ok: false, seq: 2, reason });
		}
	});

	test("hashes the stored payload, so a payload that changes when read still verifies", () => {
		let reads = 0;
		const shifty = {
			get v() {
				reads += 1;
				return reads;
			},
		} as unknown as JsonValue;
		const log = EventLog.open(path);
		const event = log.append({ type: "x.y", actor: "a", payload: shifty });
		const negativeZero = log.append({ type: "x.y", actor: "a", payload: { z: -0 } });

		expect(event.payload).toEqual({ v: 1 });
		expect(negativeZero.payload).toEqual({ z: 0 });
		expect(log.verify()).toEqual({ ok: true, count: 2 });
		log.close();
	});

	test("identical inputs with the same clock and ids produce identical hashes", () => {
		const run = (): string[] => {
			let n = 0;
			const log = EventLog.open(path, { now: () => new Date("2026-11-27T12:00:00.000Z"), newId: () => `evt-${++n}` });
			const hashes = sample.map(input => log.append(input).hash);
			log.close();
			return hashes;
		};
		const first = run();
		for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
		expect(run()).toEqual(first);
	});

	test("concurrent writers in separate processes all append, and the chain stays valid", async () => {
		const script = join(dir, "writer.ts");
		writeFileSync(
			script,
			`import { EventLog } from ${JSON.stringify(join(import.meta.dir, "event-log.ts"))};
const log = EventLog.open(process.argv[2]!);
for (let i = 0; i < 200; i++) log.append({ type: "test.concurrent", actor: "proc-" + process.argv[3], payload: { i } });
log.close();
`,
		);
		EventLog.open(path).close();
		const writers = [1, 2, 3].map(k => Bun.spawn([process.execPath, script, path, String(k)], { stderr: "pipe" }));
		const codes = await Promise.all(writers.map(w => w.exited));
		const errors = await Promise.all(writers.map(w => new Response(w.stderr).text()));

		expect({ codes, errors: errors.filter(e => e.length > 0) }).toEqual({ codes: [0, 0, 0], errors: [] });
		expect(verifyFile()).toEqual({ ok: true, count: 600 });
	}, 60_000);

	test("rejects invalid events and leaves the log unchanged", () => {
		const log = EventLog.open(path);
		log.append(sample[0]!);

		const invalid: unknown[] = [
			{ ...sample[0], type: "Lane Opened" },
			{ ...sample[0], type: "" },
			{ ...sample[0], actor: "" },
			{ ...sample[0], actor: "ok\uD800" },
			{ ...sample[0], lane: "" },
			{ ...sample[0], lane: "lane-\uDC00" },
			{ ...sample[0], task: 42 },
			{ ...sample[0], payload: { when: new Date() } },
			{ ...sample[0], payload: { n: Number.NaN } },
			{ ...sample[0], payload: { f: () => 1 } },
			{ ...sample[0], payload: [1, undefined] },
		];
		for (const input of invalid) {
			expect(() => log.append(input as EventInput)).toThrow();
		}
		expect(() => log.append({ ...sample[0]!, type: "Bad Type" })).toThrow(EventLogError);
		expect(log.verify()).toEqual({ ok: true, count: 1 });
		log.close();
	});
});

describe("canonicalJson", () => {
	test("sorts object keys at every depth", () => {
		expect(canonicalJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
	});

	test("rejects values JSON would drop or cannot represent", () => {
		const holey = [1, , 3];
		const extraProperty = Object.assign([1, 2], { note: "dropped by JSON" });
		const holeAndExtra = Object.assign([1, , 3], { x: 9 });
		const symbolKeyed = { a: 1, [Symbol("s")]: 2 };
		for (const value of [undefined, Number.POSITIVE_INFINITY, 1n, Symbol("s"), new Map(), holey, extraProperty, holeAndExtra, symbolKeyed]) {
			expect(() => canonicalJson(value)).toThrow(TypeError);
		}
	});
});
