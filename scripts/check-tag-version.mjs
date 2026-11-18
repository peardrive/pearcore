#!/usr/bin/env node

/**
 * Verifies that a release tag matches the package metadata and that no
 * unconsumed changesets are left behind.
 *
 * Run by `.github/workflows/release.yml` on `v*` tags. It can also be run
 * locally:
 *
 *   npm run release:verify-tag -- v0.2.1
 */

import { readFileSync } from 'node:fs';

import {
  changesetPath,
  listChangesetFiles,
  parseFrontmatter,
} from './changeset-utils.mjs';

const tag = (process.argv[2] ?? process.env.GITHUB_REF_NAME ?? '').trim();

if (!tag) {
  console.error(
    'Usage: node scripts/check-tag-version.mjs <tag> (or set GITHUB_REF_NAME)',
  );
  process.exit(2);
}

const version = tag.startsWith('v') ? tag.slice(1) : tag;

if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Tag "${tag}" does not contain a valid semver version.`);
  process.exit(2);
}

const problems = [];

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));

const candidates = [
  ['package.json', pkg.version],
  ['package-lock.json', lock.version],
  ['package-lock.json packages[""]', lock.packages?.['']?.version],
];

for (const [source, value] of candidates) {
  if (value !== undefined && value !== version) {
    problems.push(`${source} is ${value}, but the tag is ${tag}`);
  }
}

let files = [];

try {
  files = listChangesetFiles();
} catch {
  console.warn('warn: no .changeset/ directory found; skipping pending check');
}

for (const file of files) {
  const parsed = parseFrontmatter(readFileSync(changesetPath(file), 'utf8'));

  if (!parsed) {
    problems.push(`${file}: malformed frontmatter`);
    continue;
  }

  if (parsed.error) {
    problems.push(`${file}: ${parsed.error}`);
    continue;
  }

  for (const { name, bump } of parsed.entries) {
    problems.push(
      `${file}: pending ${bump} changeset for ${name}; run npm run release:version before tagging`,
    );
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`x ${problem}`);
  console.error(
    `\n${problems.length} release problem(s). The tag must match the package version.`,
  );
  process.exit(1);
}

console.log(`Tag ${tag} matches pearcore ${version}; no pending changesets.`);
