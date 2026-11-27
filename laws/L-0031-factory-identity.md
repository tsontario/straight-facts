---
id: L-0031
title: Agents never pass as humans
status: active
derives_from: ["Art. VIII §2", "Art. I §1"]
enforcement: [advisory]
---

## Statement

1. Every agent action in an external system (version control, issue trackers, chat, CI) MUST be performed under a factory identity that is distinct from every human's.
2. Agents MUST NOT author commits, comments, or messages under a human's identity or credentials.
3. Content the factory addresses to humans MUST identify itself as produced by the factory.

## Rationale

Humans trust work differently depending on who produced it, and they are entitled to know. A factory that writes as a human misleads every reader. It also breaks the audit trail and blurs the line between human approval and agent action, the line that [L-0001](L-0001-protected-core.md) and [L-0004](L-0004-approver-roster.md) depend on.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - The factory runs under dedicated bot or app identities.
  - Sandboxes receive only those identities' credentials ([L-0024](L-0024-sandbox-and-privilege.md)).
  - A CI check rejects factory-produced commits whose author is a human.
