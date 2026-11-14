// @ts-nocheck
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import {
  createDatabase,
  loadDatabase,
  loadAccountDatabase,
} from '../src/database/database.js';
import { accountDotDir } from '../src/utils/accounts.utils.js';

let TEST_ROOT = null;
let MIGRATIONS_DIR = null;
let lastSqlite = null; // track sqlite so we can close it in afterEach

describe('Database Utils', () => {
  beforeEach(async () => {
    // Temporary root for all tests
    TEST_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'dbtest-'));

    // Migrations fixture
    MIGRATIONS_DIR = path.join(TEST_ROOT, 'migrations');

    // Ensure migrations folder is copied or created
    // (You should replace this with a copy from your real migrations dir)
    await fs.mkdir(path.join(MIGRATIONS_DIR, 'meta'), { recursive: true });

    // Empty valid journal file so Drizzle doesn’t crash
    await fs.writeFile(
      path.join(MIGRATIONS_DIR, 'meta', '_journal.json'),
      JSON.stringify({ version: 1, dialect: 'sqlite' }, null, 2),
    );

    // Fake SQL file (Drizzle only checks that it exists)
    await fs.writeFile(
      path.join(MIGRATIONS_DIR, '0001_init.sql'),
      '-- test migration',
    );
  });

  beforeEach(async () => {
    TEST_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'dbtest-'));
    MIGRATIONS_DIR = path.join(TEST_ROOT, 'migrations');

    // Create migrations folder and meta
    await fs.mkdir(path.join(MIGRATIONS_DIR, 'meta'), { recursive: true });

    // Correct journal
    await fs.writeFile(
      path.join(MIGRATIONS_DIR, 'meta', '_journal.json'),
      JSON.stringify({ entries: [] }, null, 2),
    );

    // Fake SQL file
    await fs.writeFile(
      path.join(MIGRATIONS_DIR, '0001_init.sql'),
      '-- test migration',
    );
  });

  function record(sqlite) {
    // helper so every test can set sqlite for cleanup
    lastSqlite = sqlite;
  }

  it('should create a new SQLite database and apply migrations', async () => {
    const dbPath = path.join(TEST_ROOT, 'newdb.sqlite');

    const { sqlite, db } = await createDatabase(dbPath, MIGRATIONS_DIR);
    record(sqlite);

    await expect(fs.access(dbPath)).resolves.not.toThrow();

    expect(sqlite).toBeDefined();
    expect(typeof sqlite.prepare).toBe('function');

    expect(db).toBeDefined();
    expect(typeof db.select).toBe('function');
  });

  it('should throw if migrations directory is missing when creating DB', async () => {
    const dbPath = path.join(TEST_ROOT, 'missing.sqlite');
    const badMigrations = path.join(TEST_ROOT, 'does-not-exist');

    await expect(createDatabase(dbPath, badMigrations)).rejects.toThrow(
      /Migrations directory not found/,
    );
  });

  it('should load an existing SQLite database', async () => {
    const dbPath = path.join(TEST_ROOT, 'existing.sqlite');

    const created = await createDatabase(dbPath, MIGRATIONS_DIR);
    record(created.sqlite);

    const loaded = await loadDatabase(dbPath, MIGRATIONS_DIR);
    record(loaded.sqlite);

    expect(loaded.sqlite).toBeDefined();
    expect(loaded.db).toBeDefined();
  });

  it('should throw if database file does not exist when loading', async () => {
    const missingPath = path.join(TEST_ROOT, 'not-here.sqlite');

    await expect(loadDatabase(missingPath, MIGRATIONS_DIR)).rejects.toThrow(
      /Database file missing/,
    );
  });

  it('should throw if migrations directory is missing when loading DB', async () => {
    const dbPath = path.join(TEST_ROOT, 'test.sqlite');

    const created = await createDatabase(dbPath, MIGRATIONS_DIR);
    record(created.sqlite);

    const badMigrations = path.join(TEST_ROOT, 'does-not-exist');

    await expect(loadDatabase(dbPath, badMigrations)).rejects.toThrow(
      /Migrations directory not found/,
    );
  });

  it('should create database if it does not exist (loadAccountDatabase)', async () => {
    const username = 'alice';

    const result = await loadAccountDatabase(
      username,
      TEST_ROOT,
      MIGRATIONS_DIR,
    );
    record(result.sqlite);

    expect(result).toBeDefined();
    expect(result.sqlite).toBeDefined();

    const dbPath = path.join(
      accountDotDir(username, TEST_ROOT),
      'spacebook.sqlite',
    );
    await expect(fs.access(dbPath)).resolves.not.toThrow();
  });

  it('should load existing database (loadAccountDatabase)', async () => {
    const username = 'bob';
    const dbPath = path.join(
      accountDotDir(username, TEST_ROOT),
      'spacebook.sqlite',
    );

    const created = await createDatabase(dbPath, MIGRATIONS_DIR);
    record(created.sqlite);

    const loaded = await loadAccountDatabase(
      username,
      TEST_ROOT,
      MIGRATIONS_DIR,
    );
    record(loaded.sqlite);

    expect(loaded).toBeDefined();
    expect(loaded.sqlite).toBeDefined();
  });

  it('should throw if migrations directory is missing (loadAccountDatabase)', async () => {
    const username = 'carol';
    const badMigrations = path.join(TEST_ROOT, 'missing-migrations');

    await expect(
      loadAccountDatabase(username, TEST_ROOT, badMigrations),
    ).rejects.toThrow(/Migrations directory not found/);
  });
});
