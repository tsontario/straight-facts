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

- **In force:** none (advisory).
- **Planned:**
  - The log store exposes no update or delete operation to agents.
  - A CI test rebuilds state from a recorded log and compares it with the live state.
