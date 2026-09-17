import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { relations } from "drizzle-orm";

/**
 * Spaces table definition.
 *
 * Represents a single distributed "space" within the system.
 * Each space is uniquely identified by an `id` and contains metadata
 * describing its creator, creation time, permissions, and validation signature.
 *
 * Columns:
 * - id: Primary key. Unique integer identifier for the space.
 * - spaceName: Human-readable name of the space.
 * - publicKey: Public key of the creator or owner of the space.
 * - timestamp: Unix timestamp indicating when the space was created.
 *
 * - permissionBroadcast: Integer flag (0/1) indicating whether broadcasting
 *   messages is allowed. When 0, only whitelisted keys may broadcast.
 *
 * - permissionRead: Integer flag (0/1) indicating whether reading message
 *   history is allowed. When 0, only whitelisted keys may read.
 *
 * - signature: Cryptographic signature used to verify integrity and ownership
 *   of the space definition.
 * 
 * - nonce: unique identity randomly generated for each space (part of sharelink)
 * - secret: 64 character hex string to encrypt messages for limited space.
 */
export const spaces = sqliteTable("spaces", {
  id: integer("id").primaryKey(),

  spaceName: text("space_name").notNull(),
  publicKey: text("public_key").notNull(),

  timestamp: integer("timestamp").notNull(),

  permissionBroadcast: integer("permission_broadcast").notNull(), // 0/1
  permissionRead: integer("permission_read").notNull(), // 0/1

  signature: text("signature").notNull(),
  nonce: text("nonce").notNull(),
  secret: text("secret")
});

/**
 * Broadcast whitelist table definition.
 *
 * Stores the list of public keys that are explicitly allowed to broadcast
 * messages within a specific space. This table is only used when a space has
 * `permissionBroadcast` set to 0 (restricted mode).
 *
 * Columns:
 * - id: Primary key. Unique identifier for each whitelist entry.
 * - spaceId: Foreign key referencing `spaces.id`.
 * - allowedPublicKey: A public key that is permitted to broadcast messages.
 */
export const broadcastWhitelist = sqliteTable("broadcast_whitelist", {
  id: integer("id").primaryKey(),
  spaceId: integer("space_id")
    .notNull()
    .references(() => spaces.id),
  allowedPublicKey: text("allowed_public_key").notNull(),
});

/**
 * Read whitelist table definition.
 *
 * Contains the list of public keys that are explicitly allowed to read
 * message history from a given space (restricted mode).
 *
 * Columns:
 * - id: Primary key. Unique identifier for each whitelist entry.
 * - spaceId: Foreign key referencing `spaces.id`.
 * - allowedPublicKey: A public key allowed to read this space.
 */
export const readWhitelist = sqliteTable("read_whitelist", {
  id: integer("id").primaryKey(),
  spaceId: integer("space_id")
    .notNull()
    .references(() => spaces.id),
  allowedPublicKey: text("allowed_public_key").notNull(),
});

/**
 * Relations for the `spaces` table.
 *
 * Defines:
 * - broadcastWhitelist: One-to-many whitelist entries for broadcasting
 * - readWhitelist: One-to-many whitelist entries for reading
 * - members: One-to-many join table entries linking user profiles to spaces
 *
 * NOTE:
 * This merges *all* relations so that relations() is only ever called once
 * for this table (required by Drizzle).
 */
export const spacesRelations = relations(spaces, ({ many }) => ({
  broadcastWhitelist: many(broadcastWhitelist),
  readWhitelist: many(readWhitelist)
}));

/**
 * Relations for the broadcast whitelist entries.
 */
export const broadcastWhitelistRelations = relations(
  broadcastWhitelist,
  ({ one }) => ({
    space: one(spaces, {
      fields: [broadcastWhitelist.spaceId],
      references: [spaces.id],
    }),
  })
);

/**
 * Relations for the read whitelist entries.
 */
export const readWhitelistRelations = relations(
  readWhitelist,
  ({ one }) => ({
    space: one(spaces, {
      fields: [readWhitelist.spaceId],
      references: [spaces.id],
    }),
  })
);