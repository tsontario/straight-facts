---
id: L-0033
title: The objective is measured from the record, by protected definitions
status: active
derives_from: ["Art. VIII §4", "Art. I §3", "Art. II §5"]
enforcement: [advisory]
---

## Statement

1. Value MUST be measured as verified progress on lane success criteria, weighted by each lane's priority, which an approver sets.
2. Human attention MUST be measured both as recorded human time on factory interactions (approvals, reviews, interventions, reading reports) and as the count of interruptions.
3. Both MUST be computed from the event log ([L-0016](L-0016-event-log.md)).
4. The definitions of these metrics, the code that computes them, and the instrumentation that records human time and interruptions are part of the protected core ([L-0001](L-0001-protected-core.md)).
5. The factory MUST report the objective together with its guardrails: escaped defects, time from defect to detection, cost, and breaker trips.

## Rationale

A system that can redefine its objective can meet it without improving anything. Protecting the definitions and the computation keeps "value per unit of human attention" honest.

Reporting guardrails alongside the objective (clause 5) puts Art. I §3 into practice: saving attention by giving up quality shows up as a guardrail regression instead of looking like a win.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - Metric computation lives in a protected module that reads only from the event log.
  - The status surface shows the objective and its guardrails side by side.
