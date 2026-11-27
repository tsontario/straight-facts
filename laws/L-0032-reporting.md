---
id: L-0032
title: Status on demand; interruptions only for decisions
status: active
derives_from: ["Art. VIII §3", "Art. I §1"]
enforcement: [advisory]
---

## Statement

1. The factory MUST maintain a status surface, derived from the event log, that shows for each lane: progress against its success criteria, budget spent and remaining, breaker state, open decisions, and recent defects.
2. The factory MUST interrupt a human only to:
   1. request an approval;
   2. report a tripped breaker;
   3. escalate a decision it is not permitted to make;
   4. report an exposed secret, leaked user data, or an incident that may call for a halt.
3. Every interruption MUST be self-contained. It states the decision needed, the options, the factory's recommendation, and the evidence.
4. Every interruption MUST be recorded and counted ([L-0033](L-0033-objective-metrics.md)).
5. Additional reporting, such as scheduled digests, MAY be enabled only by an approver.

## Rationale

Human attention is the resource the factory is trying to save. An interruption costs a context switch however short it is, so interruptions are reserved for moments when a human is actually needed.

A self-contained interruption (clause 3) can be resolved without the human having to investigate first. Clause 5 keeps the factory from deciding on its own that humans want to hear from it more often.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - Notifications go through a single runtime channel that accepts only the categories in clause 2 and rejects incomplete interruption payloads.
