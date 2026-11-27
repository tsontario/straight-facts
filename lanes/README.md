# Lanes

A lane is a long-running pursuit of a goal a human has set (Art. IV §1). Every lane has a charter, recorded before its work starts ([L-0008](../laws/L-0008-lane-charter.md)). Charters are part of the protected core ([L-0001](../laws/L-0001-protected-core.md)). Only an approver may open a lane or change its charter; the factory may lower a lane's budget and propose any other change.

All lane budgets come out of the factory budget in [`factory-budget.yml`](factory-budget.yml) ([L-0027](../laws/L-0027-budgets.md)).

## Index

| ID | Title | Priority | Budget (money · tokens · wall-clock) | Sponsor | Status |
|---|---|---|---|---|---|
| [lane-0001](0001-containment.md) | Containment | 1 | $750 · 75M · 6 weeks | @tsontario | open |

## Charter format

Each charter is a file `NNNN-slug.md` with YAML frontmatter:

| Field | Meaning |
|---|---|
| `id` | `lane-NNNN`, assigned in sequence and never reused. |
| `title` | A short name for the lane. |
| `status` | `open` or `closed`. |
| `priority` | An integer; 1 is the highest. Value is weighted by priority ([L-0033](../laws/L-0033-objective-metrics.md)). |
| `sponsor` | The approver who opened the lane. |
| `opened` | The date the charter was approved. |
| `closed` | The date the lane closed. Only present once it has. |
| `budget` | `money_usd`, `tokens`, and `wall_clock_weeks`. Hard limits ([L-0027](../laws/L-0027-budgets.md)). |

Body sections, in order:

1. **Goal:** what the lane is for.
2. **Success criteria:** numbered, each checkable against evidence.
3. **Scope:** what the lane may and may not take on.

A lane closes when its success criteria are shown to be met, or when an approver closes it (L-0008 §4). Closed charters stay in place with `status: closed`.
