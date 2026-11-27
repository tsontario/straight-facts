---
id: L-0039
title: Changes reach main only through approved pull requests
status: active
derives_from: ["Art. III §3", "Art. II §5", "Art. IV §4", "Art. VI §4", "Art. VIII §2"]
enforcement: [review, ci]
---

## Statement

1. Every change to `main` MUST arrive through a pull request that passes every required check. Direct pushes, force pushes, and branch deletion are blocked for everyone, administrators included.
2. Agents MUST open, update, and merge pull requests only under the factory's GitHub identity ([L-0031](L-0031-factory-identity.md)). That identity MUST NOT hold administrative rights, so it cannot change branch protection, required checks, or code owners.
3. A pull request that touches the protected core MUST be approved by an approver before it merges, always. `.github/CODEOWNERS` declares the protected core ([L-0001](L-0001-protected-core.md) §3), and required code-owner review enforces this clause.
4. Every other pull request MUST also be approved by an approver until both of these hold:
   1. The factory has 10 consecutive merged pull requests, each approved by an approver without changes being requested, and none reverted within 14 days of merging.
   2. [L-0037](L-0037-bootstrap-supervision.md) no longer applies.
5. When both hold, the factory MAY propose lifting the approval requirement for pull requests outside the protected core. The proposal MUST include the track record, computed from the pull-request history ([L-0003](L-0003-report-truthfully.md) §5). Only an approver may lift the requirement.
6. While the requirement is lifted, the factory MAY merge a pull request outside the protected core on its own judgement once every required check passes.
7. The factory MUST stop merging without approval immediately if any of these happens:
   - a pull request the factory merged is reverted;
   - an approver asks it to stop;
   - a breaker trips ([L-0010](L-0010-defects-and-breakers.md)).

   It MUST then ask an approver to restore the requirement, and the count in clause 4 starts again from zero.
8. Only approvals from approvers count ([L-0004](L-0004-approver-roster.md)). A review by the factory identity is never an approval.
9. Pull requests are squash-merged, so each lands on `main` as one commit that can be reverted on its own ([L-0022](L-0022-small-changes.md)).
10. A pull request that lands an amendment carries the amendment record already marked `approved`. The approving review on that pull request is the record of approval ([L-0004](L-0004-approver-roster.md) §2). Without that review, the record never reaches `main`.

## Rationale

Branch protection makes approval a property of the repository, not a promise an agent keeps. The factory identity has no administrative rights, so it cannot loosen the rules it works under. That puts Art. IV §4 into practice: the factory may tighten its own autonomy (clause 7), but only a human may loosen it (clause 5).

The threshold has two parts:

- **A track record** shows the factory's pull requests are good enough to merge unreviewed.
- **L-0037 having lifted** shows the factory is contained. Merging the factory's own code is exactly the step L-0037 guards, and the factory grants itself no exemptions ([L-0002](L-0002-no-self-exemption.md)).

The protected core never qualifies for unreviewed merging (Art. II §5).

## Enforcement

- **In force:**
  - `review`: branch protection on `main` requires one approval, plus code-owner approval for protected-core paths. Pushing a new commit cancels an existing approval, and the latest push must itself be approved. These rules apply to administrators too.
  - `ci`: the `secret-scan` and `checks` (typecheck and tests) checks must pass, and only results reported by GitHub Actions count.
- **Planned:**
  - A check that computes the track record in clause 4 from the pull-request history.
  - Restoring the approval requirement automatically when a pull request the factory merged is reverted.
