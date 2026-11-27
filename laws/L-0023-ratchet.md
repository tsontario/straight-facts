---
id: L-0023
title: Verification only tightens without a human
status: active
derives_from: ["Art. II §5", "Art. VI §5", "Art. IV §3"]
enforcement: [advisory]
---

## Statement

1. The factory MAY add checks to the protected gates and evaluation suites, or tighten their tolerances, without human approval, provided the change only makes verification stricter.
2. Such a change MUST NOT change the outcome of any existing check, and MUST NOT remove or loosen any check, fixture, or tolerance. It MUST NOT add cases to a suite whose results feed a score, rate, or tolerance used by [L-0011](L-0011-experiments.md) or [L-0033](L-0033-objective-metrics.md); adding such cases requires approval.
3. Removing, disabling, skipping, quarantining, or weakening a check, or loosening a tolerance, requires approval from a human approver ([L-0001](L-0001-protected-core.md)).
4. Every check the factory adds MUST be recorded with the defect or reason that prompted it.
5. A change accepted under this law is merged by a deterministic control-plane path whose credentials no agent holds ([L-0001](L-0001-protected-core.md) §5).

## Rationale

The escaped-defect loop (Art. IV §3) has to run at machine speed: every defect should become a check without waiting on a human. Loosening must stay human-only, or the factory could make its own gates easier to pass.

Clause 3 lists quarantine and skip explicitly because they are the usual quiet ways to switch off a check. The cost is that a wrong check added by the factory blocks work until a human removes it. That is the safe way to fail.

## Enforcement

- **In force:** none (advisory).
- **Planned:** a CI check classifies every diff to protected verification paths as additive or not, and requires approval for anything that isn't.
