import { DEFAULT_READ_BATCH_SIZE } from '../constants/global.constants.js';
import { and, eq, gte, gt, lte, lt, or, like, asc, desc, count, max, inArray, SQL } from 'drizzle-orm';
import { messages } from "../database/schemas/message.schema.js";
import { isNumber, now, validateTimestamp } from './general.utils.js';
import { canonicalStringify, concatBytes, hash, hex, u64, hexToUint8 } from './crypto.utils.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';

const MESSAGE_ID_BYTES = 32;
const RANGE_FINGERPRINT_BYTES = 16;


function encodeVarint(value) {
  let remaining = BigInt(value);

  if (remaining < 0n) {
    throw new RangeError('Varint value must be non-negative');
  }

  const bytes = [];
  do {
    bytes.unshift(Number(remaining & 0x7fn));
    remaining >>= 7n;
  } while (remaining > 0n);

  for (let i = 0; i < bytes.length - 1; i++) {
    bytes[i] |= 0x80;
  }

  return Uint8Array.from(bytes);
}

function addMessageIdToSum(sum, messageId) {
  const bytes = hexToUint8(messageId);

  if (bytes.length !== MESSAGE_ID_BYTES) {
    throw new TypeError('messageId must be exactly 32 bytes');
  }
  
  let carry = 0;
  for (let i = 0; i < MESSAGE_ID_BYTES; i++) {
    const value = sum[i] + bytes[i] + carry;
    sum[i] = value & 0xff; // value % 256
    carry = value >>> 8; // Math.floor(x / 256)
  }
}

/**
 * Creates an empty fingerprint accumulator.
 * @returns {{ sum: Uint8Array, count: bigint }}
 */
export function createFingerprintAccumulator() {
  return { sum: new Uint8Array(MESSAGE_ID_BYTES), count: 0n };
}

/**
 * Adds a messageId into the accumulator (modular 256-bit addition).
 * @param {{ sum: Uint8Array, count: bigint }} accumulator
 * @param {string} messageId - 64 character lowercase hex message ID.
 */
export function accumulateFingerprint(accumulator, messageId) {
  addMessageIdToSum(accumulator.sum, messageId);
  accumulator.count++;
}

/**
 * Finalizes the accumulator into a Negentropy-compatible fingerprint.
 * @param {{ sum: Uint8Array, count: bigint }} accumulator
 * @returns {string} First 16 bytes of SHA-256(sum || varint(count)), as lowercase hex
 */
export function finalizeFingerprint(accumulator) {
  const digest = hash(concatBytes(accumulator.sum, encodeVarint(accumulator.count)));
  return hex(digest.subarray(0, RANGE_FINGERPRINT_BYTES));
}

/**
 * Returns a SQL condition to limit the query by lower bound.
 * 
 * @param {{ timestamp: number, messageId: string }} bound - The lower bound
 * @param {Object} options
 * @param {Boolean} [options.inclusive=false] - Set true to include the extact bound row if the timestamps match
 * @returns {SQL} - Drizzle query condition
 */
function filterByLowerBound(bound, options) {
  const { inclusive = false } = options;

  const messageIdCondition = inclusive
    ? gte(messages.messageId, bound.messageId)
    : gt(messages.messageId, bound.messageId);

  return or(
    gt(messages.messageTimestamp, bound.timestamp),
    and(eq(messages.messageTimestamp, bound.timestamp), messageIdCondition),
  );
}

/**
 * Returns a SQL condition to limit the query by upper bound.
 * 
 * @param {{ timestamp: number, messageId: string }} bound - The upper bound
 * @returns {SQL} - Drizzle query condition
 */
function filterByUpperBound(bound) {
  return or(
    lt(messages.messageTimestamp, bound.timestamp),
    and(eq(messages.messageTimestamp, bound.timestamp), lt(messages.messageId, bound.messageId)),
  );
}

/**
 * Check upper bound to be higher than the lower bound.
 * this methods conditions the bounds following the [Negentropy protocol](https://github.com/hoytech/negentropy/blob/master/docs/negentropy-protocol-v1.md)
 * 
 * A. The timestamp of upper bound should be higher or equal to lower bound.
 * B. If timestamps are equal, the messageId of upper bound should be higher.
 * 
 * @param {{ timestamp: number, messageId: string }} lower - The lower bound
 * @param {{ timestamp: number, messageId: string }} upper - the higher bound
 * @returns {Boolean} Returns true if the higher bound meets the conditions.
 */
export function compareMessageBounds(lower, upper) {
  if (lower.timestamp !== upper.timestamp) {
    return lower.timestamp < upper.timestamp;
  }

  return lower.messageId < upper.messageId;
}

/**
 * Validates the common parameters of range queries.
 * @param {Object} params
 */
