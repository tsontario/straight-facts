---
id: lane-0001
title: Containment
status: open
priority: 1
sponsor: "@tsontario"
opened: 2026-11-27
budget:
  money_usd: 750
  tokens: 75000000
  wall_clock_weeks: 6
---

## Goal

Enforce the five core safeguards, so that [L-0037](../laws/L-0037-bootstrap-supervision.md) lifts and the factory can start acting on its own authority (Art. III §3). The work turns these laws from promises into mechanisms:

- [L-0005](../laws/L-0005-halt.md): the halt;
- [L-0006](../laws/L-0006-reserved-actions.md): reserved actions;
- [L-0024](../laws/L-0024-sandbox-and-privilege.md): sandboxing;
- [L-0027](../laws/L-0027-budgets.md): budgets.

[L-0001](../laws/L-0001-protected-core.md), the protected core, is already enforced.

## Success criteria

1. L-0005, L-0006, L-0024, and L-0027 each list a `runtime` or `ci` mechanism in their `enforcement` field. None of them is `advisory`.
2. Each of those mechanisms is exercised by an automated test that runs as a required CI check. Each test fails without its mechanism, passes with it ([L-0021](../laws/L-0021-proof-of-behavior.md)), and shows that the mechanism blocks the violation it guards against.
3. L-0001 remains enforced, and every file that implements the five mechanisms is listed in `.github/CODEOWNERS`.
4. The condition in L-0037 holds: none of L-0001, L-0005, L-0006, L-0024, or L-0027 is `advisory`.

## Scope

**In scope:** the control-plane foundations the mechanisms need.

- The TypeScript-on-Bun project and its CI checks ([L-0014](../laws/L-0014-stack.md)).
- The event log ([L-0016](../laws/L-0016-event-log.md)).
- The task taxonomy and its gates ([L-0009](../laws/L-0009-task-kinds.md)). This includes the memory-promotion task kind.
- An agent launcher. It runs omp in RPC mode, with one sandbox per task and short-lived credentials scoped to that task, and with omp's own memory turned off.
- Budget metering, the halt, and the routing of reserved actions through approval.

**Out of scope:** anything those criteria don't need. That includes shared memory and messaging beyond what the launcher requires, release tooling, and production telemetry. Each of those belongs to a later lane.

**Budget note:** spend is not metered until the budget mechanism this lane builds is in place. Until then, the factory reports spend from the records it has, and labels it unverified ([L-0003](../laws/L-0003-report-truthfully.md)).
