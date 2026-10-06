import { and, eq, gte, lte, like, asc, desc } from 'drizzle-orm';
import { messages } from "../database/schemas/message.schema.js";
import { now, validateTimestamp } from './general.utils.js';
import { canonicalStringify, concatBytes, hash, hex, u64, hexToUint8 } from './crypto.utils.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * Prepends 4-bytes of zeros to the begin of the array as header.
 * @param {Uint8Array} bytes 
 * @returns {Uint8Array}
 */
function frame(bytes) {
  const out = new Uint8Array(4 + bytes.length);
  new DataView(out.buffer).setUint32(0, bytes.length, false);
  out.set(bytes, 4);
  return out;
}

/**
 * Create messageId from protocol message object.
 * - Note: the payload should be canonicalized before computation.
 * @param {Object} params 
 * @returns 
 */
export function computeMessageId(params) {
  const {
    type,
    publicKey,
    timestamp,
    nonce,
    payload
  } = params;

  const buffer = concatBytes(
    frame(utf8ToBytes(type)),
    frame(hexToUint8(publicKey)),
    u64(timestamp),
    frame(hexToUint8(nonce)),
    frame(utf8ToBytes(payload))
  );

  return hex(hash(buffer));
}


/**
 * Create database filter conditions for message queries.
 * Handles all message field filters including timestamp ranges and payload search.
 *
 * @param {Object} filters - query filters (all optional)
 * @param {number} filters.id - exact ID match
 * @param {string} filters.type - exact type match
 * @param {Number} filters.spaceId - The related space's ID.
 * @param {string} filters.messageId - the message identity.
 * @param {string} filters.senderPublicKey - sender's public key (exact match)
 * @param {Object} filters.broadcastTimestamp - broadcast timestamp range
 * @param {number} filters.broadcastTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.broadcastTimestamp.end - end timestamp (inclusive)
 * @param {Object} filters.messageTimestamp - message timestamp range
 * @param {number} filters.messageTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.messageTimestamp.end - end timestamp (inclusive)
 * @param {string} filters.nonce - exact nonce match
 * @param {string} filters.ownerPublicKey - owner's public key (exact match)
 * @param {string} filters.signature - exact signature match
 * @param {string} filters.payloadContains - substring search in payload (case-insensitive)
 * @returns {Array} array of SQL conditions for use with drizzle-orm's and() function
 */
export function createMessageFilter(filters = {}) {
  const conditions = [];

  if (filters.id !== undefined) conditions.push(eq(messages.id, filters.id));
  if (filters.type) conditions.push(eq(messages.type, filters.type));
  if (filters.spaceId) conditions.push(eq(messages.spaceId, filters.spaceId));
  if (filters.messageId) conditions.push(eq(messages.messageId, filters.messageId));
  if (filters.senderPublicKey) conditions.push(eq(messages.senderPublicKey, filters.senderPublicKey));
  if (filters.nonce) conditions.push(eq(messages.nonce, filters.nonce));
  if (filters.ownerPublicKey) conditions.push(eq(messages.ownerPublicKey, filters.ownerPublicKey));
  if (filters.signature) conditions.push(eq(messages.signature, filters.signature));

  if (filters.broadcastTimestamp) {
    const { start, end } = filters.broadcastTimestamp;
    if (start !== undefined) conditions.push(gte(messages.broadcastTimestamp, start));
    if (end !== undefined) conditions.push(lte(messages.broadcastTimestamp, end));
  }

  if (filters.messageTimestamp) {
    const { start, end } = filters.messageTimestamp;
    if (start !== undefined) conditions.push(gte(messages.messageTimestamp, start));
    if (end !== undefined) conditions.push(lte(messages.messageTimestamp, end));
  }

  if (filters.payloadContains) {
    conditions.push(like(messages.payload, `%${filters.payloadContains}%`));
  }

  return conditions;
}

/**
 * Get order expression for message queries.
 *
 * @param {Object} filters - query filters
 * @param {string} filters.orderBy - field to order by: 'messageTimestamp', 'broadcastTimestamp', or 'id'
 * @param {string} filters.orderDirection - 'asc' for ascending, 'desc' for descending
 * @returns {Object} drizzle-orm order expression
 * @throws {Error} if orderBy value is invalid
 */
