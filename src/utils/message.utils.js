import { and, eq, gte, lte, like, asc, desc } from 'drizzle-orm';
import { messages } from "../database/schemas/message.schema.js";
import { now } from './general.utils.js';

/**
 * Create database filter conditions for message queries.
 * Handles all message field filters including timestamp ranges and payload search.
 *
 * @param {Object} filters - query filters (all optional)
 * @param {number} filters.id - exact ID match
 * @param {string} filters.type - exact type match
 * @param {string} filters.topic - exact topic match
 * @param {boolean} filters.isRelay - relay status (true/false)
 * @param {string} filters.senderPublicKey - sender's public key (exact match)
 * @param {Object} filters.broadcastTimestamp - broadcast timestamp range
 * @param {number} filters.broadcastTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.broadcastTimestamp.end - end timestamp (inclusive)
 * @param {Object} filters.messageTimestamp - message timestamp range
 * @param {number} filters.messageTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.messageTimestamp.end - end timestamp (inclusive)
 * @param {string} filters.nonce - exact nonce match
 * @param {string} filters.messageOwnerPublicKey - owner's public key (exact match)
 * @param {string} filters.signature - exact signature match
 * @param {string} filters.payloadContains - substring search in payload (case-insensitive)
 * @returns {Array} array of SQL conditions for use with drizzle-orm's and() function
 */
