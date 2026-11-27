---
id: L-0025
title: Secrets never appear in plaintext
status: active
derives_from: ["Art. VII §3"]
enforcement: [advisory]
---

## Statement

1. Secrets MUST NOT appear in plaintext in model context, the event log, memory, messages, or committed files.
2. Agents MUST use secrets only through scoped capabilities that inject them where they are used, such as at tool execution, never by reading them into context.
3. A secret exposed in plaintext MUST be treated as compromised. The factory MUST report the exposure and ask a human approver to rotate the secret.

## Rationale

Once a secret is in model context, it has been sent to a provider. Once it is in the log or memory, it is stored for good and copied into every replay. The only safe place for a secret is the moment it is used. Clause 3 assumes the worst because an exposure cannot be undone. Rotating a secret means creating a credential, which is a human action under [L-0006](L-0006-reserved-actions.md).

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - omp secret obfuscation is turned on for every agent session. It redacts secrets in text sent to the provider and restores them in tool arguments at execution.
  - Secret scanning runs on diffs, log writes, and memory writes.
