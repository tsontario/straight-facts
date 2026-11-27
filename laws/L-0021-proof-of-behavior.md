---
id: L-0021
title: Behavior changes prove themselves
status: active
derives_from: ["Art. VI §3", "Art. I §1"]
enforcement: [advisory]
---

## Statement

1. Every change that alters behavior MUST include a check that fails without the change and passes with it. The gate MUST run the check in both states and record both results.
2. A bugfix MUST first reproduce the bug as a failing check.
3. A change declared to preserve behavior MUST pass the existing checks. If it modifies existing checks, it counts as a behavior change.
4. Where a behavior cannot be checked automatically, the change MUST carry recorded evidence of the behavior before and after, and the verifier MUST confirm it.
5. Coverage metrics MAY inform verification but MUST NOT satisfy this law.
6. Removing, skipping, or loosening an existing test in a target repository is allowed only when an acceptance criterion set by someone other than the doer calls for it.

## Rationale

A test that passes both with and without a change proves nothing about that change. Running both states turns "I added a test" into evidence. Reproducing a bug first proves the fix addresses that bug and not something nearby.

Clause 3 catches a common way to hide breakage: a supposedly safe refactor that quietly rewrites the tests it would otherwise fail. Coverage counts lines executed, not behavior verified.

## Enforcement

- **In force:** none (advisory).
- **Planned:**
  - A gate runs new and changed checks against the parent and child revisions and records both outcomes.
  - The task kind declares whether a change preserves behavior.
