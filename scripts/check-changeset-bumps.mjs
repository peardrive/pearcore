#!/usr/bin/env node

/**
 * Rejects `major` changesets while the package version is below 1.0.0.
 *
 * Changesets applies plain semver, so a `major` bump on 0.x jumps straight to
 * 1.0.0 and declares the public API stable. Until that release is deliberate,
 * breaking changes must be declared as `minor`. See CONTRIBUTING.md.
 */

import { readFileSync } from 'node:fs';

import {
  CHANGESET_DIR,
  VALID_BUMPS,
  changesetPath,
  listChangesetFiles,
  parseFrontmatter,
} from './changeset-utils.mjs';

function readVersion() {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  const [major] = String(pkg.version).split('.');
  const majorNumber = Number(major);

  if (!Number.isInteger(majorNumber)) {
    console.error(`Cannot parse the package version "${pkg.version}".`);
    process.exit(2);
  }

  return { major: majorNumber, version: pkg.version };
}

const { major, version } = readVersion();

if (major >= 1) {
  console.log(`pearcore is ${version}; major changesets are allowed.`);
  process.exit(0);
}

let files;

try {
  files = listChangesetFiles();
} catch {
  console.error(`Cannot read the ${CHANGESET_DIR}/ directory.`);
  process.exit(2);
}

const problems = [];

for (const file of files) {
  const parsed = parseFrontmatter(readFileSync(changesetPath(file), 'utf8'));

  if (!parsed) {
    problems.push(`${file}: missing frontmatter block`);
    continue;
  }

  if (parsed.error) {
    problems.push(`${file}: ${parsed.error}`);
    continue;
  }

  for (const { name, bump } of parsed.entries) {
    if (!VALID_BUMPS.has(bump)) {
      problems.push(
        `${file}: ${name} has invalid bump "${bump}" (use patch, minor, or major)`,
      );
      continue;
    }

    if (bump === 'major') {
      problems.push(
        `${file}: ${name} declares "major" while pearcore is ${version}; use "minor" until the 1.0.0 release`,
      );
    }
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`x ${problem}`);
  console.error(
    `\n${problems.length} changeset problem(s). See CONTRIBUTING.md for the pre-1.0 bump policy.`,
  );
  process.exit(1);
}

console.log(
  `Checked ${files.length} changeset file(s): no pre-1.0 major bumps at ${version}.`,
);
