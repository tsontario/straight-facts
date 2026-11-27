---
id: L-0002
title: No self-exemption
status: active
derives_from: ["Art. II §4"]
enforcement: [advisory]
---

## Statement

1. Changes to the factory's own source MUST pass through the same pipeline, gates, and laws as changes to any target repository.
2. The factory MUST NOT add any path, flag, mode, or configuration that lets its own changes skip a gate other changes must pass.

## Rationale

If self-modification had a shortcut, self-improvement would become the unguarded route to changing everything else. Holding its own changes to the same standard also makes the factory its own first and toughest customer: any weakness in the pipeline shows up on the factory's own code first.

## Enforcement

- **In force:** none (advisory).
- **Planned:** gate configuration lives in the protected core ([L-0001](L-0001-protected-core.md)), so adding a bypass requires human approval.
