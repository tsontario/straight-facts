---
id: L-0015
title: Code enforces, models judge
status: active
derives_from: ["Art. V §2"]
enforcement: [advisory]
---

## Statement

1. Orchestration, state transitions, gate decisions, budget accounting, and the halt MUST be implemented in deterministic code.
2. Model output MUST be validated against a declared schema before any code acts on it. Invalid output MUST be rejected.
3. A model MAY provide judgment to a gate, such as a review verdict. The rule that turns judgments into a pass or fail MUST be code.
4. Enforcing a law MUST NOT depend on a prompt or on a model choosing to comply. Prompts MAY restate laws to guide behavior, but a law enforced only by prompt is `advisory`.

## Rationale

Models are capable but not reliable in the way enforcement has to be. Placing every decision that matters for safety in code makes it testable, repeatable, and impossible to talk around. Schema validation stops malformed or injected model output from becoming an action. Clause 4 keeps the `enforcement` field honest: a prompt is guidance, not a guard.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - Model calls go through a typed boundary that validates output against a schema.
  - Gate implementations are reviewed for having deterministic decision rules.
