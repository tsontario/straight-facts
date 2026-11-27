---
id: L-0027
title: Every level has a hard budget
status: active
derives_from: ["Art. VII §5", "Art. III §6"]
enforcement: [advisory]
---

## Statement

1. The factory, every lane, and every task MUST have hard budgets for money, tokens, and wall-clock time.
2. The factory budget is set by an approver. A lane's budget is set in its charter ([L-0008](L-0008-lane-charter.md)). The factory sets task budgets from its lane's budget.
3. A budget MUST fit within what remains of its parent's budget.
4. Budgets MUST be enforced by code that stops work at the limit, without depending on any agent's cooperation.
5. The factory MAY reallocate unspent lane budget among that lane's tasks. Raising the factory budget or a lane budget requires an approver ([L-0006](L-0006-reserved-actions.md)).
6. Spend MUST be recorded per model call and per sandbox, and budget usage MUST be computed from that record ([L-0003](L-0003-report-truthfully.md) §5).

## Rationale

Autonomous loops fail expensively. Retry storms, runaway decomposition, and an agent stuck reaching for an unreachable goal all burn money without delivering value. Hard limits at every level contain a runaway at the smallest scope that can hold it.

Budgets are enforced in code (clause 4) for the same reason as the halt: an agent in trouble is the least reliable judge of when to stop.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime meters model calls and sandbox time against the budget tree and stops work at the limit.
