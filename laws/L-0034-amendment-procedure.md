---
id: L-0034
title: Amendments follow a recorded procedure
status: active
derives_from: ["Art. IX §2", "Art. IX §3", "Art. IX §4", "Art. IX §5", "Art. IX §8"]
enforcement: [advisory]
---

## Statement

1. Every amendment proposal MUST be a file `amendments/NNNN-slug.md` with sequential numbering and YAML frontmatter:
   - `id`: `A-NNNN`.
   - `title`.
   - `kind`: `ratification`, `constitution`, `law`, or `suspension`.
   - `status`: `proposed`, `approved`, `rejected`, or `withdrawn`.
   - `proposed`: the date it was recorded.
   - `approved`: the date it was approved, if it has been.
   - `approvers`: the handles of the approvers.
2. Its body MUST contain these sections:
   - **Problem**, with evidence from the record.
   - **Change**, giving the exact text added, changed, or removed.
   - **Alternatives**, including why a policy-level change does not solve the problem.
   - **Effects** on other laws and on the Constitution.
3. A `law` amendment takes effect on approval by one approver ([L-0004](L-0004-approver-roster.md)).
4. A `constitution` amendment takes effect only once at least seven days have passed since `proposed` and every listed approver has approved it. Any change to the proposal's Change section restarts the seven days.
5. An amendment's record and the change it makes MUST land together, in a single change.
6. Proposals that are rejected or withdrawn MUST stay in `amendments/`.
7. An editorial change (Art. IX §8) is limited to a law's `enforcement` field, its Enforcement section, links, and the index. It takes effect on one approver's approval, without a proposal. It MUST NOT touch the Constitution, `APPROVERS.md`, or any law's Statement, `status`, or `derives_from`.

## Rationale

The bar for changing governance has to be written down; "very good reason" left undefined is no bar at all. Requiring evidence and alternatives forces each proposal to show the problem is real and that a lower level cannot fix it. The cooling-off period for the Constitution protects against impulsive changes, and against an approver being talked into one.

Landing the record together with the change (clause 5) keeps the documents and their history from drifting apart. Clause 7 stops routine upkeep, such as switching on enforcement for a law, from costing a full amendment.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - A CI check rejects changes to `CONSTITUTION.md` or `laws/**` that do not include a matching approved amendment record or an editorial approval.
  - The check computes the cooling-off period from the record.
