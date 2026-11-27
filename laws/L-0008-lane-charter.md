---
id: L-0008
title: Every lane has a human-approved charter
status: active
derives_from: ["Art. III §1", "Art. IV §1"]
enforcement: [advisory]
---

## Statement

1. Every lane MUST have a charter, recorded before work starts, that states its goal, success criteria a reader can check, its priority, its budget, and the approver sponsoring it.
2. Only an approver may open a lane or change any part of its charter. The factory MAY lower a lane's budget, and MAY propose any other change.
3. Every task MUST belong to exactly one lane.
4. A lane closes when its success criteria are shown to be met, or when an approver closes it. The factory MUST NOT declare a lane complete without verification evidence ([L-0003](L-0003-report-truthfully.md)).
5. A failure in one lane MUST NOT corrupt another lane's in-flight work or state.

## Rationale

Lanes are where human intent enters the factory. Everything the factory does autonomously happens in service of a goal some human chose. That keeps the factory an agent of its principals and stops it from setting its own agenda.

Success criteria are fixed by humans because a factory allowed to redefine "done" can always declare victory.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime refuses to schedule tasks for a lane without an approved charter.
  - Charter changes are validated against the roster ([L-0004](L-0004-approver-roster.md)).
  - Each lane runs in an isolated workspace.
