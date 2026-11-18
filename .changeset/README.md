# Changesets

This folder holds the release notes for PearCore. Every pull request that changes
the published package must include at least one changeset file.

Create one with:

```bash
npm run changeset
```

For changes that do not affect the published package (documentation, CI,
repository chores), create an empty changeset instead:

```bash
npm run changeset -- --empty
```

A changeset is a Markdown file with YAML frontmatter that declares the release
impact for each affected package:

```md
---
'pearcore': minor
---

Add sharelink expiration to `core.space`.
```

Valid bump types are `patch`, `minor`, and `major`. While PearCore is below
`1.0.0`, breaking changes use `minor`; reserve `major` for the deliberate
`1.0.0` release. Merging the pull request collects the changesets;
`npm run release:version` applies them to the package version and changelog.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the full workflow.
