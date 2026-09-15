import bs58 from 'bs58';
import { eq } from 'drizzle-orm'
import { brotliCompressSync, brotliDecompressSync } from 'zlib';
import { sharelinks } from '../database/schemas/sharelink.schema.js';
import { now } from './general.utils.js';
import { getSpaceTopicHash } from './space.utils.js';

/**
 * Create a share link for a space.
 * Compresses and encodes the space object (excluding spaceId) using short keys + Brotli + Base58
 * @param {Object} space - Space object
 * @returns {string} - Share link like pearcore://...
 */
export function encodeShareLink(space, prefix = 'pearcore') {
  const shortPayload = {
    name: space.spaceName,
    pk: space.publicKey,
    nonce: space.nonce
  };

  const jsonStr = JSON.stringify(shortPayload);
  const compressed = brotliCompressSync(Buffer.from(jsonStr));
  const encoded = bs58.encode(compressed);

  return `${prefix}://${encoded}`;
}

/**
 * Decode a share link back into a space object
 * @param {string} shareLink - ShareLink, like: prefix://abc..
 * @returns {Object} Original space Object
 */
export function decodeShareLink(shareLink) {
  try {
    if (!shareLink.includes('://')) return null;
    
    const parts = shareLink.split('://');
    if (parts.length < 2) return null;

    const encodedTopic = parts.slice(1).join('://');
    if (!encodedTopic) return null;

    const compressed = bs58.decode(encodedTopic);
    const jsonStr = brotliDecompressSync(compressed).toString();
    const shortPayload = JSON.parse(jsonStr);

    const decodedPayload = {
      spaceName: shortPayload.name,
      publicKey: shortPayload.pk,
      nonce: shortPayload.nonce
    };

    if (
      !decodedPayload.spaceName || 
      !decodedPayload.publicKey || 
      !decodedPayload.nonce
    ) return null;

    return decodedPayload;
  } catch (error) {
    return null;
  }
}

/**
 * Saves a new sharelink to the database
 * @param db - Database connection object
 * @param {Object} sharelinkData - The sharelink data to save
 * @param {string} sharelinkData.spaceName - Human-readable name of the space
 * @param {string} sharelinkData.publicKey - Public key of the creator or owner of the space
 * @param {string} sharelinkData.nonce - Unique identity randomly generated for each space
 * @returns {Promise<Object>} The created sharelink record
 * @throws {Error} If required parameters are missing
 */
export async function saveShareLink(db, { spaceName, publicKey, nonce }) {
  if (!spaceName && !publicKey && !nonce) {
    throw new Error("Sharelink missing parameters.");
  }

  const result = await db.insert(sharelinks).values({
    spaceName: spaceName,
    publicKey: publicKey,
    nonce: nonce,
    timestamp: now()
  }).returning();

  return result[0];
}

/**
 * Queries sharelinks from the database based on provided criteria
 * @param db - Database connection object
 * @param {Object} filters - Optional filter criteria to match against
 * @param {string} [filters.spaceName] - Filter by space name
 * @param {string} [filters.publicKey] - Filter by public key
 * @param {string} [filters.nonce] - Filter by nonce
 * @returns {Promise<Array<Object>>} Array of matching sharelink records
 */
export async function queryShareLink(db, {spaceName, publicKey, nonce}) {
  let query = db.select().from(sharelinks);

  // apply conditions to the query
  if (spaceName !== undefined) {
    query = query.where(eq(sharelinks.spaceName, spaceName));
  }

  if (publicKey !== undefined) {
    query = query.where(eq(sharelinks.publicKey, publicKey));
  }

  if (nonce !== undefined) {
    query = query.where(eq(sharelinks.nonce, nonce))
  }

  return await query;
}

/**
 * Returns all sharelink topic hashes as an array.
 * @param {Object} db - Drizzle database instace.
 * @returns {Promise<Strin[]>}
 */
export async function getShareLinkTopics(db) {
  const sharelinks = await queryShareLink(db, {});
  const topics = [];

  for (const sharelink of sharelinks) {
    topics.push(getSpaceTopicHash(sharelink));
  }

  return topics;
}

/**
 * Deletes a sharelink from the database by ID
 * @param db - Database connection object
 * @param {number} sharelinkId - The unique identifier of the sharelink to delete
 * @returns {Promise<Object>} The deleted sharelink record
 * @throws {Error} If no sharelink is found with the specified ID
 */
export async function deleteShareLink(db, sharelinkId) {
  // check for the record existence
  const existing = await db.select()
    .from(sharelinks)
    .where(eq(sharelinks.id, sharelinkId))

  if (existing.length === 0) {
    throw new Error(`Sharelink with id ${sharelinkId} not found`);
  }

  const result = await db.delete(sharelinks)
    .where(eq(sharelinks.id, sharelinkId))
    .returning()

  return result[0];
}