function getMessageOrderExpression(filters = {}) {
  const orderByMap = {
    broadcastTimestamp: messages.broadcastTimestamp,
    messageTimestamp: messages.messageTimestamp,
    id: messages.id,
  };

  const orderByKey = typeof filters.orderBy === 'string' ? filters.orderBy : 'messageTimestamp';
  const orderByField = orderByMap[orderByKey];

  if (!orderByField) {
    throw new Error(`Invalid orderBy value: ${String(filters.orderBy)}. Allowed: ${Object.keys(orderByMap).join(', ')}`);
  }

  const orderDir = (typeof filters.orderDirection === 'string' && filters.orderDirection.toLowerCase() === 'asc') ? 'asc' : 'desc';

  return orderDir === 'asc' ? asc(orderByField) : desc(orderByField);
}

/**
 * Get pagination limits for message queries.
 *
 * @param {Object} filters - query filters
 * @param {number} filters.limit - maximum records to return
 * @param {number} filters.offset - records to skip
 * @returns {Object} object with limit and offset properties
 */
function getPaginationLimits(filters = {}) {
  const limit = Math.min(typeof filters.limit === 'number' && filters.limit > 0 ? filters.limit : 100, 1000);
  const offset = typeof filters.offset === 'number' && filters.offset >= 0 ? filters.offset : 0;

  return { limit, offset };
}

/**
 * Build the canonical payload object that should be signed/verified for messages.
 *
 * @param {Object} params
 * @param {Object} params.message - The original signed message from the network
 * @param {string} params.message.type - Message type
 * @param {string} params.message.publicKey - Original creator's public key (lowercase hex)
 * @param {number} params.message.timestamp - When the message was originally created
 * @param {string} params.message.nonce - Message nonce (24 lowercase hex chars)
 * @param {string} params.message.signature - Owner's signature over the message
 * @param {Object|string|null} params.message.payload - Message payload (raw value, not pre-stringified)
 * @param {number} params.spaceId - Local primary key of the space (resolved from message.topic by the caller)
 * @param {string} params.senderPublicKey - Immediate sender's public key (differs from owner for relays)
 * @param {number} params.timestamp - When this node received the message
 * @returns {{
 *   messageId: string,
 *   spaceId: number,
 *   type: string,
 *   senderPublicKey: string,
 *   broadcastTimestamp: number,
 *   messageTimestamp: number,
 *   nonce: string,
 *   ownerPublicKey: string,
 *   signature: string,
 *   payload: string
 * }} Row ready to insert into the messages table
 */
export function buildMessageRecordPayload({
  message,
  spaceId,
  senderPublicKey,
  timestamp,
}) {

  if (!Number.isSafeInteger(spaceId)) {
    throw new Error("SpaceId must be an integer");
  }

  const canonicalPayload = canonicalStringify(message.payload);
  if (typeof canonicalPayload !== 'string') {
    throw new Error("message payload could not be canonicalized");
  }

  if (!validateTimestamp(message.timestamp) || !validateTimestamp(timestamp)) {
    throw new Error("timestamp must be non-nagative integer");
  }

  return {
    // network-wide identity, derived from the signed fields
    messageId: computeMessageId({
      ...message,
      payload: canonicalPayload
    }),
    // local foreign key to the space.
    spaceId: spaceId,
    // type of the message (from constants/events.constants.js)
    type: message.type,
    // immediate sender public key
    senderPublicKey: senderPublicKey,
    // time when this node received the message
    broadcastTimestamp: timestamp,
    // time when the message was originally created
    messageTimestamp: message.timestamp,
    // nonce from the signed message
    nonce: message.nonce,
    // original message owner's public key
    ownerPublicKey: message.publicKey,
    // original message signature
    signature: message.signature,
    // canonical payload string, byte-identical on every peer
    payload: canonicalPayload,
  };
}


/**
 * Create a new message record in the database.
 *
 * @param {Object} db - Drizzle DB instance
 * @param {Object} params - Parameters object
 * @param {Object} params.message - The original message object from the network
 * @param {string} params.message.type - Type of message (e.g., 'text', 'media')
 * @param {string} params.message.topic - Network topic
 * @param {string} params.message.publicKey - Original creator's public key
 * @param {number} params.message.timestamp - When message was originally created
 * @param {string} params.message.nonce - Unique message identifier
 * @param {string} params.message.payload - Stringified JSON content
 * @param {string} params.message.signature - Hex signature of the message payload
 * @param {string} params.senderPublicKey - Immediate sender's public key
 * @param {number} params.broadcastTimestamp - When message was received/broadcasted
 * @param {number} params.spaceId - The space ID.
 * @returns {Promise<Object>} created message row
 */
