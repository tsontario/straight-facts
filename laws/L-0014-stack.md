---
id: L-0014
title: The factory is TypeScript on Bun
status: active
derives_from: ["Art. V §1", "Art. I §1"]
enforcement: [advisory]
---

## Statement

1. The control plane and the factory's extensions MUST be written in TypeScript and run on Bun.
2. TypeScript MUST be compiled with strict type checking enabled.
3. Adding another language or runtime for a factory component requires amending this law.

## Rationale

omp is TypeScript on Bun. Matching it gives direct access to the SDK, lets the control plane and its extensions share types, and means there is one toolchain to understand. Strict typing turns a class of defects into compile errors, which is the cheapest gate there is. Requiring an amendment to add a language stops the stack from fragmenting one experiment at a time.

## Enforcement

- **In force:** none (advisory).
- **Planned:** CI runs the type checker in strict mode and rejects source files in other languages outside an allowlist.
