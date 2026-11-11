import path from 'node:path';
import fs from 'node:fs/promises';
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import type { Database as DrizzleDatabase } from '../types/database.js';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { accountDotDir } from '../utils/accounts.utils.js';
import { DRIZZLE_MIGRATIONS_PATH } from '../constants/database.constants.js';

/** An open account database: the raw better-sqlite3 handle and its drizzle wrapper. */
export interface DatabaseConnection {
  sqlite: BetterSqlite3.Database;
  db: DrizzleDatabase;
}

/**
 * Ensure the migrations folder exists.
 */
async function ensureMigrationsFolder(migrationsDir: string): Promise<void> {
  try {
    await fs.access(migrationsDir);
  } catch {
    await fs.mkdir(migrationsDir, { recursive: true });
  }
}

/**
 * Create a new SQLite database and apply migrations.
 */
export async function createDatabase(
  dbPath: string,
  migrationsDir: string,
): Promise<DatabaseConnection> {
  await fs.mkdir(path.dirname(dbPath), { recursive: true });

  const sqlite = new Database(dbPath); // creates file if missing
  const db = drizzle(sqlite);

  await ensureMigrationsFolder(migrationsDir);

  // Apply migrations
  await migrate(db, { migrationsFolder: migrationsDir });

  return { sqlite, db };
}

/**
 * Load an existing SQLite database and apply migrations.
 */
export async function loadDatabase(
  dbPath: string,
  migrationsDir: string,
): Promise<DatabaseConnection> {
  try {
    await fs.access(dbPath);
  } catch {
    throw new Error(`Database file missing: ${dbPath}`);
  }

  const sqlite = new Database(dbPath);
  const db = drizzle(sqlite);

  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('busy_timeout = 5000');

  await ensureMigrationsFolder(migrationsDir);

  // Apply migrations
  await migrate(db, { migrationsFolder: migrationsDir });

  return { sqlite, db };
}

/**
 * Loads the database for a given account username.
 * Creates the DB if it does not exist and applies migrations.
 *
 * @param username - The account username.
 * @param root - The root directory where account data is stored.
 * @param [migrationsDir=DRIZZLE_MIGRATIONS_PATH] - Directory containing Drizzle migrations.
 */
export async function loadAccountDatabase(
  username: string,
  root: string,
  migrationsDir: string = DRIZZLE_MIGRATIONS_PATH,
): Promise<DatabaseConnection> {
  const dbPath = path.join(accountDotDir(username, root), 'spacebook.sqlite');

  try {
    await fs.access(dbPath);
    return await loadDatabase(dbPath, migrationsDir);
  } catch {
    // Database file does not exist, create a new one
    return await createDatabase(dbPath, migrationsDir);
  }
}
