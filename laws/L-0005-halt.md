---
id: L-0005
title: The halt works without the factory's cooperation
status: active
derives_from: ["Art. III §2"]
enforcement: [advisory]
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

- **In force:** none (advisory).
- **Planned:**
  - A halt flag held outside agent write access, checked by the runtime before every action.
  - Credential revocation as the hard stop.
  - The halt test included in the protected gates.
