import { Database } from "bun:sqlite";
import { canonicalJson, type JsonValue } from "./canonical-json";

/**
 * The factory's record of truth (L-0016): an append-only, hash-chained log of
 * events stored in SQLite.
 *
 * The storage itself enforces append-only, for every connection that leaves
 * the triggers in place and enabled: triggers refuse UPDATE and DELETE, and
 * refuse any INSERT that is not the next event in sequence, chained to the
 * newest one (which also blocks `INSERT OR REPLACE`). Each event's hash covers
 * its contents and the previous event's hash, so `verify()` detects an edit
 * made with the triggers removed or disabled, unless
 * the edited event and every event after it were re-hashed. Rewriting or
 * removing the newest events can only be detected against a copy of the
 * latest hash kept somewhere else.
 */

export interface EventInput {
	/** Dotted lowercase name, e.g. `memory.write` or `task.started`. */
	readonly type: string;
	/** Who caused the event: an agent id, an approver's handle, or `control-plane`. */
	readonly actor: string;
	readonly lane?: string;
	readonly task?: string;
	readonly payload: JsonValue;
}

export interface LoggedEvent {
	readonly seq: number;
	readonly id: string;
	readonly ts: string;
	readonly type: string;
	readonly actor: string;
	readonly lane: string | null;
	readonly task: string | null;
	readonly payload: JsonValue;
	readonly prevHash: string;
	readonly hash: string;
}

export type VerifyResult =
	| { readonly ok: true; readonly count: number }
	| { readonly ok: false; readonly seq: number; readonly reason: string };

export interface EventLogOptions {
	/** Clock for event timestamps. Injected so replays and tests are deterministic. */
	readonly now?: () => Date;
	/** Event id generator. */
	readonly newId?: () => string;
}

export class EventLogError extends Error {
	override readonly name = "EventLogError";
}

export const GENESIS_HASH = "0".repeat(64);

const TYPE_PATTERN = /^[a-z][a-z0-9_-]*(?:\.[a-z][a-z0-9_-]*)*$/;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
	seq       INTEGER PRIMARY KEY,
	id        TEXT    NOT NULL UNIQUE,
	ts        TEXT    NOT NULL,
	type      TEXT    NOT NULL,
	actor     TEXT    NOT NULL,
	lane      TEXT,
	task      TEXT,
	payload   TEXT    NOT NULL,
	prev_hash TEXT    NOT NULL,
	hash      TEXT    NOT NULL UNIQUE
) STRICT;
CREATE TRIGGER IF NOT EXISTS events_append_only BEFORE INSERT ON events
WHEN NEW.seq IS NOT (SELECT coalesce(max(seq), 0) + 1 FROM events)
	OR NEW.prev_hash IS NOT coalesce((SELECT hash FROM events WHERE seq = NEW.seq - 1), '${GENESIS_HASH}')
	OR EXISTS (SELECT 1 FROM events WHERE id = NEW.id OR hash = NEW.hash)