export async function createMessageRecord(db, {
  message,
  spaceId,
  senderPublicKey,
  broadcastTimestamp,
}) {
  const payload = buildMessageRecordPayload({
    message,
    spaceId,
    senderPublicKey,
    timestamp: broadcastTimestamp,
  });

  const result = await db
    .insert(messages)
    .values(payload)
    .returning()
    .get();

  return result;
}


/**
 * Query message records with filtering options.
 *
 * Supports filtering by all message fields, timestamp ranges, and payload content.
 * Results can be paginated and ordered by different timestamp fields.
 *
 * @param {Object} db - Drizzle DB instance
 * @param {Object} filters - query filters (all optional)
 * @param {number} filters.id - exact ID match
 * @param {string} filters.type - exact type match
 * @param {Number} filters.spaceId - The related space's ID.
 * @param {string} filters.messageId - the message identity.
 * @param {string} filters.senderPublicKey - sender's public key (exact match)
 * @param {Object} filters.broadcastTimestamp - broadcast timestamp range
 * @param {number} filters.broadcastTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.broadcastTimestamp.end - end timestamp (inclusive)
 * @param {Object} filters.messageTimestamp - message timestamp range
 * @param {number} filters.messageTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.messageTimestamp.end - end timestamp (inclusive)
 * @param {string} filters.nonce - exact nonce match
 * @param {string} filters.ownerPublicKey - owner's public key (exact match)
 * @param {string} filters.signature - exact signature match
 * @param {string} filters.payloadContains - substring search in payload (case-insensitive)
 * @param {number} filters.limit - maximum records to return (default: 100, max: 1000)
 * @param {number} filters.offset - records to skip (default: 0)
 * @param {string} filters.orderBy - field to order by: 'messageTimestamp', 'broadcastTimestamp', or 'id' (default: 'messageTimestamp')
 * @param {string} filters.orderDirection - 'asc' for ascending, 'desc' for descending (default: 'desc')
 * @returns {Promise<Array>} array of message records with isRelay as boolean
 */
export async function queryMessageRecord(db, filters = {}) {
  const conditions = createMessageFilter(filters);

  const orderExpr = getMessageOrderExpression(filters);
  const { limit, offset } = getPaginationLimits(filters);

  let query = db.select().from(messages);
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  const results = await query
    .orderBy(orderExpr)
    .limit(limit)
    .offset(offset)
    .all();

  return results;
}

/**
 * Inserts new message record into database only if it doesn't already exist.
 * @param {Object} db - Drizzle database instance.
 * @param {Object} params
 * @param {Number} params.spaceId - The space ID.
 * @param {Object} params.message - The original message object from the network.
 * @param {string} params.senderPublicKey - The publicKey of the node which sent the message. (broadcasted)
 * @returns {Promise<void>} Resolves when the message is either avoided or inserted into the database.
 */
export async function pushMessageToHistory(db, { spaceId, message, senderPublicKey }) {
  if (!message.nonce) return;

  const previousRecords = await queryMessageRecord(db, {
    spaceId: spaceId,
    nonce: message.nonce
  });
  
  if (previousRecords.length > 0) return;

  await createMessageRecord(db, {
    message: message,
    spaceId: spaceId,
    senderPublicKey: senderPublicKey,
    broadcastTimestamp: now()
  });
}

/**
 * Delete message records from the database based on filter criteria.
 *
 * @param {Object} db - Drizzle DB instance
 * @param {Object} filters - query filters (all optional)
 * @param {number} filters.id - exact ID match
 * @param {string} filters.type - exact type match
 * @param {Number} filters.spaceId - The related space's ID.
 * @param {string} filters.messageId - the message identity.
 * @param {string} filters.senderPublicKey - sender's public key (exact match)
 * @param {Object} filters.broadcastTimestamp - broadcast timestamp range
 * @param {number} filters.broadcastTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.broadcastTimestamp.end - end timestamp (inclusive)
 * @param {Object} filters.messageTimestamp - message timestamp range
 * @param {number} filters.messageTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.messageTimestamp.end - end timestamp (inclusive)
 * @param {string} filters.nonce - exact nonce match
 * @param {string} filters.ownerPublicKey - owner's public key (exact match)
 * @param {string} filters.signature - exact signature match
 * @param {string} filters.payloadContains - substring search in payload (case-insensitive)
 * @returns {Promise<{ deleteCount: number }>}
 */
export async function flushMessageRecords(db, filters = {}) {
  const conditions = createMessageFilter(filters);

  let query = db.delete(messages);
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  if (filters.limit) {
    query.limit(filters.limit);
  }

  const results = await query

  return {
    deleteCount: results.changes ?? 0
  };
}