function validateRangeParams(params) {
  const { spaceId, lowerBound, upperBound, maxRowId } = params;

  if (!isNumber(spaceId) || spaceId <= 0) {
    throw new Error("sapceId should be valid positive number");
  }

  if (lowerBound && upperBound && !compareMessageBounds(lowerBound, upperBound)) {
    throw new RangeError('lowerBound must not be greater than upperBound');
  }

  if (maxRowId !== undefined && maxRowId !== null) {
    if (!isNumber(maxRowId) || maxRowId < 0) {
      throw new RangeError('maxRowId must be a non-negative integer');
    }
  }
}

/**
 * Builds the SQL WHERE conditions to query using boundries.
 *
 * @param {Object} params
 * @param {Object} [params.lowerBound] - The boundry for lower end of the query.
 * @param {Object} [params.upperBound] - The boundry for the highest end of the query
 * @param {Object} [params.maxRowId] - Freezes the set to a snapshot: only rows whose local
 *   primary key is lower or equal to it are visible. Rows inserted after the snapshot
 *   (live messages, or messages imported by another sync session) always get a higher
 *   row ID, so the visible set never changes while a reconciliation is running.
 * @param {Object} [params.cursorBound] - alternative to lowerBound without inclusivity of including exact row of the boundry itself.
 *   pagination.
 * @returns {SQL}
 */
function buildRangeCondition({ spaceId, lowerBound, upperBound, maxRowId, cursorBound }) {
  const conditions = [eq(messages.spaceId, spaceId)];

  if (cursorBound) {
    conditions.push(filterByLowerBound(cursorBound, { inclusive: false }));
  }
  else if (lowerBound) {
    conditions.push(filterByLowerBound(lowerBound, { inclusive: true }));
  }

  if (upperBound) {
    conditions.push(filterByUpperBound(upperBound));
  }

  if (maxRowId !== undefined && maxRowId !== null) {
    conditions.push(lte(messages.id, maxRowId));
  }

  return and(...conditions);
}

/**
 * Iterates the `(timestamp, messageId)` keys of one space's range in ascending order.
 *
 * @param {Object} db - Drizzle database instance
 * @param {Object} params
 * @param {number} params.spaceId  - The space ID
 * @param {{timestamp:number,messageId:string}|null} [params.lowerBound] - The lower boundry for the query
 * @param {{timestamp:number,messageId:string}|null} [params.upperBound] - the upper boundry for the query
 * @param {number|null} [params.maxRowId] - Maximum allowed message-record ID for the query
 * @param {number} [params.batchSize=DEFAULT_READ_BATCH_SIZE]
 * @returns {AsyncGenerator<Array<{timestamp:number,messageId:string}>>} Batches of keys
 */
export async function* iterateRangeKeys(db, params) {
  validateRangeParams(params);

  const { batchSize = DEFAULT_READ_BATCH_SIZE } = params;
  let cursorBound = null;

  while (true) {
    const rows = await db.select({
      timestamp: messages.messageTimestamp,
      messageId: messages.messageId,
    })
      .from(messages)
      .where(buildRangeCondition({ ...params, cursorBound }))
      .orderBy(asc(messages.messageTimestamp), asc(messages.messageId))
      .limit(batchSize)
      .all();

    // end the batched query if the query result is empty
    if (rows.length === 0) return;

    yield rows;

    if (rows.length < batchSize) return;

    // update cursor for the next iteration with the last boundary
    const last = rows[rows.length - 1];
    cursorBound = { timestamp: last.timestamp, messageId: last.messageId };
  }
}

/**
 * Compute a Negentropy-compatible fingerprint for one space's timestamp/ID range.
 * Bounds are pair objects `{ timestamp, messageId }`; lower is inclusive and
 * upper is exclusive. Omit either bound to leave that side open. Omit both
 * bounds to fingerprint the entire space for an initial reconciliation handshake.
 * Rows are read in bounded keyset-paginated batches, so memory use is O(batchSize).
 *
 * @param {Object} db Drizzle database instance
 * @param {Object} params
 * @param {number} params.spaceId Local space primary key
 * @param {{timestamp:number,messageId:string}|null} [params.lowerBound]
 * @param {{timestamp:number,messageId:string}|null} [params.upperBound]
 * @param {number|null} [params.maxRowId] Only include rows with `id <= maxRowId` (snapshot)
 * @param {number} [params.batchSize=DEFAULT_READ_BATCH_SIZE]
 * @returns {Promise<string>} First 16 bytes of SHA-256, as lowercase hex
 */
export async function computeRangeFingerprint(db, params) {
  const accumulator = createFingerprintAccumulator();

  for await (const rows of iterateRangeKeys(db, params)) {
    for (const row of rows) {
      accumulateFingerprint(accumulator, row.messageId);
    }
  }

  return finalizeFingerprint(accumulator);
}

/**
 * Counts the messages of one space's range.
 *
 * @param {Object} db Drizzle database instance
 * @param {Object} params - Same range parameters as `computeRangeFingerprint()`.
 * @returns {Promise<number>}
 */
export async function countMessagesInRange(db, params) {
  validateRangeParams(params);

  const result = await db.select({ total: count() })
    .from(messages)
    .where(buildRangeCondition(params))
    .get();

  return result?.total ?? 0;
}

