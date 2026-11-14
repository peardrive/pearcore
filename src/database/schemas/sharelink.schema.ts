import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';

/**
 * Sharelinks table definition.
 *
 * Represents a single distributed "sharelink".
 * Each sharelink is uniquely identified by `id` and `nonce`.
 *
 * Columns:
 * - id: Primary key. Unique integer identifier for the sharelink.
 * - spaceName: Human-readable name of the space.
 * - publicKey: Public key of the creator or owner of the space.
 * - nonce: unique identity randomly generated for each space (part of sharelink)
 * - timestamp: Unix timestamp indicating when the sharelink was inserted.
 */
export const sharelinks = sqliteTable('sharelinks', {
  id: integer('id').primaryKey(),

  // sharelink required parameters
  spaceName: text('space_name').notNull(),
  publicKey: text('public_key').notNull(),
  nonce: text('nonce').notNull(),

  timestamp: integer('timestamp').notNull(),
});
