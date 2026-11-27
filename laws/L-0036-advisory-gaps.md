---
id: L-0036
title: Advisory laws are tracked as gaps
status: active
derives_from: ["Art. IX §7", "Art. V §2"]
enforcement: [advisory]
---

## Statement

1. The status surface ([L-0032](L-0032-reporting.md)) MUST list every active law whose `enforcement` is `advisory`, together with a proposed mechanism for enforcing it.
2. The `enforcement` field of a law MUST list only mechanisms that are in force. When a mechanism comes into force or is removed, the field MUST be updated in the same change.
3. The index in `laws/README.md` MUST match each law's frontmatter.

## Rationale

A law that nothing enforces depends on agents choosing to comply, which Art. V §2 says is no basis for enforcement. Making the gap visible lets humans charter lanes to close it, in order of risk.

Clause 2 keeps the enforcement field trustworthy. An agent reading `enforcement: [ci]` can rely on CI actually blocking a violation.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - A CI check validates frontmatter against the index.
  - The status surface derives its list of gaps from the law files.
