---
id: L-0024
title: Every task runs sandboxed with least privilege
status: active
derives_from: ["Art. VII §1", "Art. VII §2", "Art. V §3"]
enforcement: [advisory]
---

## Statement

1. Every task MUST run in its own sandbox, either a container or a VM, whose filesystem is limited to the task's workspace.
2. A sandbox's network access MUST be limited to the allowlist declared for the task's kind ([L-0009](L-0009-task-kinds.md)). All other network access MUST be denied.
3. A sandbox MUST NOT hold host credentials or mount host paths outside the workspace.
4. Credentials granted to a task MUST be scoped to what that task needs and MUST expire when the task ends.
5. Granting a task network access or credentials beyond its kind's declared defaults counts as widening access ([L-0006](L-0006-reserved-actions.md)).
6. A task's effective access, including access used through any extension acting on its behalf, MUST NOT exceed its kind's defaults plus any approved grants.

## Rationale

With full autonomy, the factory's safety rests on its containment, not on the model behaving well. A sandbox turns a confused or compromised agent into a contained incident rather than a host compromise. Short-lived credentials scoped to one task mean a leaked token is worth little and soon expires.

Declaring network defaults per task kind places them in the protected core alongside the taxonomy.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime launches each task in a sandbox built from its kind's declaration.
  - A credential broker issues task-scoped tokens with expiry.
