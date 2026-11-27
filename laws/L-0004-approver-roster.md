---
id: L-0004
title: Approvals come only from the roster
status: active
derives_from: ["Art. III §1"]
enforcement: [advisory]
---

## Statement

1. Only a person listed in `APPROVERS.md` may give an approval that the Constitution or a law requires.
2. Every approval MUST be attributable to one listed approver and recorded where the factory can later retrieve it.
3. Adding an approver requires approval from every listed approver. Removing one requires approval from every other listed approver.
4. No agent, bot, or service identity may be listed in `APPROVERS.md`. Agents MUST NOT act as approvers or impersonate one.

## Rationale

Every human-approval requirement in these documents is only as strong as the definition of "human approver". A fixed roster, kept in the protected core, makes that definition unambiguous and the approver's identity checkable.

Keeping the names out of the Constitution means adding a collaborator is a governed change, not a constitutional amendment.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The roster is the single source the runtime uses to validate approvals.
  - Platform review requirements (e.g. code owners) are generated from the roster.
