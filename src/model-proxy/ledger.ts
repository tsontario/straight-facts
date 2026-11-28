import type { EventLog } from "../event-log/event-log";
import { isRecord } from "../util/guards";
import type { Amount } from "./policy";

/**
 * Spend per task, per lane and for the factory, computed from the event log
 * (L-0027 §6): a settled call counts what it cost, and a reservation without a
 * settlement counts in full (decision 0002 §3), so a call interrupted by a crash
 * or a halt is never forgotten.
 */

export type Scope = { readonly task: string } | { readonly lane: string } | "factory";

interface Entry {
	readonly task: string;
	readonly lane: string;
	readonly reserved: Amount;
	settled: Amount | undefined;
}

export class Ledger {
	readonly #entries = new Map<string, Entry>();

	/** Replays every `model.reserved` and `model.call` event in the log. */
	static fromLog(log: EventLog): Ledger {
		const ledger = new Ledger();
		for (const event of log.read()) {
			const payload = event.payload;
			if (!isRecord(payload) || typeof payload.reservation !== "string") continue;
			if (event.type === "model.reserved" && event.task !== null && event.lane !== null) {
				const reserved = amount(payload.reserved_nano_usd, payload.reserved_tokens);
				if (reserved) ledger.reserve(payload.reservation, event.task, event.lane, reserved);
			} else if (event.type === "model.call") {
				// A malformed settlement settles nothing: its reservation keeps counting in full.
				const settled = amount(payload.cost_nano_usd, payload.tokens);
				if (settled) ledger.settle(payload.reservation, settled);
			}
		}
		return ledger;
	}

	/** Records a reservation. A repeated id never lowers what is held: each part keeps its larger value. */
	reserve(id: string, task: string, lane: string, reserved: Amount): void {
		const existing = this.#entries.get(id);
		const held: Amount = existing
			? { nanoUsd: Math.max(existing.reserved.nanoUsd, reserved.nanoUsd), tokens: Math.max(existing.reserved.tokens, reserved.tokens) }
			: reserved;
		this.#entries.set(id, { task, lane, reserved: held, settled: existing?.settled });
	}

	settle(id: string, settled: Amount): void {
		const entry = this.#entries.get(id);
		if (entry) entry.settled = settled;
	}

	/** Spend in a scope: settled costs, plus every reservation not yet settled. */
	spent(scope: Scope): Amount {
		let nanoUsd = 0;
		let tokens = 0;
		for (const entry of this.#entries.values()) {
			if (scope !== "factory" && ("task" in scope ? entry.task !== scope.task : entry.lane !== scope.lane)) continue;
			const counted = entry.settled ?? entry.reserved;
			nanoUsd += counted.nanoUsd;
			tokens += counted.tokens;
		}
		return { nanoUsd, tokens };
	}
}

/** An amount from a record, or undefined if either part is not a non-negative finite number. */
function amount(nanoUsd: unknown, tokens: unknown): Amount | undefined {
	const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
	return valid(nanoUsd) && valid(tokens) ? { nanoUsd, tokens } : undefined;
}
