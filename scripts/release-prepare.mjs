#!/usr/bin/env node

/**
 * Prepares a release from `develop`:
 *
 *   1. checks you are on an up-to-date, clean `develop` with pending changesets
 *   2. creates `release/v<next>` and runs `changeset version`
 *      (bumps package.json, writes CHANGELOG.md, deletes the consumed changesets)
 *   3. syncs package-lock.json and commits `chore(release): v<next>`
 *
 * Pushing `develop` to `main` afterwards is what triggers the Release workflow;
 * this script never tags or publishes anything.
 *
 * Usage:
 *
 *   npm run release:prepare
 */

import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';

const run = (command, options = {}) =>
  execSync(command, { stdio: 'inherit', ...options });
const out = (command) => execSync(command, { encoding: 'utf8' }).trim();
const fail = (message) => {
  console.error(`\nx ${message}\n`);
  process.exit(1);
};
const readVersion = () => JSON.parse(readFileSync('package.json', 'utf8')).version;

const branch = out('git rev-parse --abbrev-ref HEAD');

if (branch !== 'develop') {
  fail(`Run this on develop (you are on ${branch}).`);
}

if (out('git status --porcelain')) {
  fail('Working tree is not clean. Commit or stash your changes first.');
}

try {
  out('git remote get-url origin');
} catch {
  fail('No "origin" remote. Add one with: git remote add origin <url>');
}

run('git fetch origin --tags --quiet');

const behind = Number(out('git rev-list --count HEAD..origin/develop'));

if (behind !== 0) {
  fail(
    `develop is ${behind} commit(s) behind origin/develop. Run: git pull --ff-only`,
  );
}

const pending = readdirSync('.changeset').filter(
  (file) => file.endsWith('.md') && file !== 'README.md',
);

if (pending.length === 0) {
  fail('No changesets in .changeset/. Nothing to release.');
}

// Pre-1.0 breaking changes must be `minor`; reject `major` before we version.
run('npm run changeset:guard');

const current = readVersion();
let work = `release/next-${Date.now()}`;

run(`git switch -c ${work} --quiet`);

try {
  run('npm run release:version');

  const next = readVersion();

  if (next === current) {
    throw new Error(
      'changeset version did not change the version; the pending changesets are empty.',
    );
  }

  if (out(`git tag -l "v${next}"`)) {
    throw new Error(`Tag v${next} already exists.`);
  }

  // Keep the lockfile's own version field in step with package.json.
  run(
    'npm install --package-lock-only --ignore-scripts --no-audit --no-fund',
    { stdio: 'ignore' },
  );

  run(`npm run release:verify-tag -- v${next}`);

  const releaseBranch = `release/v${next}`;

  run(`git branch -m ${releaseBranch}`);
  work = releaseBranch;

  run('git add package.json package-lock.json CHANGELOG.md .changeset');
  run(`git commit --quiet -m "chore(release): v${next}"`);

  console.log(`
Prepared ${current} -> ${next} on ${releaseBranch}

Next:
  1. git push -u origin ${releaseBranch}
  2. Open a PR  ${releaseBranch} -> develop
     title: "chore(release): v${next}"   (squash merge)
  3. Open a PR  develop -> main
     title: "release: v${next}"          (merge commit)
  4. Merging into main tags v${next}, publishes pearcore@${next} to npm,
     and creates the GitHub Release automatically.
`);
} catch (error) {
  console.error(`\nx ${error.message}\nRolling back.`);
  run('git reset --hard --quiet');
  run('git switch develop --quiet');
  run(`git branch -D ${work} --quiet`, { stdio: 'ignore' });
  process.exit(1);
}
