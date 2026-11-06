import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

/**
 * The drizzle database handle used across PearCore (better-sqlite3 driver, no
 * relational schema attached; queries go through the table objects).
 */
export type Database = BetterSQLite3Database;
