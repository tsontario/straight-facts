---
id: L-0035
title: Suspensions are narrow, short, and followed up
status: active
derives_from: ["Art. IX §6"]
enforcement: [advisory]
---

## Statement

1. An approver MAY suspend one law by recording a `suspension` in `amendments/` that states the law, the reason, the scope, the start, and the expiry.
2. Suspensions of the same law MUST NOT total more than 72 hours in any 90 days, and no more than one law may be suspended at a time.
3. These laws MUST NOT be suspended: [L-0001](L-0001-protected-core.md) (protected core), [L-0004](L-0004-approver-roster.md) (approver roster), [L-0005](L-0005-halt.md) (halt), and this law.
4. Every action that relies on a suspension MUST record the suspension it relies on ([L-0030](L-0030-traceability.md)).
5. After every suspension, the factory MUST produce either an amendment proposal or a recorded decision by an approver that the law stands.

## Rationale

A buggy law can block urgent, legitimate work. Without an escape hatch, the choice is between doing nothing and a rushed amendment that skips the bar set out in Art. IX.

Clauses 2 and 3 stop the escape hatch from becoming a way to repeal or erode the core protections. Clause 5 treats every suspension as evidence that something needs fixing.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime reads active suspensions from `amendments/`, rejects any suspension of a law listed in clause 3, and enforces expiry.
