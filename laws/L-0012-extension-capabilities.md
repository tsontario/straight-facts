---
id: L-0012
title: Extensions hold only declared capabilities
status: active
derives_from: ["Art. IV §6"]
enforcement: [advisory]
---

## Statement

1. Every extension MUST declare the contract version it implements and the capabilities it needs: files, network destinations, credentials, and tools.
2. The core MUST grant an extension only the capabilities it declared and MUST deny everything else.
3. Installing or upgrading an extension that needs capabilities beyond those previously approved for that extension counts as widening access ([L-0006](L-0006-reserved-actions.md)).
4. Extensions MUST NOT disable, bypass, or alter the core's enforcement of the Constitution and laws.
5. The core MUST NOT contain logic specific to any particular extension.

## Rationale

A small core stays trustworthy only if extensions cannot reach around it. Declared capabilities make every extension's reach visible and reviewable. Clause 3 stops extensions from becoming a back door around the reserved-action rule. Clause 5 keeps the core small: once the core special-cases an extension, that extension has become part of the core.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The runtime sandboxes each extension to its declared capabilities.
  - Contract versions are checked when an extension loads.
