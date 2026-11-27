---
id: L-0009
title: Every task has a declared kind and that kind's gates
status: active
derives_from: ["Art. II §5", "Art. IV §2"]
enforcement: [advisory]
---

## Statement

1. Every task MUST have exactly one kind from the declared task taxonomy.
2. Each kind MUST declare what it produces (for example a code change, a document, a finding, or a decision) and the gates its output must pass.
3. The taxonomy and the binding from each kind to its gates are part of the protected core ([L-0001](L-0001-protected-core.md)).
4. A task whose actual work does not match its kind MUST be re-kinded or split. It MUST NOT go through under the gates of the wrong kind. Only whoever set the task's acceptance criteria may re-kind it, and the re-kinded task restarts under [L-0019](L-0019-acceptance-criteria.md) in a fresh sandbox. Re-kinding into a kind with wider network or credential defaults counts as widening access ([L-0006](L-0006-reserved-actions.md)).

## Rationale

Kinds let verification be specific: a research finding and a production code change need different evidence. But if the factory could define kinds freely, it could create one with weak gates and route work through it. Protecting the taxonomy and its gate bindings closes that loophole. Clause 4 closes the mislabeling version of the same loophole.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime rejects tasks with undeclared kinds.
  - Gates check that a task's output type matches its kind's declared output.
