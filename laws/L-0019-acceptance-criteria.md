---
id: L-0019
title: Acceptance criteria are fixed before work begins
status: active
derives_from: ["Art. VI §1"]
enforcement: [advisory]
---

## Statement

1. Every task MUST have acceptance criteria recorded before work on it begins.
2. Every criterion MUST be checkable: it maps to evidence a verifier can examine.
3. The agent doing a task MUST NOT set or change its acceptance criteria.
4. Acceptance criteria MUST NOT change after work begins. If they turn out to be wrong, the task is closed as not done, with the reason recorded, and a new task is opened. The closed task counts as failed in every metric.
5. A task is done only when its verifier has confirmed every criterion against recorded evidence.

## Rationale

An agent that writes its own acceptance criteria after the fact will always pass. Fixing the criteria up front, and keeping them out of the doer's hands, makes "done" a test the work has to meet. It stops "done" from being a description of whatever the work turned out to be. Clause 4 removes the remaining way to move the goalposts: wrong criteria end the task as a recorded failure. They are never quietly rewritten so that the work passes.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime refuses to start a task without recorded criteria.
  - The doer's credentials cannot write to the criteria record.
