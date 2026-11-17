import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import {
  createDatabase,
  loadDatabase,
  loadAccountDatabase,
} from '../../../src/database/database.js';
import { createAccount } from '../../../src/utils/accounts.utils.js';
import { makeTempDir, createSandbox, cleanup } from '../../helpers/general.utils.js';
import type BetterSqlite3 from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../../migrations');

async function tableExists(sqlite: BetterSqlite3.Database, table: string) {
  return !!sqlite
    .prepare(
      `
    SELECT name FROM sqlite_master
    WHERE type='table' AND name=?
  `,
    )
    .get(table);
}

describe('database lifecycle', () => {
  let sandbox: { root: string; dbPath: string };

  beforeEach(async () => {
    sandbox = await createSandbox();
  });

  afterEach(async () => {
    await cleanup(sandbox.root);
  });

  it('createDatabase creates sqlite file and runs migrations', async () => {
    const { sqlite } = await createDatabase(sandbox.dbPath, MIGRATIONS_DIR);

    await fs.access(sandbox.dbPath);

    expect(await tableExists(sqlite, '__drizzle_migrations')).toBe(true);
    sqlite.close();
  });

  it('loadDatabase applies WAL pragmas', async () => {
    const { sqlite: created } = await createDatabase(
      sandbox.dbPath,
      MIGRATIONS_DIR,
    );
    created.close();

    const { sqlite } = await loadDatabase(sandbox.dbPath, MIGRATIONS_DIR);

    expect(
      (sqlite.pragma('journal_mode', { simple: true }) as string).toLowerCase(),
    ).toBe('wal');
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBe(5000);

    sqlite.close();
  });

  it('loadDatabase throws when file missing', async () => {
    const missing = path.join(sandbox.root, 'missing.sqlite');

    await expect(loadDatabase(missing, MIGRATIONS_DIR)).rejects.toThrow();
  });
});

describe('account database integration', () => {
  let root: string;
  const username = 'alice';
  const password = 'secure-password';

  beforeEach(async () => {
    root = await makeTempDir();
    await createAccount(username, password, root);
  });

  afterEach(async () => {
    await cleanup(root);
  });

  it('creates database for account', async () => {
    const { sqlite } = await loadAccountDatabase(
      username,
      root,
      MIGRATIONS_DIR,
    );

    expect(await tableExists(sqlite, '__drizzle_migrations')).toBe(true);
    sqlite.close();
  });
});
