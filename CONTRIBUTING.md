# Contributing to PearCore

Thanks for helping improve PearCore. This guide covers local setup, the GitFlow
branch model, commit and pull request conventions, and the release-impact
changesets we require.

<br>

## Requirements

- Node.js 22 or newer
- Git
- A C/C++ toolchain if your platform has no prebuilt binaries for
  `better-sqlite3` or `sqlite3`

<br>

## Local setup

```bash
git clone https://github.com/peardrive/pearcore.git
cd pearcore
npm install
```

`npm install` runs the `prepare` script, which builds `dist/`.

Run every check in one go:

```bash
npm run precommit
```

This runs the type check, builds the package, executes the Vitest suite once,
and builds the documentation site.

<br>

### Documentation

```bash
npm run docs:dev
npm run docs:build
npm run docs:preview
```

<br>

## Branch model (GitFlow)

| Branch              | Created from | Merges into       | Purpose                                  |
| ------------------- | ------------ | ----------------- | ---------------------------------------- |
| `main`              | —            | —                 | Production; every merge is a release     |
| `develop`           | `main`       | —                 | Integration branch and default PR target |
| `feature/<slug>`    | `develop`    | `develop`         | Features and non-urgent fixes            |
| `docs/<slug>`       | `develop`    | `develop`         | Documentation and site changes           |
| `release/<version>` | `develop`    | `main`, `develop` | Stabilize and version a release          |
| `hotfix/<version>`  | `main`       | `main`, `develop` | Urgent production fixes                  |

Branch names are lowercase and hyphen-separated:

```text
feature/sharelink-expiration
feature/negentropy-batching
docs/contributing-guide
release/0.3.0
hotfix/0.2.1
```

Never commit directly to `main` or `develop`.

<br>

### First-time migration

If `develop` does not exist yet:

```bash
git checkout main
git pull
git checkout -b develop
git push -u origin develop
```

Then set `develop` as the default branch in GitHub under
**Settings → Branches**, and protect both `main` and `develop` by requiring the
`checks` and `changeset` status checks before merging.

Open pull requests against `develop`. Only `release/*` and `hotfix/*` pull
requests target `main`.

<br>

## Commit messages

This project follows [Conventional Commits](https://www.conventionalcommits.org/):

```text
<type>(<scope>): <summary>
```

- **type** — `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `build`, `ci`,
  `chore`, `style`, or `revert`
- **scope** — optional area: `accounts`, `spaces`, `profiles`, `messages`,
  `files`, `networking`, `database`, `core`, `docs`, or `deps`
- **summary** — imperative mood, lowercase, no trailing period, roughly 72
  characters or fewer

Examples:

```text
feat(spaces): add sharelink expiration
fix(files): retry chunk requests after a timeout
docs(readme): link the contributing guide
test(messages): cover negentropy reconciliation
chore(deps): bump hyperswarm to 4.16.0
```

Mark breaking changes with `!` and a footer:

```text
feat(api)!: rename core.space to core.spaces

BREAKING CHANGE: callers must use core.spaces; the previous method was removed.
```

<br>

## Release impact (changesets)

Commit messages describe intent. Release impact is declared separately with
[Changesets](https://github.com/changesets/changesets), so every change states
its semver level explicitly and reviewably.

Every pull request must include a changeset file. Combined with squash merges,
this means every commit on `develop` carries its own impact declaration.

Create one with:

```bash
npm run changeset
```

Select the `pearcore` package and a bump:

| Bump    | Use it for                                                       | Example from 0.2.1 |
| ------- | ---------------------------------------------------------------- | ------------------ |
| `patch` | Backwards-compatible fix or internal change                      | 0.2.2              |
| `minor` | Backwards-compatible feature, or any breaking change below 1.0.0 | 0.3.0              |
| `major` | Only when declaring the API stable (the 1.0.0 release)           | 1.0.0              |
| empty   | No release: docs, CI, tests, or repository chores                | unchanged          |

PearCore is pre-1.0, so `major` is reserved for the deliberate 1.0.0 release.
Until that release, breaking changes ship as `minor`. A `major` changeset today
would jump straight from `0.2.1` to `1.0.0` and declare the API stable by
accident. When you do decide to stabilize, cut a `release/1.0.0` branch and use
a `major` changeset there.

For changes that do not affect the published package, create an empty
changeset:

```bash
npm run changeset -- --empty
```

Commit the generated `.changeset/*.md` file with the rest of your change. Check
it locally with:

```bash
npm run changeset:check
```

CI runs the same check against the pull request base branch and fails when a
changeset is missing. It also runs `npm run changeset:guard`, which rejects a
`major` bump while the package is below `1.0.0`.

Do not edit the version in `package.json` or the changelog by hand. Changesets
applies those during a release.

<br>

## Pull requests

- Target `develop`, except `release/*` and `hotfix/*` which target `main`.
- Use a Conventional Commit title, for example
  `feat(accounts): add BIP39 recovery`.
- Describe what changed, why, and how you tested it.
- Link the issue the pull request closes.
- Keep the pull request focused on one logical change.
- Prefer squash merge so the pull request title becomes the commit on
  `develop`.
- Wait for the `checks` and `changeset` CI jobs before merging.

<br>

## Release flow

1. Create `release/<version>` from `develop`.
2. Run `npm run release:version` to apply the collected changesets.
3. Run `npm install --package-lock-only` so `package-lock.json` matches the new
   version.
4. Commit the version, lockfile, and changelog updates.
5. Open a pull request to `main` and merge it.
6. Tag the merge commit on `main` and push the tag:

   ```bash
   git checkout main
   git pull
   git tag -a v0.2.1 -m "PearCore 0.2.1"
   git push origin v0.2.1
   ```

   The `Release` workflow verifies the tag against `package.json`, runs the type
   check and tests, packs the tarball, and publishes a GitHub Release with that
   tarball attached. Consumers install the release asset.

   Before pushing, `npm run release:verify-tag -- v0.2.1` runs the same check
   locally.

7. Merge `main` back into `develop`.

Hotfixes follow the same flow from `main`, with a `patch` changeset and a
`hotfix/<version>` branch.

<br>

## Style notes

- Keep formatting consistent with the file you are editing.
- Update the documentation when behavior changes.
- Do not commit `dist/`, local databases, logs, or environment files.
