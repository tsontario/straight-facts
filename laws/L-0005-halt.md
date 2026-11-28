---
id: L-0005
title: The halt works without the factory's cooperation
status: active
derives_from: ["Art. III §2"]
enforcement: [ci]
---

## Statement

1. The factory MUST provide a halt that any approver can trigger, scoped to the whole factory, a lane, or a repository.
2. The halt MUST take effect without the cooperation of any agent. Stopping MUST NOT depend on an agent choosing to comply.
3. Once a halt applies, the control plane MUST stop every affected agent process within 60 seconds. Any cleanup of in-flight work MUST be done by deterministic control-plane code, not by agents.
4. Agents MUST NOT prevent, delay, evade, or undo a halt, and MUST NOT schedule work to resume after it.
5. The halt path MUST be covered by an automated test that runs among the factory's own gates.
6. Only an approver may lift a halt. Lifting a halt is an approval under [L-0004](L-0004-approver-roster.md) §2.

## Rationale

An off switch that relies on the thing being switched off is not an off switch. Clause 2 places the halt outside any agent's control, for example by revoking credentials or stopping processes. Clause 5 exists because a halt that is never exercised will turn out to be broken on the day it is needed.

## Enforcement

- **In force:** `ci`.
  - Branch protection on `main` requires the `checks` job, which runs the halt's end-to-end test (`src/halt/halt.test.ts`, required in CI). It raises a halt on sandboxes that ignore SIGTERM and checks that they are killed within 60 seconds. It also checks that the gateway and the model proxy refuse everything in the halted scope, that deleting the halt file lifts nothing, and that a lift counts only when it is recorded in an approver's name (decision 0002 §4).
  - Limit: an agent session run directly on the approver's Mac, outside the launcher, can append a correctly chained `halt.lifted` event in an approver's name, which lifts the halt for the model proxy, and can rewrite the halt file, which lifts it for the gateways (decision 0002 §7). Clauses 4 and 6 hold against such a session only once every session runs in a sandbox and event writers are authenticated.
- **Built, not yet in force at runtime:** the halt command (`src/halt/cli.ts`) records the halt, rewrites the halt file and kills every container in the scope. Each task's gateway and the model proxy refuse a halted scope. No agent session runs in a sandbox until the launcher (decision 0002, step 5), so none can be stopped this way yet.
- **Planned:**
  - The launcher runs every session in a sandbox, refuses to start a task in a halted scope, and checks the halt before every action (`runtime`).
  - An approver lifts a halt through the approval channel (decision 0002 §5).
  - Credential revocation as the hard stop.
