---
id: L-0028
title: Dependencies pass the supply-chain gate
status: active
derives_from: ["Art. VII §6"]
enforcement: [advisory]
---

## Statement

1. The factory MAY add or upgrade a third-party dependency only if:
   1. it is pinned to an exact version with an integrity hash;
   2. its license is on the license allowlist;
   3. it has no known vulnerabilities at or above the severity threshold;
   4. the change states why the dependency is needed and why existing dependencies or the standard library do not cover the need.
2. The license allowlist and severity threshold are part of the protected core ([L-0001](L-0001-protected-core.md)).
3. A vulnerability later found in an existing dependency is a defect ([L-0010](L-0010-defects-and-breakers.md)).

## Rationale

Every dependency is code the factory runs but did not write or verify. The gate keeps routine additions autonomous while making each one visible, pinned, and legally safe.

Protecting the allowlist and threshold stops the factory from lowering the bar to fit the dependency it wants.

## Enforcement

- **In force:** none (advisory). The license allowlist and vulnerability threshold are declared in `supply-chain.yml`, which is protected core. Checks against them are done by hand and recorded in the pull request that adds each dependency.
- **Planned:**
  - A CI gate checks the lockfile, license, and vulnerabilities on every change to the dependency manifest, against `supply-chain.yml`.
