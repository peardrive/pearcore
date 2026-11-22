# Release protocol

Repeatable procedure for publishing a PearCore release.

A release is a **push to `main`**. Merging `develop` into `main` — or a
`hotfix/*` branch — triggers `.github/workflows/release.yml`, which:

1. reads the version from `package.json` and checks `package-lock.json` matches,
2. fails if any changeset is still pending (i.e. the version was never prepared),
3. runs the type check and the full test suite,
4. builds, packs `pearcore-<version>.tgz`, verifies its contents and smoke-installs it,
5. tags the commit `v<version>` and pushes the tag,
6. publishes `pearcore@<version>` to npm with provenance,
7. creates a GitHub Release with that version's `CHANGELOG.md` section and the
   tarball attached.

Nothing is tagged or published if any gate fails. You never tag by hand.

Versions are produced by [Changesets](https://github.com/changesets/changesets).
Never edit `package.json`'s version, `package-lock.json`'s version, or
`CHANGELOG.md` by hand.

Placeholders used below: `<version>` (e.g. `0.3.0`), `v<version>` (e.g. `v0.3.0`).

<br>

## 0. One-time setup

Do this once per repository, before the first automated release.

**npm publishing** — pick one:

- **Trusted publishing (recommended).** On npmjs.com, open the `pearcore`
  package → *Settings* → *Trusted publishing*, add a GitHub Actions publisher
  for `peardrive/pearcore` and the workflow file `release.yml`. Then create the
  repository variable `NPM_TRUSTED_PUBLISHING` (Settings → Secrets and
  variables → Actions → Variables) set to `true`. No token expires.
- **Token.** Create a granular npm access token that can publish `pearcore`
  (with 2FA bypass) and add it as the repository secret `NPM_TOKEN`.

Trusted publishing is configured on a package that already exists, so the very
first release needs either the `NPM_TOKEN` secret or a manual
`npm publish ./pearcore-<version>.tgz --access public` from the release tarball.
Switch to trusted publishing afterwards if you want tokenless releases.

Without either option, the workflow still creates the GitHub Release tarball but
skips the npm publish step with a warning.

**Repository settings** — Settings → Actions → General → Workflow permissions:
*Read and write permissions* (the workflow pushes the tag and creates the
release).

**Branch protection** — require the `checks`, `changeset` and `release-source`
jobs on pull requests, and restrict direct pushes to `main`.

<br>

## 1. Pre-flight

Run from a clean checkout of the integration branch. Every item must pass before
you version anything.

```bash
git checkout develop
git pull
git status --short                 # must be empty
git ls-remote --tags origin        # v<version> must NOT be listed
```

Confirm the release scope:

```bash
npm run changeset:check            # lists the pending changesets
npm run changeset:guard            # rejects pre-1.0 "major" bumps
```

Read the pending changesets. If they do not describe what you intend to ship,
stop and fix the changesets first — the version is derived from them, not chosen.

<br>

## 2. Prepare the release

```bash
npm run release:prepare
```

The script checks that you are on an up-to-date, clean `develop`, rejects
pre-1.0 `major` bumps, creates `release/v<version>`, runs `changeset version`
(bumps `package.json`, writes `CHANGELOG.md`, deletes the consumed changesets),
syncs `package-lock.json`, and commits `chore(release): <version>`.

A release requires at least one **non-empty** changeset. If every pending
changeset is empty, the script stops and nothing is released.

Check the result: the new version equals the highest bump among the pending
changesets (`patch` → `x.y.z+1`, `minor` → `x.y+1.0`), and `CHANGELOG.md` has a
`## <version>` section. That heading is what the release workflow uses for the
GitHub Release notes.

<br>

## 3. Release pull request into `develop`

```bash
git push -u origin release/<version>
```

Open a PR `release/<version>` → `develop` titled `chore(release): <version>`,
wait for `checks`, and squash-merge it. The `changeset` job is skipped for
`release/*` branches because the PR consumes changesets instead of adding them.

Do not add code changes to this PR. A release branch carries version metadata
only; if a fix is needed, land it on `develop` first and start over.

<br>

## 4. Promote `develop` to `main`

Open a PR `develop` → `main` titled `release: <version>`, merge it with a
**merge commit**.

The `release-source` job enforces this:

- the source branch must be `develop` or `hotfix/*`,
- `v<version>` must not already exist,
- no changesets may be pending.

<br>

## 5. Watch the release workflow

```bash
gh run watch "$(gh run list --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')"
```

The job has these gates, in order:

1. `release:verify-tag` — `package.json` and `package-lock.json` agree, no pending changesets
2. `typecheck`
3. `npm test -- --run`
4. `npm run build` and `npm pack`
5. tarball contents — `package/dist/core.js`, `package/dist/core.d.ts`, `package/migrations/`
6. smoke install — the tarball installs in a fresh project and `pearcore` resolves to `dist/core.js`
7. `git tag v<version>` + push
8. `npm publish pearcore@<version> --provenance`
9. `gh release create v<version>` with `pearcore-<version>.tgz` and `pearcore.tgz`

<br>

## 6. Confirm the release

```bash
git ls-remote --tags origin | grep v<version>
gh release view v<version>                 # tarball assets present
npm view pearcore@<version> version        # registry has the release
```

Installing is the real acceptance test:

```bash
mkdir /tmp/pearcore-smoke && cd /tmp/pearcore-smoke
npm init -y
npm install pearcore@<version>
node -e "console.log(require.resolve('pearcore'))"
```

<br>

## Hotfix variant

Urgent production fix, released from `main` instead of `develop`:

```bash
git checkout main
git pull
git checkout -b hotfix/<version>
# ship the fix, plus a `patch` changeset
npm run release:version
npm install --package-lock-only
npm run release:verify-tag -- v<version>
git commit -am "chore(release): <version>"
git push -u origin hotfix/<version>
```

Open a PR `hotfix/<version>` → `main`, merge it with a merge commit, and the
Release workflow tags and publishes. Then bring the fix back to `develop` with a
normal `fix/*` PR (the changeset was already consumed by the hotfix, so use an
empty changeset if needed).

<br>

## Failure recovery

The workflow is **idempotent**: re-running a failed job is always safe.

- **Failed before the tag step** — nothing was tagged or published. Fix the
  cause, push the fix to `main`, or re-run the job from the Actions tab.
- **Tag exists on the same commit** — the tag step treats it as a retry and
  continues, so the npm publish and GitHub Release assets are completed.
- **Tag exists on another commit** — the job fails. Do not move the tag; cut a
  higher version with `npm run release:prepare`.
- **npm publish failed after tagging** — fix the credential or trusted
  publisher, then re-run the workflow. An already-published version is detected
  and skipped, and the GitHub Release assets are re-uploaded.
- **Release published but broken** — publish a follow-up patch release; do not
  rewrite an existing release's tarball.

To delete a tag that never produced a release:

```bash
git push origin :refs/tags/v<version>
git tag -d v<version>
```

<br>

## Rules and gotchas

- **Every push to `main` must carry a new version.** A direct docs or CI commit
  to `main` hits the "tag already exists" gate and fails; land such changes on
  `develop` and ship them with a release.
- **Only `develop` or `hotfix/*` may target `main`.** The `release-source` job
  enforces it.
- **Do not hand-edit versions.** Changesets owns `package.json`,
  `package-lock.json`, and `CHANGELOG.md`.
- **Pre-1.0 bump policy**: breaking changes ship as `minor`; `major` is reserved
  for a deliberate `1.0.0` (`npm run changeset:guard` enforces this).
- **Every PR needs a changeset**, including docs/CI chores — use an empty one:
  `npm run changeset -- --empty`. An empty changeset produces no release.
- **Do not merge `main` back into `develop`.** After a release, `develop` is
  "1 commit behind" `main` by the release merge commit only; that is expected.
- **The full test suite gates the release**, end-to-end sync included. Do not
  bypass it by pushing an unversioned commit to `main`.
- **One version per release.** If the version is already tagged and published,
  the next attempt must be a higher version.
- **`npm pack` builds via `prepare`**, so the build must pass even though CI
  installs with `--ignore-scripts`.
- **Node 22** is the supported engine (`>=22` in `package.json`); match it
  locally to reproduce CI failures.

<br>

## Copy-paste checklist

```text
[ ] develop is pulled, working tree clean
[ ] v<version> does not exist (git ls-remote --tags origin)
[ ] pending changesets reviewed; changeset:guard passes
[ ] npm run release:prepare created release/<version>
[ ] release/<version> PR -> develop merged (squash)
[ ] develop -> main PR merged (merge commit); release-source green
[ ] Release workflow green: tag pushed, npm published, GitHub Release created
[ ] npm view pearcore@<version> shows the release
[ ] npm install pearcore@<version> works in a scratch project
```
