---
id: L-0028
title: Dependencies pass the supply-chain gate
status: active
derives_from: ["Art. VII §6"]
enforcement: [ci]
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

- **In force:** `ci`, for container images only (decision 0002 §6, the image rule in `supply-chain.yml`).
  - The publishing workflow on `main` scans each sandbox and gateway image with the Trivy pinned in `images/images.toml` before pushing it, and refuses it on a critical finding.
  - Branch protection on `main` requires the `checks` job. It verifies each pinned image's build provenance attestation from the publishing workflow on `main` and checks that its commit is on `main`. A pull request that sets a pin must pin the image built from the inputs on its base.
  - The weekly rescan (`.github/workflows/rescan.yml`) fails when a pinned image has a critical finding, or when its pin is more than 31 days old.
- **Not yet in force:** every other dependency. The license allowlist and vulnerability threshold are declared in `supply-chain.yml`, which is protected core. Checks against them are done by hand and recorded in the pull request that adds each dependency.
- **Planned:**
  - A CI gate checks the lockfile, license, and vulnerabilities on every change to the dependency manifest, against `supply-chain.yml`.
  - The launcher refuses to start a task while the latest rescan flags either of its pinned images (decision 0002 §6).
