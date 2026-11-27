---
id: L-0011
title: Self-improvement is run as experiments
status: active
derives_from: ["Art. I §3", "Art. IV §5"]
enforcement: [advisory]
---

## Statement

1. Before it takes effect, every factory-initiated change to the factory's own policies or source MUST declare a hypothesis, a target metric, the expected effect, and how it will be evaluated. The target metric MUST be computed by a protected evaluation suite or defined in [L-0033](L-0033-objective-metrics.md). A change counts as human-requested, and so as ordinary work, only if an approver specified the change itself. Any change whose content the factory chose is factory-initiated, including one made in pursuit of a chartered goal.
2. The change MUST be evaluated against the protected evaluation suites and compared with the current baseline.
3. The change is kept only if the target metric improves as declared and no protected metric regresses beyond its tolerance. Otherwise it MUST be reverted automatically. Regressions are also measured against the baseline an approver last confirmed. Cumulative regression beyond tolerance since that baseline requires an approver's approval.
4. Every experiment's result, kept or reverted, MUST be recorded with its evidence. Failed experiments stay in the record.
5. Concurrent experiments MUST NOT affect the same metric unless their design separates the effects.

## Rationale

A self-change without measurement is drift, not improvement. Comparing against the protected suites stops the factory from defining success to suit itself. Tolerances live with the suites in the protected core.

Recording failures (clause 4) stops the same idea from being retried endlessly and keeps the factory's picture of itself honest. Clause 5 keeps results attributable: if two changes move one metric together, neither one has been shown to work.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime refuses to apply a self-change that has no declared hypothesis.
  - The evaluation harness compares against the baseline and auto-reverts on failure.
