---
id: L-0038
title: Nothing secret or personal is committed
status: active
derives_from: ["Art. VII §3", "Art. I §1", "Art. III §5"]
enforcement: [advisory]
---

## Statement

1. No commit to this repository, and no commit the factory makes in any repository, may add a secret or personal data. This applies to file contents, file names, commit messages, branch and tag names, and commit metadata.
   - *Secrets* include credentials, tokens, API keys, passwords, private keys and certificates, and connection strings that embed credentials ([L-0025](L-0025-secrets.md)).
   - *Personal data* is any information about an identifiable person. That includes names tied to contact details, email addresses, phone numbers, postal addresses, government identifiers, financial account numbers, health information, precise locations, and any user data from production ([L-0029](L-0029-production-access.md)).
   - The one exception is the approver roster, which identifies approvers by platform handle only ([L-0004](L-0004-approver-roster.md)).
2. Test fixtures and examples MUST use values that are obviously synthetic: `example.com` addresses, documented placeholder keys, and fictional people.
3. Every change MUST pass a scan for secrets and personal data before it is committed, and again before it merges. Any finding blocks the change.
4. Only the scanner configuration can suppress a finding. Inline allow comments and ignore files MUST NOT be honored. The scanner configuration, the pre-commit hook, the CI workflow, and the pinned scanner version are part of the protected core ([L-0001](L-0001-protected-core.md)). Adding a detection rule makes scanning stricter ([L-0023](L-0023-ratchet.md)). Adding or widening a filter loosens it and needs an approver.
5. Commit author and committer emails MUST be non-personal: either a platform noreply address or a factory identity address ([L-0031](L-0031-factory-identity.md)).
6. If a secret or personal data is committed anyway, the factory MUST stop work on that change and report the exposure to an approver ([L-0032](L-0032-reporting.md) §2).
   - A committed secret is compromised and MUST be rotated ([L-0025](L-0025-secrets.md) §3).
   - Removing data from published history destroys history, and that needs an approver ([L-0006](L-0006-reserved-actions.md)).
7. Scanners recognize patterns, not meaning. Verifiers MUST also check every change for personal data a scanner cannot recognize, such as names and postal addresses ([L-0020](L-0020-independent-verification.md)).

## Rationale

Once a commit is pushed, its contents are effectively permanent. Clones, forks, caches, and mirrors keep copies that no rewrite can reach. Prevention is therefore the only real control, and it has to happen before the commit, not after.

Pattern scanning catches the common cases cheaply. Synthetic fixtures (clause 2) keep the scanner quiet enough that its findings are taken seriously. Clause 4 closes the two quiet escape hatches every scanner ships with, inline allow comments and ignore files, so a finding can be suppressed only by a reviewable change to protected configuration. Clause 7 admits what scanners miss and assigns it to review.

## Enforcement

- **In force:** none fully, so the law stays advisory.
  - The pre-commit hook (`.githooks/pre-commit`) blocks findings, and blocks author or committer emails that are not noreply addresses. It does this only in clones that enable it.
  - The CI workflow (`.github/workflows/secret-scan.yml`) scans the full history on every push and pull request. Its result is reported but not yet required for merging.
  - GitHub secret scanning with push protection is enabled for the repository. It blocks pushes that contain secret types GitHub recognizes. It does not detect personal data.
- **Planned:**
  - Branch protection on `main` requires the `secret-scan` check, which makes this law `ci`. This arrives with the pull-request workflow.
  - The factory runs the same scan, with the same pinned scanner and configuration, before every commit it makes in any repository.
  - A CI check rejects pushed commits whose author or committer email is not on the allowed list in clause 5.
