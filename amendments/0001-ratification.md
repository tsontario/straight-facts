---
id: A-0001
title: Ratify Constitution v1, the approver roster, and laws L-0001 to L-0037
kind: ratification
status: approved
proposed: 2026-11-27
approved: 2026-11-27
approvers: ["@tsontario"]
---

## Problem

straight-facts is about to be built as an autonomous software factory, and it has no governance. Without fixed aims and constraints, every design decision is open to renegotiation, and the factory's self-improvement has no boundary.

## Change

- Adopt `CONSTITUTION.md` (Preamble and Articles I–IX) as Version 1.
- Adopt `APPROVERS.md` with one approver, @tsontario.
- Adopt laws L-0001 to L-0037 with `status: active`. At ratification, every law's enforcement is `advisory` ([L-0036](../laws/L-0036-advisory-gaps.md)). Until the core safeguards are enforced, every merge and release requires approval ([L-0037](../laws/L-0037-bootstrap-supervision.md)).

## Alternatives

These were the founding decisions and the options set aside:

| Decision | Adopted | Set aside |
|---|---|---|
| Layout | Constitution plus one file per law | Per-domain law files; a single document |
| Levels | Constitution → Laws → Policies | Two levels, with no defined area for self-change |
| Scope | The factory builds itself and external repositories, under one set of rules | External only; self only |
| Objective | Value per unit of human attention | "Software a human would sign"; throughput |
| Delivery | From intent to a release observed in production; operations out of scope | Ending at merge; full operational lifecycle |
| Values | Safety > Honesty > Correctness > Legibility > Maintainability > Throughput > Cost | Speed ranked above maintainability; no ranking |
| Autonomy | Full autonomy that depends on detection, with reserved actions and a reversibility default | Graduated autonomy that scopes earn; fixed human checkpoints |
| Lanes | Long-running, goal-directed quests opened by humans; a task taxonomy sits below lanes | Lanes as classes of work; lanes as pipeline stages |
| On defect | Automatic correction plus a circuit breaker that only a human resets | Correction and learning only; alerting a human |
| Self-change | Experiments gated by evidence | The ordinary pipeline; human selection |
| Extensibility | A small core with versioned, capability-scoped contracts | A monolith with configuration; drop-in conventions |
| Harness | omp through its public surfaces, pinned, with fixes sent upstream | A fork; harness-agnostic abstraction |
| Stack | TypeScript (strict) on Bun | Rust; Go |
| State | Append-only event log plus git; shared memory and messaging as context | Git only; a database with an audit table |
| Code and models | Code enforces, models judge | Agents orchestrate; agent-native |
| Verification | Independent verifier plus gates; fails before and passes after; small changes; a ratchet on gates | Gates only; self-checks; coverage thresholds; human-only gate changes |
| Safety | A sandbox per task; hard budgets at every level; gated dependencies; read-only production telemetry | Process isolation; one global budget; human approval for every dependency; production data access |
| Reporting | Status surface on demand, interruptions only for decisions; value = verified lane outcomes; attention = time plus touchpoints | Digests; live streams; counting shipped changes; human ratings |
| Amendment | Written proposals; a 7-day cooling-off and unanimity for the Constitution; suspensions of at most 72 hours | The same bar for laws and the Constitution; no suspensions |
| Bootstrap | Supervised until the core safeguards are enforced ([L-0037](../laws/L-0037-bootstrap-supervision.md)) | Full autonomy from ratification; supervised until every law is enforced |

## Effects

- Every law starts out advisory, and [L-0037](../laws/L-0037-bootstrap-supervision.md) keeps every merge and release under approval until the core safeguards are enforced. The first lanes should put enforcement in force for L-0001 (protected core), L-0005 (halt), L-0006 (reserved actions), L-0024 (sandbox), and L-0027 (budgets).
- [L-0001](../laws/L-0001-protected-core.md) §3 requires the protected core to be declared in one machine-readable location. That location still has to be chosen.
- [L-0031](../laws/L-0031-factory-identity.md) requires the factory to have its own identities before agents commit or comment anywhere.
- The task taxonomy and the gates for each kind ([L-0009](../laws/L-0009-task-kinds.md)) still need to be written. They are protected-core artifacts, and humans must approve them.
- Self-improvement experiments need a lane ([L-0011](../laws/L-0011-experiments.md) §1). A standing self-improvement lane, with its own budget and sponsor, should be chartered.
- Before ratification, an independent review of the draft found 15 issues. Fourteen loopholes were closed in the text, and the fifteenth (autonomy before enforcement) is resolved by [L-0037](../laws/L-0037-bootstrap-supervision.md).
