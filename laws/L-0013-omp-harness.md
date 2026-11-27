---
id: L-0013
title: omp is used through its public surfaces, pinned
status: active
derives_from: ["Art. V §1"]
enforcement: [advisory]
---

## Statement

1. The factory MUST use omp only through its public surfaces: the SDK, RPC mode, extensions, and documented configuration.
2. The factory MUST NOT depend on undocumented omp internals.
3. The omp version MUST be pinned. An upgrade is a change like any other and passes the same gates.
4. The factory MUST NOT fork, vendor, or patch omp. A change the factory needs in omp MUST be proposed upstream. Proposing it is outside communication ([L-0006](L-0006-reserved-actions.md)).

## Rationale

omp changes quickly. Each private patch or dependency on internals is a rebase or a breakage waiting to happen. Using only the public surfaces keeps upgrades cheap, and pinning keeps them deliberate. Sending fixes upstream means the factory benefits from omp improving instead of drifting away from it.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - A CI check rejects imports from non-public omp module paths.
  - The lockfile pins the omp version.
