---
id: L-0022
title: Changes are small, single-purpose, and revertible on their own
status: active
derives_from: ["Art. VI §4", "Art. III §5"]
enforcement: [advisory]
---

## Statement

1. Every change MUST have a single purpose, stated in its description.
2. Unrelated changes MUST NOT be bundled into one change.
3. Every change MUST be revertible on its own: reverting only that change leaves a system that passes the gates.
4. A task kind's gate binding ([L-0009](L-0009-task-kinds.md)) MAY set numeric size limits. Those limits are protected gate tolerances.

## Rationale

Small, single-purpose changes are what make the rest of the system work. They can be reverted on their own ([L-0007](L-0007-reversibility.md)), a defect can be pinned to the change that caused it ([L-0010](L-0010-defects-and-breakers.md)), and a verifier can understand one in full ([L-0020](L-0020-independent-verification.md)). A large mixed change defeats all three.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - A gate rejects changes over the size limit for their kind.
  - The verifier rejects changes whose diff does not match their stated purpose.
  - Release tooling tests reverting each change.
