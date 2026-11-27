# straight-facts

An autonomous software factory built on omp. Its aims and its limits are set by the [Constitution](CONSTITUTION.md) and the [laws](laws/README.md).

## Before your first commit

Secrets and personal data must never be committed ([L-0038](laws/L-0038-nothing-sensitive-committed.md)). Once per clone, install the pinned scanner and enable the pre-commit hook:

```sh
scripts/install-betterleaks.sh        # installs to ~/.local/bin
git config core.hooksPath .githooks
```

CI runs the same scan over the full history on every push and pull request.
