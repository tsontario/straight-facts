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

- **In force:** none fully, so the law stays advisory.
  - The taxonomy, its gate bindings, and its path-triggered gates are declared in `tasks/taxonomy.toml`, which is protected core (clause 3).
  - `src/tasks/taxonomy.ts` validates the file strictly in CI. Any of these fails the build: a duplicated key, an unknown or missing field, an unknown gate or network profile, a bad value, or a path pattern that is not a plain repository-relative glob.
  - `kindOf()` refuses undeclared kinds. `gatesFor()` adds the gates triggered by a task's changed paths. `writesAllowed()` checks those paths against the kind's `writes`.
- **Planned:**
  - The runtime refuses to start a task with an undeclared kind (clause 1).
  - Gates use `gatesFor()` and `writesAllowed()`, resolving `@protected-core` from `.github/CODEOWNERS`, and check that a task's output matches its kind's `produces` (clauses 2 and 4).
