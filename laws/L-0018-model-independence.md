---
id: L-0018
title: Models and providers are policy, not code
status: active
derives_from: ["Art. V §6"]
enforcement: [advisory]
---

## Statement

1. Which model or provider fills each role MUST be set in policy, not hard-coded in factory source. The exception is the verifier's model assignment, which is part of the protected core ([L-0020](L-0020-independent-verification.md)).
2. A factory component MUST NOT require a feature that only one provider offers, unless it degrades gracefully when that feature is missing.
3. Every model call MUST be recorded with the exact model and provider used ([L-0016](L-0016-event-log.md)).

## Rationale

Models change faster than the factory will. Keeping model choice in policy makes it something experiments can tune ([L-0011](L-0011-experiments.md)), and it means an outage, a price change, or a better model is a configuration change, not a rewrite. Recording the exact model makes results attributable when behavior shifts.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - A CI check rejects model and provider identifiers in source outside the policy configuration.
  - The model-call boundary writes model and provider to every call event.
