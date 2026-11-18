/**
 * Shared helpers for the changeset release guards.
 */

import { readdirSync } from 'node:fs';
import { join } from 'node:path';

export const CHANGESET_DIR = '.changeset';
export const VALID_BUMPS = new Set(['patch', 'minor', 'major']);

export function listChangesetFiles(dir = CHANGESET_DIR) {
  return readdirSync(dir)
    .filter((file) => file.endsWith('.md') && file !== 'README.md')
    .sort();
}

/**
 * Parses the simple `'package': bump` frontmatter changesets use.
 * Returns `null` when the file has no frontmatter block, and an `error`
 * property when a frontmatter line cannot be understood.
 */
export function parseFrontmatter(text) {
  const match = text
    .replace(/^\uFEFF/, '')
    .match(/^---\r?\n([\s\S]*?)\r?\n?---(?:\r?\n|$)/);

  if (!match) return null;

  const entries = [];

  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const entry = line.match(
      /^("([^"]+)"|'([^']+)'|([^:]+)):\s*("([^"]+)"|'([^']+)'|(\S+))\s*$/,
    );

    if (!entry) {
      return {
        entries: null,
        error: `cannot parse frontmatter line "${line}"`,
      };
    }

    entries.push({
      name: (entry[2] ?? entry[3] ?? entry[4]).trim(),
      bump: (entry[6] ?? entry[7] ?? entry[8]).toLowerCase(),
    });
  }

  return { entries, error: null };
}

export function changesetPath(file, dir = CHANGESET_DIR) {
  return join(dir, file);
}
