---
id: L-0020
title: Work is judged by someone other than its author
status: active
derives_from: ["Art. VI §2", "Art. I §1"]
enforcement: [advisory]
---

## Statement

1. Every task's output MUST pass its kind's deterministic gates ([L-0009](L-0009-task-kinds.md)) and be reviewed by an independent verifier.
2. An independent verifier is a separate agent session that receives the task, its acceptance criteria, the output, and its evidence, but not the doer's context or reasoning.
3. The verifier MUST run on a different model from the doer, unless an approver has recorded that no different model is available. The verifier's instructions and model assignment are part of the protected core ([L-0001](L-0001-protected-core.md)).
4. A verifier MUST NOT have contributed to the work it verifies.
5. The verifier's verdict and reasons MUST be recorded. The doer MUST NOT edit them.
6. The runtime, not the doer, starts the verifier, using the recorded task and criteria. A failing verdict stands until the output changes. Every earlier verdict on the task MUST be given to any later verifier and shown alongside the final verdict.

## Rationale

A model reviewing its own output tends to repeat its own blind spots. Withholding the doer's reasoning from the verifier (clause 2) makes the verifier judge what was produced, not the story of how it was produced. Using a different model (clause 3) reduces correlated errors.

Deterministic gates catch what can be checked mechanically. The verifier catches what needs judgment: intent, design, missed cases.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime spawns verifiers with a fresh context and records doer and verifier identities.
  - Merge is blocked without a recorded passing verdict from a different agent.
