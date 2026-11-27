---
id: L-0016
title: The event log is the record of truth
status: active
derives_from: ["Art. V §4", "Art. I §1"]
enforcement: [advisory]
---

## Statement

1. Every action, decision, message, model call, approval, and outcome MUST be recorded as an event in an append-only log.
2. Recorded events MUST NOT be modified. Deleting events is destroying history ([L-0006](L-0006-reserved-actions.md)).
3. Runtime state MUST be derivable by replaying the log. State kept anywhere else is a cache and MUST be rebuildable from the log.
4. Declarative artifacts (governance, lane charters, policies, the task taxonomy) MUST live in git.

## Rationale

Every feedback loop, metric ([L-0003](L-0003-report-truthfully.md) §5), experiment baseline ([L-0011](L-0011-experiments.md)), and audit depends on a record nobody can quietly rewrite.

Deriving state from the log means a bug in state handling can be fixed and the state replayed, rather than repaired by hand. Git suits artifacts humans review: they diff, they branch, and branch protection covers them.

## Enforcement

- **In force:** none fully, so the law stays advisory.
  - Clause 2 holds at the storage layer (`src/event-log/`), for every connection that leaves the triggers in place and enabled. Triggers refuse every UPDATE and DELETE, and refuse any INSERT that is not the next event chained to the newest one, which also blocks `INSERT OR REPLACE`.
  - Each event's hash covers its contents and the previous event's hash, so `verify()` catches an edit made with the triggers removed or disabled. It cannot catch an edit if the edited event and every event after it were re-hashed.
- **Planned:**
  - Every action, decision, message, model call, approval, and outcome is written to the log (clause 1).
  - The latest hash is anchored outside the log file, so that removing or rewriting the newest events can be detected.
  - A CI test rebuilds state from a recorded log and compares it with the live state (clause 3).