/**
 * Lists the message IDs of one space's range in ascending `(timestamp, messageId)` order.
 *
 * @param {Object} db Drizzle database instance
 * @param {Object} params - Same range parameters as `computeRangeFingerprint()`.
 * @returns {Promise<string[]>}
 */
export async function listMessageIdsInRange(db, params) {
  const ids = [];

  for await (const rows of iterateRangeKeys(db, params)) {
    for (const row of rows) ids.push(row.messageId);
  }

  return ids;
}

/**
 * Splits one space's range into (up to) `bucketCount` contiguous sub-ranges holding a
 * near-equal number of messages, and fingerprints each of them in a single scan.
 *
 * @param {Object} db - Drizzle database instance
 * @param {Object} params - Same range parameters as `computeRangeFingerprint()`, plus additional parameters mentioned below.
 * @param {number} params.bucketCount - Maximum number of buckets (>= 1).
 * @param {number} [params.total] - Number of messages in the range, if already known.
 * @returns {Promise<Array<{ upperBound: {timestamp:number,messageId:string}|null, fingerprint: string, count: number }>>}
 */
export async function computeRangeBuckets(db, params) {
  const { bucketCount } = params;

  if (!isNumber(bucketCount) || bucketCount < 1) {
    throw new RangeError('bucketCount must be a positive integer');
  }

  const total = params.total ?? await countMessagesInRange(db, params);
  const numBuckets = Math.max(1, Math.min(bucketCount, total));
  const itemsPerBucket = Math.floor(total / numBuckets);
  const extraItems = total % numBuckets; // calculate the leftovers

  const buckets = [];

  let accumulator = createFingerprintAccumulator();
  let inBucket = 0;
  let target = itemsPerBucket + (extraItems > 0 ? 1 : 0);

  for await (const rows of iterateRangeKeys(db, params)) {
    for (const row of rows) {
      if (inBucket === target && buckets.length < numBuckets - 1) {
        buckets.push({
          upperBound: { timestamp: row.timestamp, messageId: row.messageId },
          fingerprint: finalizeFingerprint(accumulator),
          count: inBucket,
        });

        // update the next bucket's size to include leftovers of split
        target = itemsPerBucket + (buckets.length < extraItems ? 1 : 0);

        // reset for next bucket
        accumulator = createFingerprintAccumulator(); 
        inBucket = 0;
      }

      accumulateFingerprint(accumulator, row.messageId);
      inBucket++;
    }
  }

  buckets.push({
    upperBound: params.upperBound ?? null,
    fingerprint: finalizeFingerprint(accumulator),
    count: inBucket,
  });

  return buckets;
}

/**
 * Returns the highest local row ID of a space's messages. Pass it as `maxRowId`
 * to range queries to freeze the message set at this point in time.
 *
 * @param {Object} db Drizzle database instance
 * @param {number} spaceId Local space primary key
 * @returns {Promise<number>} The highest row ID, or 0 if the space has no messages.
 */
export async function getMessageSnapshotRowId(db, spaceId) {
  if (!isNumber(spaceId) || spaceId <= 0) {
    throw new Error("sapceId should be valid positive number");
  }

  const result = await db.select({ maxId: max(messages.id) })
    .from(messages)
    .where(eq(messages.spaceId, spaceId))
    .get();

  return result?.maxId ?? 0;
}

/**
 * Loads the full message records of a space by their message IDs.
 * IDs are queried in chunks to stay below SQLite's variable limit.
 *
 * @param {Object} db Drizzle database instance
 * @param {Object} params
 * @param {number} params.spaceId Local space primary key
 * @param {Iterable<string>} params.messageIds Message IDs to load
 * @param {number} [params.batchSize=DEFAULT_READ_BATCH_SIZE]
 * @returns {Promise<Array<Object>>} Message rows ordered by `(timestamp, messageId)`
 */
export async function getMessagesByIds(db, { spaceId, messageIds, batchSize = DEFAULT_READ_BATCH_SIZE }) {
  const ids = [...new Set(messageIds)];
  const records = [];

  for (let index = 0; index < ids.length; index += batchSize) {
    const chunk = ids.slice(index, index + batchSize);
    const rows = await db.select()
      .from(messages)
      .where(and(eq(messages.spaceId, spaceId), inArray(messages.messageId, chunk)))
      .all();

    records.push(...rows);
  }

  return records.sort((a, b) => {
    if (a.messageTimestamp !== b.messageTimestamp) return a.messageTimestamp - b.messageTimestamp;
    return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
  });
}

/**
 * Prepends 4-bytes of zeros to the begin of the array as header.
 * @param {Uint8Array} bytes 
 * @returns {Uint8Array}
 */
function frame(bytes) {
  const out = new Uint8Array(4 + bytes.length);
  const view = new DataView(out.buffer);

  // write bytes in big-endian
  view.setUint32(0, bytes.length, false);
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

  if (!isNumber(spaceId)) {
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
    .returning({
      id: messages.id,
      messageId: messages.messageId
    })
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
