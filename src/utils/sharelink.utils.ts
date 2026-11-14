import bs58 from 'bs58';
import { and, eq } from 'drizzle-orm';
import { brotliCompressSync, brotliDecompressSync } from 'zlib';
import type { Database } from '../types/database.js';
import { sharelinks } from '../database/schemas/sharelink.schema.js';
import { now } from './general.utils.js';
import { getSpaceTopicHash } from './space.utils.js';

/** Share link identity fields stored in the database and encoded into a link. */
export interface ShareLinkData {
  spaceName: string;
  publicKey: string;
  nonce: string;
}

/** Optional fields used to filter stored share links. */
export type ShareLinkFilters = Partial<ShareLinkData>;

/** A row from the sharelinks table. */
export type ShareLinkRecord = typeof sharelinks.$inferSelect;

/**
 * Create a share link for a space.
 * Compresses and encodes the space object (excluding spaceId) using short keys + Brotli + Base58
 * @param space - Space identity fields.
 * @param prefix - Protocol prefix used in the generated link.
 * @returns Share link like pearcore://...
 */
export function encodeShareLink(
  space: ShareLinkData,
  prefix: string = 'pearcore',
): string {
  const shortPayload = {
    name: space.spaceName,
    pk: space.publicKey,
    nonce: space.nonce,
  };

  const jsonStr = JSON.stringify(shortPayload);
  const compressed = brotliCompressSync(Buffer.from(jsonStr));
  const encoded = bs58.encode(compressed);

  return `${prefix}://${encoded}`;
}

/**
 * Decode a share link back into a space object
 * @param shareLink - Share link, like prefix://abc..
 * @returns The decoded space identity, or null when the link is invalid.
 */
export function decodeShareLink(shareLink: string): ShareLinkData | null {
  try {
    if (!shareLink.includes('://')) return null;

    const parts = shareLink.split('://');
    if (parts.length < 2) return null;

    const encodedTopic = parts.slice(1).join('://');
    if (!encodedTopic) return null;

    const compressed = bs58.decode(encodedTopic);
    const jsonStr = brotliDecompressSync(compressed).toString();
    const shortPayload: unknown = JSON.parse(jsonStr);

    if (typeof shortPayload !== 'object' || shortPayload === null) {
      return null;
    }

    const payload = shortPayload as Record<string, unknown>;

    const spaceName = payload.name;
    const publicKey = payload.pk;
    const nonce = payload.nonce;

    if (
      typeof spaceName !== 'string' ||
      !spaceName ||
      typeof publicKey !== 'string' ||
      !publicKey ||
      typeof nonce !== 'string' ||
      !nonce
    )
      return null;

    return { spaceName, publicKey, nonce };
  } catch {
    return null;
  }
}

/**
 * Saves a new sharelink to the database
 * @param db - Database connection object
 * @param sharelinkData - The sharelink data to save.
 * @returns The created sharelink record.
 * @throws If required parameters are missing.
 */
export async function saveShareLink(
  db: Database,
  { spaceName, publicKey, nonce }: ShareLinkData,
): Promise<ShareLinkRecord> {
  if (!spaceName || !publicKey || !nonce) {
    throw new Error('Sharelink missing parameters.');
  }

  const result = await db
    .insert(sharelinks)
    .values({
      spaceName: spaceName,
      publicKey: publicKey,
      nonce: nonce,
      timestamp: now(),
    })
    .returning();

  return result[0]!;
}

/**
 * Queries sharelinks from the database based on provided criteria
 * @param db - Database connection object
 * @param filters - Optional filter criteria to match against.
 * @returns Matching sharelink records.
 */
export async function queryShareLink(
  db: Database,
  { spaceName, publicKey, nonce }: ShareLinkFilters = {},
): Promise<ShareLinkRecord[]> {
  let query = db.select().from(sharelinks);
  const conditions = [];

  if (spaceName !== undefined) {
    conditions.push(eq(sharelinks.spaceName, spaceName));
  }

  if (publicKey !== undefined) {
    conditions.push(eq(sharelinks.publicKey, publicKey));
  }

  if (nonce !== undefined) {
    conditions.push(eq(sharelinks.nonce, nonce));
  }

  return conditions.length > 0 ? query.where(and(...conditions)) : query;
}

/**
 * Returns all sharelink topic hashes as an array.
 * @param db - Drizzle database instance.
 * @returns Share link topic hashes.
 */
export async function getShareLinkTopics(db: Database): Promise<string[]> {
  const records = await queryShareLink(db, {});
  const topics: string[] = [];

  for (const sharelink of records) {
    topics.push(getSpaceTopicHash(sharelink));
  }

  return topics;
}

/**
 * Deletes a sharelink from the database by ID
 * @param db - Database connection object
 * @param sharelinkId - The unique identifier of the sharelink to delete.
 * @returns The deleted sharelink record.
 * @throws If no sharelink is found with the specified ID.
 */
export async function deleteShareLink(
  db: Database,
  sharelinkId: number,
): Promise<ShareLinkRecord> {
  // check for the record existence
  const existing = await db
    .select()
    .from(sharelinks)
    .where(eq(sharelinks.id, sharelinkId));

  if (existing.length === 0) {
    throw new Error(`Sharelink with id ${sharelinkId} not found`);
  }

  const result = await db
    .delete(sharelinks)
    .where(eq(sharelinks.id, sharelinkId))
    .returning();

  return result[0]!;
}