BEGIN SELECT RAISE(ABORT, 'event log is append-only: INSERT must append the next event'); END;
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'event log is append-only: UPDATE refused'); END;
CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'event log is append-only: DELETE refused'); END;
`;

interface EventRow {
	seq: number;
	id: string;
	ts: string;
	type: string;
	actor: string;
	lane: string | null;
	task: string | null;
	payload: string;
	prev_hash: string;
	hash: string;
}

type UnhashedEvent = Omit<LoggedEvent, "hash">;

export class EventLog {
	readonly #db: Database;
	readonly #now: () => Date;
	readonly #newId: () => string;

	private constructor(db: Database, options: EventLogOptions) {
		this.#db = db;
		this.#now = options.now ?? (() => new Date());
		this.#newId = options.newId ?? (() => crypto.randomUUID());
	}

	/** Opens the log at `path`, creating it if needed. */
	static open(path: string, options: EventLogOptions = {}): EventLog {
		const db = new Database(path, { create: true, strict: true });
		db.exec("PRAGMA busy_timeout = 5000");
		db.exec("PRAGMA journal_mode = WAL");
		db.exec("PRAGMA synchronous = FULL");
		db.exec(SCHEMA);
		return new EventLog(db, options);
	}

	/** Validates and appends one event, chaining it to the newest event. */
	append(input: EventInput): LoggedEvent {
		validate(input);
		const payloadJson = canonicalJson(input.payload);
		// Hash what is stored, not the caller's object, so the hash and the stored text cannot drift apart.
		const payload = JSON.parse(payloadJson) as JsonValue;
		const insert = this.#db.transaction((): LoggedEvent => {
			const last = this.#db
				.query<{ seq: number; hash: string }, []>("SELECT seq, hash FROM events ORDER BY seq DESC LIMIT 1")
				.get();
			const event: UnhashedEvent = {
				seq: (last?.seq ?? 0) + 1,
				id: this.#newId(),
				ts: this.#now().toISOString(),
				type: input.type,
				actor: input.actor,
				lane: input.lane ?? null,
				task: input.task ?? null,
				payload,
				prevHash: last?.hash ?? GENESIS_HASH,
			};
			const hash = hashEvent(event);
			this.#db
				.query(
					"INSERT INTO events (seq, id, ts, type, actor, lane, task, payload, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				)
				.run(event.seq, event.id, event.ts, event.type, event.actor, event.lane, event.task, payloadJson, event.prevHash, hash);
			return { ...event, hash };
		});
		return insert.immediate();
	}

	/** Yields events in order, starting at `fromSeq`. */
	*read(fromSeq = 1): Generator<LoggedEvent> {
		for (const row of this.#rows(fromSeq)) {
			yield { ...fromRow(row), payload: JSON.parse(row.payload) as JsonValue };
		}
	}

	/**
	 * Recomputes the hash chain from the stored rows and reports the first
	 * event that does not match. See the module comment for what it cannot catch.
	 */
	verify(): VerifyResult {
		let expectedSeq = 1;
		let prevHash = GENESIS_HASH;
		for (const row of this.#rows(1)) {
			if (row.seq !== expectedSeq) {
				return { ok: false, seq: row.seq, reason: `expected seq ${expectedSeq}` };
			}
			if (row.prev_hash !== prevHash) {
				return { ok: false, seq: row.seq, reason: "prev_hash does not match the previous event's hash" };
			}
			let payload: JsonValue;
			let canonical: string;
			try {
				payload = JSON.parse(row.payload) as JsonValue;
				canonical = canonicalJson(payload);
			} catch {
				return { ok: false, seq: row.seq, reason: "payload is not JSON the log accepts" };
			}
			if (canonical !== row.payload) {
				return { ok: false, seq: row.seq, reason: "payload is not stored in canonical form" };
			}
			const { hash, ...unhashed } = fromRow(row);
			if (hashEvent({ ...unhashed, payload }) !== hash) {
				return { ok: false, seq: row.seq, reason: "hash does not match the event's contents" };
			}
			prevHash = hash;
			expectedSeq += 1;
		}
		return { ok: true, count: expectedSeq - 1 };
	}

	close(): void {
		this.#db.close();
	}

	#rows(fromSeq: number): IterableIterator<EventRow> {
		return this.#db
			.query<EventRow, [number]>(
				"SELECT seq, id, ts, type, actor, lane, task, payload, prev_hash, hash FROM events WHERE seq >= ? ORDER BY seq",
			)
			.iterate(fromSeq);
	}
}

function validate(input: EventInput): void {
	if (typeof input.type !== "string" || !TYPE_PATTERN.test(input.type)) {
		throw new EventLogError(`invalid event type: ${JSON.stringify(input.type)}`);
	}
	// Lone surrogates would be stored as U+FFFD and break the hash, so text fields must be well-formed.
	if (typeof input.actor !== "string" || input.actor.length === 0 || !input.actor.isWellFormed()) {
		throw new EventLogError("actor must be a non-empty, well-formed string");
	}
	for (const field of ["lane", "task"] as const) {
		const value: unknown = input[field];
		if (value !== undefined && (typeof value !== "string" || value.length === 0 || !value.isWellFormed())) {
			throw new EventLogError(`${field} must be a non-empty, well-formed string when present`);
		}
	}
}

function hashEvent(event: UnhashedEvent): string {
	return new Bun.CryptoHasher("sha256").update(canonicalJson(event)).digest("hex");
}

/** Maps a row to an event, leaving the payload for the caller to parse. */
function fromRow(row: EventRow): Omit<LoggedEvent, "payload"> {
	return {
		seq: row.seq,
		id: row.id,
		ts: row.ts,
		type: row.type,
		actor: row.actor,
		lane: row.lane,
		task: row.task,
		prevHash: row.prev_hash,
		hash: row.hash,
	};
}
