---
id: L-0030
title: Every artifact traces back to human intent
status: active
derives_from: ["Art. VIII §1", "Art. I §1"]
enforcement: [advisory]
---

## Statement

1. Every artifact the factory produces MUST link to the task and lane that produced it. Artifacts include commits, change requests, releases, documents, memory entries, and messages.
2. Every task MUST link to its lane, and every lane to its charter and sponsoring approver ([L-0008](L-0008-lane-charter.md)).
3. Every link MUST record the agent identity, the model and provider, the versions of the policies in effect, the evidence, and any approvals involved.
4. An artifact that cannot be traced to a charter MUST NOT be merged or released.

## Rationale

When something goes wrong, the first questions are who did it, on whose behalf, and on what evidence. If a link in the chain is missing, the answer is a guess.

Traceability also makes the feedback loops attributable. An escaped defect can be traced to the policy version that let it through ([L-0010](L-0010-defects-and-breakers.md)), and an experiment's effect to the change that caused it ([L-0011](L-0011-experiments.md)).

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime stamps trace metadata on every artifact it creates.
  - Merge and release gates reject artifacts without a resolvable trace.
