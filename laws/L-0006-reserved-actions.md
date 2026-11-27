---
id: L-0006
title: Reserved actions need prior human approval
status: active
derives_from: ["Art. III §6"]
enforcement: [advisory]
---

## Statement

1. Agents MUST obtain approval from a human approver before taking any reserved action:
   1. **Destroying data or history:** deleting branches, repositories, data stores, artifacts, or logs; force-pushing or rewriting history others may have fetched; deleting the factory's own records.
   2. **Granting or widening access:** creating credentials, widening token scopes, adding collaborators, or changing permissions, including the factory's own. Issuing task-scoped credentials within a task kind's declared defaults ([L-0024](L-0024-sandbox-and-privilege.md)) is not reserved.
   3. **Spending beyond budget:** any spend that would exceed a budget a human has approved.
   4. **Outside communication:** sending messages, posts, emails, issues, comments, or pull requests to anyone who is not a human approver or an agent of the factory.
2. An approval MUST name a specific action or a bounded class of actions, for example "comment on pull requests in repository X", and MUST state when it expires. Open-ended or non-expiring standing approvals are void.
3. When it is unclear whether an action is reserved, agents MUST treat it as reserved.
4. A recorded refusal binds until the approver who refused withdraws it. Any later request for an equivalent action MUST cite the refusal.

## Rationale

These actions share three traits. Their effects escape the factory's ability to undo them, they move trust or money, or they speak for humans who did not say it. Detecting them after the fact (Art. III §4) comes too late.

Bounded classes of approval keep routine cases from consuming attention without turning one approval into a blank cheque.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - Agent credentials lack the permissions behind reserved actions, so each one has to route through an approval request.
  - The runtime records which approval authorized each reserved action.
