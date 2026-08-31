import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * User Profiles Table
 * 
 * Represents user identities in the system, including their display
 * username, unique @tag, profile URL, and cryptographic identity.
 * 
 * Columns:
 * - id: Primary key. Unique integer ID for the user profile.
 * - username: Human-readable username. Must be unique.
 * - tag: A unique handle starting with '@'. Unique across all profiles.
 * - profileURL: Optional URL to avatar or external profile.
 * - publicKey: Cryptographic public key associated with this profile.
 * - signature: A signature verifying integrity and ownership.
 */
export const userProfiles = sqliteTable("user_profiles", {
  id: integer("id").primaryKey(),
  username: text("username").notNull().default(""),
  tag: text("tag").notNull().default(""),
  profileURL: text("profile_url").default(""),
  publicKey: text("public_key").notNull(),
  signature: text("signature").notNull(),
  timestamp: integer("timestamp").notNull(),
});