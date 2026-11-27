---
id: L-0037
title: Supervised until core enforcement is live
status: active
derives_from: ["Art. III §4", "Art. V §2", "Art. IX §7"]
enforcement: [advisory]
---

## Statement

1. While any of [L-0001](L-0001-protected-core.md) (protected core), [L-0005](L-0005-halt.md) (halt), [L-0006](L-0006-reserved-actions.md) (reserved actions), [L-0024](L-0024-sandbox-and-privilege.md) (sandbox), or [L-0027](L-0027-budgets.md) (budgets) has `enforcement: [advisory]`, every merge and release MUST require approval from an approver, as if every lane's breaker were tripped ([L-0010](L-0010-defects-and-breakers.md) §3).
2. Supervision ends when none of those laws is `advisory`.
3. If any of them later returns to `advisory`, supervision resumes immediately.

## Rationale

Full autonomy (Art. III §3) is only safe if the factory is actually contained. Until enforcement code exists, every safeguard depends on a model choosing to comply, which Art. V §2 rules out as a basis for enforcement.

These five laws are the minimum containment. Without them, the factory could change its own rules, could not be reliably stopped, could take reserved actions, could reach beyond its sandbox, and could spend without limit. Once all five are enforced, autonomy is something the factory has been built to handle safely, not something it has been trusted with.

## Enforcement

- **In force:** none fully, so the law stays advisory.
  - In this repository, branch protection requires an approver's approval on every pull request ([L-0039](L-0039-merge-authority.md)).
- **Planned:** the merge and release paths in every repository read the `enforcement` fields of the five laws, and require approval while any of them is `advisory`.