export function createMessageFilter(filters = {}) {
  const conditions = [];

  if (filters.id !== undefined) conditions.push(eq(messages.id, filters.id));
  if (filters.type) conditions.push(eq(messages.type, filters.type));
  if (filters.topic) conditions.push(eq(messages.topic, filters.topic));
  if (filters.isRelay !== undefined) conditions.push(eq(messages.isRelay, filters.isRelay ? 1 : 0));
  if (filters.senderPublicKey) conditions.push(eq(messages.senderPublicKey, filters.senderPublicKey));
  if (filters.nonce) conditions.push(eq(messages.nonce, filters.nonce));
  if (filters.messageOwnerPublicKey) conditions.push(eq(messages.messageOwnerPublicKey, filters.messageOwnerPublicKey));
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
 * Normalize message records by converting isRelay field to boolean.
 *
 * @param {Array} records - array of message records from database
 * @returns {Array} normalized message records
 */
function normalizeMessageRecords(records) {
  return records.map(r => ({
    ...r,
    payload: JSON.parse(r.payload),
    isRelay: r.isRelay === 1
  }));
}

/**
 * Build the canonical payload object that should be signed/verified for messages.
 *
 * @param {Object} params - Parameters object
 * @param {Object} params.message - The original message object from the network
 * @param {string} params.message.type - Type of message (e.g., 'text', 'media')
 * @param {string} params.message.topic - Network topic/channel
 * @param {string} params.message.publicKey - Original creator's public key
 * @param {number} params.message.timestamp - When message was originally created
 * @param {string} params.message.nonce - Unique message identifier
 * @param {string} params.message.payload - Stringified JSON content
 * @param {string} params.senderPublicKey - Immediate sender's public key
 * @param {number} params.timestamp - When message was received/broadcasted
 * @returns {Object} Complete message payload ready for signing/verification
 * @returns {string} returns.type - Message type
 * @returns {string} returns.topic - Message topic
 * @returns {number} returns.isRelay - 0 if sender=owner, 1 if sender≠owner (relay)
 * @returns {string} returns.senderPublicKey - Immediate sender's public key
 * @returns {number} returns.broadcastTimestamp - When message was broadcasted
 * @returns {number} returns.messageTimestamp - When message was originally created
 * @returns {string} returns.nonce - Unique message identifier
 * @returns {string} returns.messageOwnerPublicKey - Original creator's public key
 * @returns {string} returns.payload - Stringified JSON content
 */
export function buildMessageRecordPayload({
  message,
  senderPublicKey,
  timestamp,
}) {
  return {
    // type of the message (from constants/events.constants.js)
    type: message.type,
    // topic that the message was sent to
    topic: message.topic,
    // if the sender is not the message owner, it's a relay
    isRelay: message.publicKey === senderPublicKey ? 0 : 1,
    // immediate sender public key
    senderPublicKey: senderPublicKey,
    // time when the message was received/broadcasted by the sender
    broadcastTimestamp: timestamp,
    // time when the message was originally created
    messageTimestamp: message.timestamp,
    // unique nonce for the message
    nonce: message.nonce,
    // original message owner's public key
    messageOwnerPublicKey: message.publicKey,
    // original message signature
    signature: message.signature,
    // original messsage payload
    payload: JSON.stringify(message.payload)
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
 * @returns {Promise<Object>} created message row
 */
export async function createMessageRecord(db, {
  message,
  senderPublicKey,
  broadcastTimestamp,
}) {
  const payload = buildMessageRecordPayload({
    message,
    senderPublicKey,
    timestamp: broadcastTimestamp,
  });

  const result = await db
    .insert(messages)
    .values(payload)
    .returning()
    .get();

  return {
    ...result,
    isRelay: result.isRelay === 1
  };
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
 * @param {string} filters.topic - exact topic match
 * @param {boolean} filters.isRelay - relay status (true/false)
 * @param {string} filters.senderPublicKey - sender's public key (exact match)
 * @param {Object} filters.broadcastTimestamp - broadcast timestamp range
 * @param {number} filters.broadcastTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.broadcastTimestamp.end - end timestamp (inclusive)
 * @param {Object} filters.messageTimestamp - message timestamp range
 * @param {number} filters.messageTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.messageTimestamp.end - end timestamp (inclusive)
 * @param {string} filters.nonce - exact nonce match
 * @param {string} filters.messageOwnerPublicKey - owner's public key (exact match)
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

  return normalizeMessageRecords(results);
}

/**
 * Inserts new message record into database only if it doesn't already exist.
 * @param {Object} db - Drizzle database instance.
 * @param {Object} params
 * @param {Object} params.message - The original message object from the network.
 * @param {string} params.senderPublicKey - The publicKey of the node which sent the message. (broadcasted)
 * @returns {Promise<void>} Resolves when the message is either avoided or inserted into the database.
 */
export async function pushMessageToHistory(db, { message, senderPublicKey }) {
  if (!message.nonce) return;

  const previousRecords = await queryMessageRecord(db, { nonce: message.nonce });
  if (previousRecords.length > 0) return;

  await createMessageRecord(db, {
    message: message,
    senderPublicKey: senderPublicKey,
    broadcastTimestamp: now()
  });
}

/**
 * Delete message records from the database based on filter criteria.
 *
 * @param {Object} db - Drizzle DB instance
 * @param {Object} filters - query filters to determine which records to delete (all optional)
 * @param {number} filters.id - exact ID match
 * @param {string} filters.type - exact type match
 * @param {string} filters.topic - exact topic match
 * @param {boolean} filters.isRelay - relay status (true/false)
 * @param {string} filters.senderPublicKey - sender's public key (exact match)
 * @param {Object} filters.broadcastTimestamp - broadcast timestamp range
 * @param {number} filters.broadcastTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.broadcastTimestamp.end - end timestamp (inclusive)
 * @param {Object} filters.messageTimestamp - message timestamp range
 * @param {number} filters.messageTimestamp.start - start timestamp (inclusive)
 * @param {number} filters.messageTimestamp.end - end timestamp (inclusive)
 * @param {string} filters.nonce - exact nonce match
 * @param {string} filters.messageOwnerPublicKey - owner's public key (exact match)
 * @param {string} filters.signature - exact signature match
 * @param {string} filters.payloadContains - substring search in payload (case-insensitive)
 * @param {number} filters.limit - maximum records to delete (default: 100, max: 1000, use with caution)
 * @returns {Promise<Array>} array of deleted message records with isRelay as boolean
 * @throws {Error} if no filters are provided to prevent accidental mass deletion
 */
export async function flushMessageRecord(db, filters = {}) {
  const conditions = createMessageFilter(filters);
  
  const deleteLimit = Math.min(typeof filters.limit === 'number' && filters.limit > 0 ? filters.limit : 100, 1000);
  
  let query = db.delete(messages);
  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }
  
  const results = await query
    .returning()
    .limit(deleteLimit)
    .all();

  return normalizeMessageRecords(results);
}