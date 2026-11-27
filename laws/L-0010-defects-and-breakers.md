---
id: L-0010
title: Defects are corrected, traced, and counted against the lane
status: active
derives_from: ["Art. III §4", "Art. IV §3", "Art. IV §4"]
enforcement: [advisory]
---

## Statement

1. When evaluation catches a defect in shipped work, the factory MUST correct it by fixing or reverting, without waiting for a human. If the correction is itself irreversible or reserved, Art. III §5–6 apply. If the lane that shipped the work is closed or out of budget, the factory MUST escalate to an approver instead.
2. Every escaped defect MUST be traced to the earliest point where it could have been caught, and the trace MUST be recorded.
3. Every lane has a circuit breaker whose thresholds are part of the protected core. While a lane's breaker is tripped, every merge and release in that lane MUST require approval from an approver. The one exception is a pure revert of the lane's own changes, which MAY merge and release without approval. A forward fix MAY NOT.
4. Only an approver may reset a tripped breaker. The factory MAY trip a breaker, or tighten a lane's restrictions, at any time.
5. Once a defect is recorded, only an approver may change its classification or the lane it is attributed to. Agents MUST NOT split defects or restructure lanes to avoid tripping a breaker.

## Rationale

Full autonomy is acceptable because mistakes are caught and corrected. The circuit breaker covers the case where they are caught too often: a lane with a poor track record loses its autonomy until a human has looked at what went wrong.

Tightening is automatic and loosening is human-only. That asymmetry makes the safe direction cheap and the risky direction deliberate.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime tracks defects per lane against the protected thresholds and blocks merges and releases while a breaker is tripped.
  - The trace record is required before a defect can close.
