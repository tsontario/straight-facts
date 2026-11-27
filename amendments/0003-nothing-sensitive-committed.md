---
id: A-0003
title: Add L-0038, which keeps secrets and personal data out of commits
kind: law
status: approved
proposed: 2026-11-27
approved: 2026-11-27
approvers: ["@tsontario"]
---

## Problem

[L-0025](../laws/L-0025-secrets.md) §1 forbids secrets in committed files. It has four gaps:

- **No personal data.** It does not mention personal data.
- **No metadata or names.** It does not cover commit metadata, file names, or commit messages.
- **No mechanism.** Nothing in the repository enforces it.

The record already shows the gap:

- Every commit in this repository's history carries a personal email address as its author.
- `APPROVERS.md` lists an approver's first name.
- No scanner, hook, or CI check exists.

The default flags of the chosen scanner make the risk concrete. In a test, a staged change containing a personal email address and the inline comment `betterleaks:allow` passed the scanner's pre-commit mode (exit 0). It was blocked (exit 1) only when the scanner was run with `--ignore-gitleaks-allow`.

## Change

Add [L-0038](../laws/L-0038-nothing-sensitive-committed.md) with `status: active`, and add its row to the index in `laws/README.md`.

Add these enforcement mechanisms, all part of the protected core:

- `.betterleaks.toml`: the pinned scanner's default secret rules plus rules for email addresses, international phone numbers, and US Social Security numbers. Its filters allow only synthetic and noreply values.
- `scripts/install-betterleaks.sh`: installs Betterleaks 1.10.1 after checking its SHA-256.
- `.githooks/pre-commit`: scans staged changes and rejects author or committer emails that are not noreply addresses. It fails closed if the scanner is missing or is not the pinned version.
- `.github/workflows/secret-scan.yml`: scans the full history on every push and pull request. The checkout action is pinned by commit SHA.
- `.gitignore`: ignores common secret files.
- `README.md`: setup steps for a new clone.

Bring the record into line with the new law:

- **Roster:** `APPROVERS.md` now lists approvers by handle only. Under [L-0004](../laws/L-0004-approver-roster.md), every listed approver must approve a roster change; @tsontario, the only approver, approved this one.
- **Unpushed commits:** the two governance commits not yet pushed were re-authored with the approver's GitHub noreply address.
- **Published commit:** the first commit, already on GitHub, keeps its author email. Rewriting published history would destroy history ([L-0006](../laws/L-0006-reserved-actions.md)).

## Alternatives

| Option | Why not chosen |
|---|---|
| Gitleaks v8.30.1 | Feature-complete; only security patches since May 2026, and its author now maintains Betterleaks. It has 222 default rules, against Betterleaks' 466. |
| Betterleaks v2 (release candidate) | Not stable. It changes flags, and `-v` switches on validation against live providers. |
| TruffleHog | AGPL-3.0, so it fails the license allowlist ([L-0028](../laws/L-0028-dependencies.md)). It also calls provider APIs and an update server by default. |
| Homebrew `betterleaks` formula | It always installs the latest version, which would move to v2 without warning. The install script pins the version and checks its checksum. |
| GitHub push protection only | It covers only the secret types GitHub supports, and no personal data. It also lives outside the repository. It is planned as an additional layer. |
| Amending L-0025 | L-0025 governs secrets everywhere: model context, logs, memory. Keeping commits out of secrets and personal data is a separate concern, with its own mechanisms. |

## Effects

- Every clone runs `scripts/install-betterleaks.sh` and `git config core.hooksPath .githooks` once.
- Branch protection that requires the `secret-scan` check, and GitHub push protection, are repository settings an approver must turn on. Once branch protection requires the check, an editorial change updates L-0038's enforcement field to `ci` (Art. IX §8).
- The factory's control plane must run the same scan before every commit it makes, in any repository.
