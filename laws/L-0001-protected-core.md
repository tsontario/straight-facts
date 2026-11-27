---
id: L-0001
title: Protected core changes require human approval
status: active
derives_from: ["Art. II §3", "Art. II §5"]
enforcement: [review]
---

## Statement

1. A change that touches the protected core MUST NOT take effect without explicit approval from a human approver. The one exception is a change that only makes verification gates or evaluation suites stricter, made under [L-0023](L-0023-ratchet.md).
2. The protected core MUST include at least:
   - `CONSTITUTION.md`, `APPROVERS.md`, `laws/**`, and `amendments/**`;
   - the verification gates and evaluation suites that judge factory output, including their tolerances;
   - the mechanisms that enforce the Constitution and laws, such as the halt, budget metering, sandbox and credential issuance, approval checks, and this protected-core guard;
   - the declaration of the protected core itself (clause 3);
   - lane charters, in full ([L-0008](L-0008-lane-charter.md));
   - the independent verifier's instructions, its model assignment, and the rule that turns verdicts into pass or fail ([L-0020](L-0020-independent-verification.md));
   - the task taxonomy and its gate bindings ([L-0009](L-0009-task-kinds.md));
   - circuit-breaker thresholds ([L-0010](L-0010-defects-and-breakers.md));
   - the factory budget ([L-0027](L-0027-budgets.md));
   - the dependency license allowlist and vulnerability threshold ([L-0028](L-0028-dependencies.md));
   - the objective-metric definitions, their computation, and the instrumentation that records human time and interruptions ([L-0033](L-0033-objective-metrics.md)).
3. The protected core MUST be declared in exactly one machine-readable location, and every enforcement mechanism MUST read from it.
4. Agents MAY write proposals that touch the protected core. Agents MUST NOT approve, merge, or otherwise put them into effect.
5. Agents MUST NOT hold credentials that can approve or merge changes to the protected core. Changes accepted under [L-0023](L-0023-ratchet.md) are merged by a deterministic control-plane path whose credentials no agent holds.
6. "Verification gates" means the factory's gate definitions and protected suites. A target repository's own tests are not part of the protected core. [L-0021](L-0021-proof-of-behavior.md) governs changes to them.

## Rationale

Under optimization pressure, a system that can edit its own rules or its own grader drifts toward changing them instead of meeting them. Requiring human approval for both keeps the factory's objective out of the factory's reach.

Proposals stay open to agents because the agents doing the work are the first to see when a rule is wrong. Blocking proposals would cut that feedback loop.

Clause 5 makes clause 4 a fact rather than a promise: an agent that cannot approve does not have to choose not to.

## Enforcement

- **In force:** `review`.
  - Branch protection on `main` requires code-owner review for every path in `.github/CODEOWNERS`, the declaration clause 3 requires, and it applies to administrators too ([L-0039](L-0039-merge-authority.md)).
  - The factory's GitHub identity can neither approve a protected-core change nor merge one that lacks that review.
  - Limit: clause 5 does not yet hold on the approver's own machine, where the approver's GitHub login is still available to the agent.
- **Planned:**
  - A runtime guard that refuses writes to protected paths unless they are part of a proposal.
  - Agents run only where no approver credentials are present ([L-0024](L-0024-sandbox-and-privilege.md)).
