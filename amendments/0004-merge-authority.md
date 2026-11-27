---
id: A-0004
title: Add L-0039, which routes every change to main through approved pull requests
kind: law
status: approved
proposed: 2026-11-27
approved: 2026-11-27
approvers: ["@tsontario"]
---

Under L-0039 §10, the approval is the approving review on the pull request that lands this record.

## Problem

Three laws required human approval, and nothing enforced it:

- [L-0001](../laws/L-0001-protected-core.md) for changes to the protected core;
- [L-0034](../laws/L-0034-amendment-procedure.md) for amendments;
- [L-0037](../laws/L-0037-bootstrap-supervision.md) for every merge.

Every commit so far was pushed straight to `main`.

The assistant building the factory had also been acting on GitHub under the approver's own identity, against [L-0031](../laws/L-0031-factory-identity.md). Because GitHub never lets a pull request's author approve it, approval could not even be required for the assistant's pull requests while it acted as the approver.

The approver directed that, from now on, every change arrives as a pull request. The assistant may merge on its own judgement once checks pass, but only after reaching a threshold. Until then, the approver approves each pull request.

## Change

- **Law:** add [L-0039](../laws/L-0039-merge-authority.md) with `status: active`, and add its row to the index in `laws/README.md`.
- **Protected core:** add `.github/CODEOWNERS`, the declaration of the protected core that L-0001 §3 requires.
- **CI:** rename the CI job to `secret-scan`, the name that branch protection requires.
- **Factory identity:** add `scripts/as-factory.sh`. It runs a command as the factory's GitHub identity, using a 1-hour token scoped to this repository that is never printed.
- **Enforcement fields:**
  - L-0001 becomes `[review]`.
  - [L-0038](../laws/L-0038-nothing-sensitive-committed.md) becomes `[ci]`.
  - L-0031 and L-0037 note what is now partly in force.
- **README:** add a short note on the pull-request workflow.

Applied outside the repository, by or for the approver:

- **The factory identity:** the GitHub App `straight-facts-factory`, installed only on this repository. Its permissions are contents, pull requests, and workflows (write) and actions and checks (read), with no administration. The approver created and installed it, since creating credentials is a reserved action ([L-0006](../laws/L-0006-reserved-actions.md)). Its private key is kept outside the repository with mode 0600.
- **Merge settings:** squash merges only, and branches are deleted after merge.
- **Branch protection on `main`, applied to administrators too:**
  - the `secret-scan` check must pass, and only GitHub Actions can report it;
  - one approval is required, and code-owner review is required;
  - pushing a new commit cancels an existing approval, and the latest push must be approved;
  - history must stay linear and conversations must be resolved;
  - force pushes and branch deletion are blocked.

## Alternatives

| Option | Why not chosen |
|---|---|
| A machine user account | Its token lives for a long time, and it is another account to manage. App tokens expire after an hour, and uninstalling the app cuts off access at once. |
| The approver merges the assistant's pull requests, with no separate identity | GitHub cannot enforce it, so the assistant's restraint would only be a promise, and L-0031 would stay violated. |
| Track record alone, by amending L-0037 | Merging the factory's own code is exactly what L-0037 guards ([L-0002](../laws/L-0002-no-self-exemption.md)). |
| No numeric threshold | Leaves "good enough" undefined, and gives the factory nothing measurable to propose against. |

## Effects

- **Pull requests:** every pull request needs the approver's approval until the threshold in L-0039 §4 is met. Protected-core pull requests need it permanently.
- **The assistant's own access:** the approver's `gh` login remains on the approver's machine. The protections above bind the factory identity. They do not bind someone holding the approver's token. Until that login is removed from the machine the agent runs on, L-0001 §5 and L-0031 §2 hold only by the agent's restraint.
- **Halt:** uninstalling or suspending the app stops all of the factory's GitHub actions without the factory's cooperation, which is a partial halt for GitHub ([L-0005](../laws/L-0005-halt.md)).
