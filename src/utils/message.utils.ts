import { DEFAULT_READ_BATCH_SIZE } from '../constants/global.constants.js';
import {
  and,
  eq,
  gte,
  gt,
  lte,
  lt,
  or,
  like,
  asc,
  desc,
  count,
  max,
  inArray,
  SQL,
} from 'drizzle-orm';
import { messages } from '../database/schemas/message.schema.js';
import { isNumber, now, validateTimestamp } from './general.utils.js';
import {
  canonicalStringify,
  concatBytes,
  hash,
  hex,
  u64,
  hexToUint8,
} from './crypto.utils.js';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { Database } from '../types/database.js';

const MESSAGE_ID_BYTES = 32;
const RANGE_FINGERPRINT_BYTES = 16;

/** A messages row. */
export type MessageRecord = typeof messages.$inferSelect;

/** A row ready to insert into the messages table (see buildMessageRecordPayload). */
export type NewMessageRecord = typeof messages.$inferInsert;

/** A signed protocol message as it travels over the network. */
export interface SignedMessage {
  type: string;
  topic?: string;
  publicKey: string;
  timestamp: number;
  nonce: string;
  signature: string;
  payload: unknown;
}

/** A position in a space's ordered message set: (timestamp, messageId). */
export interface MessageBound {
  timestamp: number;
  messageId: string;
}

/** Parameters shared by the RBSR range queries. Lower bound is inclusive, upper exclusive. */
export interface RangeParams {
  spaceId: number;
  lowerBound?: MessageBound | null;
  upperBound?: MessageBound | null;
  /** Snapshot: only rows with `id <= maxRowId` are visible. */
  maxRowId?: number | null;
  batchSize?: number;
}

export interface FingerprintAccumulator {
  sum: Uint8Array;
  count: bigint;
}

export interface RangeBucket {
  upperBound: MessageBound | null;
  fingerprint: string;
  count: number;
}

export interface MessageFilters {
  id?: number;
  type?: string;
  spaceId?: number;
  messageId?: string;
  senderPublicKey?: string;
  broadcastTimestamp?: { start?: number; end?: number };
  messageTimestamp?: { start?: number; end?: number };
  nonce?: string;
  ownerPublicKey?: string;
  signature?: string;
  payloadContains?: string;
}

export interface MessageQueryOptions extends MessageFilters {
  limit?: number;
  offset?: number;
  orderBy?: 'messageTimestamp' | 'broadcastTimestamp' | 'id' | (string & {});
  orderDirection?: 'asc' | 'desc' | (string & {});
}

function encodeVarint(value: number | bigint): Uint8Array {
  let remaining = BigInt(value);

  if (remaining < 0n) {
    throw new RangeError('Varint value must be non-negative');
  }

  const bytes: number[] = [];
  do {
    bytes.unshift(Number(remaining & 0x7fn));
    remaining >>= 7n;
  } while (remaining > 0n);

  for (let i = 0; i < bytes.length - 1; i++) {
    bytes[i] |= 0x80;
  }

  return Uint8Array.from(bytes);
}

function addMessageIdToSum(sum: Uint8Array, messageId: string): void {
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
 */
export function createFingerprintAccumulator(): FingerprintAccumulator {
  return { sum: new Uint8Array(MESSAGE_ID_BYTES), count: 0n };
}

/**
 * Adds a messageId into the accumulator (modular 256-bit addition).
 * @param messageId - 64 character lowercase hex message ID.
 */
export function accumulateFingerprint(
  accumulator: FingerprintAccumulator,
  messageId: string,
): void {
  addMessageIdToSum(accumulator.sum, messageId);
  accumulator.count++;
}

/**
 * Finalizes the accumulator into a Negentropy-style fingerprint.
 * Note: the Negentropy spec uses SHA-256 here; PearCore uses BLAKE3 (crypto.utils `hash`),
 * so fingerprints only match between PearCore peers, not reference Negentropy implementations.
 * @returns First 16 bytes of BLAKE3(sum || varint(count)), as lowercase hex
 */
export function finalizeFingerprint(
  accumulator: FingerprintAccumulator,
): string {
  const digest = hash(
    concatBytes(accumulator.sum, encodeVarint(accumulator.count)),
  );
  return hex(digest.subarray(0, RANGE_FINGERPRINT_BYTES));
}

/**
 * Returns a SQL condition to limit the query by lower bound.
 *
 * @param bound - The lower bound
 * @param [options.inclusive=false] - Set true to include the extact bound row if the timestamps match
 * @returns - Drizzle query condition
 */
function filterByLowerBound(
  bound: MessageBound,
  options: { inclusive?: boolean },
): SQL {
  const { inclusive = false } = options;

  const messageIdCondition = inclusive
    ? gte(messages.messageId, bound.messageId)
    : gt(messages.messageId, bound.messageId);

  return or(
    gt(messages.messageTimestamp, bound.timestamp),
    and(eq(messages.messageTimestamp, bound.timestamp), messageIdCondition),
  )!;
}

/**
 * Returns a SQL condition to limit the query by upper bound.
 *
 * @param bound - The upper bound
 * @returns - Drizzle query condition
 */
function filterByUpperBound(bound: MessageBound): SQL {
  return or(
    lt(messages.messageTimestamp, bound.timestamp),
    and(
      eq(messages.messageTimestamp, bound.timestamp),
      lt(messages.messageId, bound.messageId),
    ),
  )!;
}

/**
 * Check upper bound to be higher than the lower bound.
 * this methods conditions the bounds following the [Negentropy protocol](https://github.com/hoytech/negentropy/blob/master/docs/negentropy-protocol-v1.md)
 *
 * A. The timestamp of upper bound should be higher or equal to lower bound.
 * B. If timestamps are equal, the messageId of upper bound should be higher.
 *
 * @param lower - The lower bound
 * @param upper - the higher bound
 * @returns Returns true if the higher bound meets the conditions.
 */
export function compareMessageBounds(
  lower: MessageBound,
  upper: MessageBound,
): boolean {
  if (lower.timestamp !== upper.timestamp) {
    return lower.timestamp < upper.timestamp;
  }

  return lower.messageId < upper.messageId;
}

/**
 * Validates the common parameters of range queries.
 */
function validateRangeParams(params: RangeParams): void {
  const { spaceId, lowerBound, upperBound, maxRowId } = params;

  if (!isNumber(spaceId) || spaceId <= 0) {
    throw new Error('sapceId should be valid positive number');
  }

  if (
    lowerBound &&
    upperBound &&
    !compareMessageBounds(lowerBound, upperBound)
  ) {
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
 * @param [params.lowerBound] - The boundry for lower end of the query.
 * @param [params.upperBound] - The boundry for the highest end of the query
 * @param [params.maxRowId] - Freezes the set to a snapshot: only rows whose local
 *   primary key is lower or equal to it are visible. Rows inserted after the snapshot
 *   (live messages, or messages imported by another sync session) always get a higher
 *   row ID, so the visible set never changes while a reconciliation is running.
 * @param [params.cursorBound] - alternative to lowerBound without inclusivity of including exact row of the boundry itself.
 *   pagination.
 */
function buildRangeCondition({
  spaceId,
  lowerBound,
  upperBound,
  maxRowId,
  cursorBound,
}: RangeParams & { cursorBound?: MessageBound | null }): SQL {
  const conditions: SQL[] = [eq(messages.spaceId, spaceId)];

  if (cursorBound) {
    conditions.push(filterByLowerBound(cursorBound, { inclusive: false }));
  } else if (lowerBound) {
    conditions.push(filterByLowerBound(lowerBound, { inclusive: true }));
  }

  if (upperBound) {
    conditions.push(filterByUpperBound(upperBound));
  }

  if (maxRowId !== undefined && maxRowId !== null) {
    conditions.push(lte(messages.id, maxRowId));
  }

  return and(...conditions)!;
}

/**
 * Iterates the `(timestamp, messageId)` keys of one space's range in ascending order.
 *
 * @param db - Drizzle database instance
 * @param params.spaceId  - The space ID
 * @param [params.lowerBound] - The lower boundry for the query
 * @param [params.upperBound] - the upper boundry for the query
 * @param [params.maxRowId] - Maximum allowed message-record ID for the query
 * @returns Batches of keys
 */
export async function* iterateRangeKeys(
  db: Database,
  params: RangeParams,
): AsyncGenerator<MessageBound[], void, undefined> {
  validateRangeParams(params);

  const { batchSize = DEFAULT_READ_BATCH_SIZE } = params;
  let cursorBound: MessageBound | null = null;

  while (true) {
    const rows: MessageBound[] = await db
      .select({
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
 * Compute a Negentropy-style fingerprint for one space's timestamp/ID range.
 * Bounds are pair objects `{ timestamp, messageId }`; lower is inclusive and
 * upper is exclusive. Omit either bound to leave that side open. Omit both
 * bounds to fingerprint the entire space for an initial reconciliation handshake.
 * Rows are read in bounded keyset-paginated batches, so memory use is O(batchSize).
 *
 * @param db Drizzle database instance
 * @param params.spaceId Local space primary key
 * @param [params.maxRowId] Only include rows with `id <= maxRowId` (snapshot)
 * @returns First 16 bytes of BLAKE3, as lowercase hex (see finalizeFingerprint)
 */
export async function computeRangeFingerprint(
  db: Database,
  params: RangeParams,
): Promise<string> {
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
 * @param db Drizzle database instance
 * @param params - Same range parameters as `computeRangeFingerprint()`.
 */
export async function countMessagesInRange(
  db: Database,
  params: RangeParams,
): Promise<number> {
  validateRangeParams(params);

  const result = await db
    .select({ total: count() })
    .from(messages)
    .where(buildRangeCondition(params))
    .get();

  return result?.total ?? 0;
}

/**
 * Lists the message IDs of one space's range in ascending `(timestamp, messageId)` order.
 *
 * @param db Drizzle database instance
 * @param params - Same range parameters as `computeRangeFingerprint()`.
 */
export async function listMessageIdsInRange(
  db: Database,
  params: RangeParams,
): Promise<string[]> {
  const ids: string[] = [];

  for await (const rows of iterateRangeKeys(db, params)) {
    for (const row of rows) ids.push(row.messageId);
  }

  return ids;
}

/**
 * Splits one space's range into (up to) `bucketCount` contiguous sub-ranges holding a
 * near-equal number of messages, and fingerprints each of them in a single scan.
 *
 * @param db - Drizzle database instance
 * @param params - Same range parameters as `computeRangeFingerprint()`, plus additional parameters mentioned below.
 * @param params.bucketCount - Maximum number of buckets (>= 1).
 * @param [params.total] - Number of messages in the range, if already known.
 */
export async function computeRangeBuckets(
  db: Database,
  params: RangeParams & { bucketCount: number; total?: number },
): Promise<RangeBucket[]> {
  const { bucketCount } = params;

  if (!isNumber(bucketCount) || bucketCount < 1) {
    throw new RangeError('bucketCount must be a positive integer');
  }

  const total = params.total ?? (await countMessagesInRange(db, params));
  const numBuckets = Math.max(1, Math.min(bucketCount, total));
  const itemsPerBucket = Math.floor(total / numBuckets);
  const extraItems = total % numBuckets; // calculate the leftovers

  const buckets: RangeBucket[] = [];

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
 * @param db Drizzle database instance
 * @param spaceId Local space primary key
 * @returns The highest row ID, or 0 if the space has no messages.
 */
export async function getMessageSnapshotRowId(
  db: Database,
  spaceId: number,
): Promise<number> {
  if (!isNumber(spaceId) || spaceId <= 0) {
    throw new Error('sapceId should be valid positive number');
  }

  const result = await db
    .select({ maxId: max(messages.id) })
    .from(messages)
    .where(eq(messages.spaceId, spaceId))
    .get();

  return result?.maxId ?? 0;
}

/**
 * Loads the full message records of a space by their message IDs.
 * IDs are queried in chunks to stay below SQLite's variable limit.
 *
 * @param db Drizzle database instance
 * @param params.spaceId Local space primary key
 * @param params.messageIds Message IDs to load
 * @returns Message rows ordered by `(timestamp, messageId)`
 */
export async function getMessagesByIds(
  db: Database,
  {
    spaceId,
    messageIds,
    batchSize = DEFAULT_READ_BATCH_SIZE,
  }: { spaceId: number; messageIds: Iterable<string>; batchSize?: number },
): Promise<MessageRecord[]> {
  const ids = [...new Set(messageIds)];
  const records: MessageRecord[] = [];

  for (let index = 0; index < ids.length; index += batchSize) {
    const chunk = ids.slice(index, index + batchSize);
    const rows = await db
      .select()
      .from(messages)
      .where(
        and(eq(messages.spaceId, spaceId), inArray(messages.messageId, chunk)),
      )
      .all();

    records.push(...rows);
  }

  return records.sort((a, b) => {
    if (a.messageTimestamp !== b.messageTimestamp)
      return a.messageTimestamp - b.messageTimestamp;
    return a.messageId < b.messageId ? -1 : a.messageId > b.messageId ? 1 : 0;
  });
}

/**
 * Returns which of the given message ids are stored for a space.
 * Only the id column is read: no payload is loaded into memory.
 * @param db - Drizzle database instance
 * @param params.spaceId Local space primary key
 * @param params.messageIds Message IDs to look up
 * @returns The stored message ids
 */
export async function filterStoredMessageIds(
  db: Database,
  {
    spaceId,
    messageIds,
    batchSize = DEFAULT_READ_BATCH_SIZE,
  }: { spaceId: number; messageIds: Iterable<string>; batchSize?: number },
): Promise<Set<string>> {
  const ids = [...new Set(messageIds)];
  const stored = new Set<string>();

  for (let index = 0; index < ids.length; index += batchSize) {
    const chunk = ids.slice(index, index + batchSize);
    const rows = await db
      .select({ messageId: messages.messageId })
      .from(messages)
      .where(
        and(eq(messages.spaceId, spaceId), inArray(messages.messageId, chunk)),
      )
      .all();

    for (const row of rows) stored.add(row.messageId);
  }

  return stored;
}

/**
 * Loads one full message row (payload included).
 * @param db - Drizzle database instance
 * @param params.spaceId Local space primary key
 * @param params.messageId Message ID
 * @returns The message row, or null when not stored
 */
export async function getMessageRecordById(
  db: Database,
  { spaceId, messageId }: { spaceId: number; messageId: string },
): Promise<MessageRecord | null> {
  const row = await db
    .select()
    .from(messages)
    .where(
      and(eq(messages.spaceId, spaceId), eq(messages.messageId, messageId)),
    )
    .get();

  return row ?? null;
}

/**
 * Decides which of two peers initiates the reconciliation of a topic. Both peers evaluate
 * the same rule with the same inputs, so they agree without exchanging any message.
 * The topic is part of the rank, so across many shared spaces each peer initiates
 * roughly half of the sessions.
 *
 * @param topic - Space topic hash.
 * @param localPublicKey - Public key of the local node.
 * @param peerPublicKey - Public key of the remote peer.
 * @returns True if the local node should initiate.
 */
export function isReconciliationInitiator(
  topic: string,
  localPublicKey: string,
  peerPublicKey: string,
): boolean {
  const rank = (publicKey: string) => hex(hash(`${topic}:${publicKey}`));
  return rank(localPublicKey) < rank(peerPublicKey);
}

/**
 * Prepends a 4-byte big-endian length header to the bytes.
 */
function frame(bytes: Uint8Array): Uint8Array {
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
 */
export function computeMessageId(
  params: Pick<SignedMessage, 'type' | 'publicKey' | 'timestamp' | 'nonce'> & {
    payload: string;
  },
): string {
  const { type, publicKey, timestamp, nonce, payload } = params;

  const buffer = concatBytes(
    frame(utf8ToBytes(type)),
    frame(hexToUint8(publicKey)),
    u64(timestamp),
    frame(hexToUint8(nonce)),
    frame(utf8ToBytes(payload)),
  );

  return hex(hash(buffer));
}

/**
 * Create database filter conditions for message queries.
 * Handles all message field filters including timestamp ranges and payload search.
 *
 * @param filters - query filters (all optional)
 * @param filters.id - exact ID match
 * @param filters.type - exact type match
 * @param filters.spaceId - The related space's ID.
 * @param filters.messageId - the message identity.
 * @param filters.senderPublicKey - sender's public key (exact match)
 * @param filters.broadcastTimestamp - broadcast timestamp range
 * @param filters.broadcastTimestamp.start - start timestamp (inclusive)
 * @param filters.broadcastTimestamp.end - end timestamp (inclusive)
 * @param filters.messageTimestamp - message timestamp range
 * @param filters.messageTimestamp.start - start timestamp (inclusive)
 * @param filters.messageTimestamp.end - end timestamp (inclusive)
 * @param filters.nonce - exact nonce match
 * @param filters.ownerPublicKey - owner's public key (exact match)
 * @param filters.signature - exact signature match
 * @param filters.payloadContains - substring search in payload (case-insensitive)
 * @returns array of SQL conditions for use with drizzle-orm's and() function
 */
export function createMessageFilter(filters: MessageFilters = {}): SQL[] {
  const conditions: SQL[] = [];

  if (filters.id !== undefined) conditions.push(eq(messages.id, filters.id));
  if (filters.type) conditions.push(eq(messages.type, filters.type));
  if (filters.spaceId) conditions.push(eq(messages.spaceId, filters.spaceId));
  if (filters.messageId)
    conditions.push(eq(messages.messageId, filters.messageId));
  if (filters.senderPublicKey)
    conditions.push(eq(messages.senderPublicKey, filters.senderPublicKey));
  if (filters.nonce) conditions.push(eq(messages.nonce, filters.nonce));
  if (filters.ownerPublicKey)
    conditions.push(eq(messages.ownerPublicKey, filters.ownerPublicKey));
  if (filters.signature)
    conditions.push(eq(messages.signature, filters.signature));

  if (filters.broadcastTimestamp) {
    const { start, end } = filters.broadcastTimestamp;
    if (start !== undefined)
      conditions.push(gte(messages.broadcastTimestamp, start));
    if (end !== undefined)
      conditions.push(lte(messages.broadcastTimestamp, end));
  }

  if (filters.messageTimestamp) {
    const { start, end } = filters.messageTimestamp;
    if (start !== undefined)
      conditions.push(gte(messages.messageTimestamp, start));
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
 * @param filters - query filters
 * @param filters.orderBy - field to order by: 'messageTimestamp', 'broadcastTimestamp', or 'id'
 * @param filters.orderDirection - 'asc' for ascending, 'desc' for descending
 * @returns drizzle-orm order expression
 * @throws {Error} if orderBy value is invalid
 */
function getMessageOrderExpression(
  filters: Pick<MessageQueryOptions, 'orderBy' | 'orderDirection'> = {},
): SQL {
  const orderByMap = {
    broadcastTimestamp: messages.broadcastTimestamp,
    messageTimestamp: messages.messageTimestamp,
    id: messages.id,
  };

  const orderByKey =
    typeof filters.orderBy === 'string' ? filters.orderBy : 'messageTimestamp';
  const orderByField = orderByMap[orderByKey as keyof typeof orderByMap];

  if (!orderByField) {
    throw new Error(
      `Invalid orderBy value: ${String(filters.orderBy)}. Allowed: ${Object.keys(orderByMap).join(', ')}`,
    );
  }

  const orderDir =
    typeof filters.orderDirection === 'string' &&
    filters.orderDirection.toLowerCase() === 'asc'
      ? 'asc'
      : 'desc';

  return orderDir === 'asc' ? asc(orderByField) : desc(orderByField);
}

/**
 * Get pagination limits for message queries.
 *
 * @param filters - query filters
 * @param filters.limit - maximum records to return
 * @param filters.offset - records to skip
 * @returns object with limit and offset properties
 */
function getPaginationLimits(
  filters: Pick<MessageQueryOptions, 'limit' | 'offset'> = {},
): { limit: number; offset: number } {
  const limit = Math.min(
    typeof filters.limit === 'number' && filters.limit > 0
      ? filters.limit
      : 100,
    1000,
  );
  const offset =
    typeof filters.offset === 'number' && filters.offset >= 0
      ? filters.offset
      : 0;

  return { limit, offset };
}

/**
 * Build the canonical payload object that should be signed/verified for messages.
 *
 * @param params.message - The original signed message from the network
 * @param params.message.type - Message type
 * @param params.message.publicKey - Original creator's public key (lowercase hex)
 * @param params.message.timestamp - When the message was originally created
 * @param params.message.nonce - Message nonce (24 lowercase hex chars)
 * @param params.message.signature - Owner's signature over the message
 * @param params.message.payload - Message payload (raw value, not pre-stringified)
 * @param params.spaceId - Local primary key of the space (resolved from message.topic by the caller)
 * @param params.senderPublicKey - Immediate sender's public key (differs from owner for relays)
 * @param params.timestamp - When this node received the message
 * @param [params.canonicalPayload] - Canonical JSON of the payload, when the caller already has it
 *   (e.g. delivered history). Skips serializing the payload again; `message.payload` is then ignored.
 * @param [params.messageId] - Precomputed message id matching `canonicalPayload`.
 * @returns Row ready to insert into the messages table
 */
export function buildMessageRecordPayload({
  message,
  spaceId,
  senderPublicKey,
  timestamp,
  canonicalPayload: precomputedPayload,
  messageId: precomputedMessageId,
}: {
  message: SignedMessage;
  spaceId: number;
  senderPublicKey: string;
  timestamp: number;
  canonicalPayload?: string;
  messageId?: string;
}): Required<Omit<NewMessageRecord, 'id'>> {
  if (!isNumber(spaceId)) {
    throw new Error('SpaceId must be an integer');
  }

  const canonicalPayload =
    precomputedPayload ?? canonicalStringify(message.payload);
  if (typeof canonicalPayload !== 'string') {
    throw new Error('message payload could not be canonicalized');
  }

  if (!validateTimestamp(message.timestamp) || !validateTimestamp(timestamp)) {
    throw new Error('timestamp must be non-nagative integer');
  }

  return {
    // network-wide identity, derived from the signed fields
    messageId:
      precomputedMessageId ??
      computeMessageId({
        ...message,
        payload: canonicalPayload,
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
 * @param db - Drizzle DB instance
 * @param params - Parameters object
 * @param params.message - The original message object from the network
 * @param params.message.type - Type of message (e.g., 'text', 'media')
 * @param params.message.topic - Network topic
 * @param params.message.publicKey - Original creator's public key
 * @param params.message.timestamp - When message was originally created
 * @param params.message.nonce - Unique message identifier
 * @param params.message.payload - Stringified JSON content
 * @param params.message.signature - Hex signature of the message payload
 * @param params.senderPublicKey - Immediate sender's public key
 * @param params.broadcastTimestamp - When message was received/broadcasted
 * @param params.spaceId - The space ID.
 * @returns created message row
 */
export async function createMessageRecord(
  db: Database,
  {
    message,
    spaceId,
    senderPublicKey,
    broadcastTimestamp,
  }: {
    message: SignedMessage;
    senderPublicKey: string;
    broadcastTimestamp: number;
    spaceId: number;
  },
): Promise<Pick<MessageRecord, 'id' | 'messageId'>> {
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
      messageId: messages.messageId,
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
 * @param db - Drizzle DB instance
 * @param filters - query filters (all optional)
 * @param filters.id - exact ID match
 * @param filters.type - exact type match
 * @param filters.spaceId - The related space's ID.
 * @param filters.messageId - the message identity.
 * @param filters.senderPublicKey - sender's public key (exact match)
 * @param filters.broadcastTimestamp - broadcast timestamp range
 * @param filters.broadcastTimestamp.start - start timestamp (inclusive)
 * @param filters.broadcastTimestamp.end - end timestamp (inclusive)
 * @param filters.messageTimestamp - message timestamp range
 * @param filters.messageTimestamp.start - start timestamp (inclusive)
 * @param filters.messageTimestamp.end - end timestamp (inclusive)
 * @param filters.nonce - exact nonce match
 * @param filters.ownerPublicKey - owner's public key (exact match)
 * @param filters.signature - exact signature match
 * @param filters.payloadContains - substring search in payload (case-insensitive)
 * @param filters.limit - maximum records to return (default: 100, max: 1000)
 * @param filters.offset - records to skip (default: 0)
 * @param filters.orderBy - field to order by: 'messageTimestamp', 'broadcastTimestamp', or 'id' (default: 'messageTimestamp')
 * @param filters.orderDirection - 'asc' for ascending, 'desc' for descending (default: 'desc')
 * @returns array of message records
 */
export async function queryMessageRecord(
  db: Database,
  filters: MessageQueryOptions = {},
): Promise<MessageRecord[]> {
  const conditions = createMessageFilter(filters);

  const orderExpr = getMessageOrderExpression(filters);
  const { limit, offset } = getPaginationLimits(filters);

  // no conditions → no WHERE clause
  const query = db
    .select()
    .from(messages)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  const results = await query
    .orderBy(orderExpr)
    .limit(limit)
    .offset(offset)
    .all();

  return results;
}

/**
 * Inserts new message record into database only if it doesn't already exist.
 * @param db - Drizzle database instance.
 * @param params.spaceId - The space ID.
 * @param params.message - The original message object from the network.
 * @param params.senderPublicKey - The publicKey of the node which sent the message. (broadcasted)
 * @returns Resolves when the message is either avoided or inserted into the database.
 */
export async function pushMessageToHistory(
  db: Database,
  {
    spaceId,
    message,
    senderPublicKey,
  }: { spaceId: number; message: SignedMessage; senderPublicKey: string },
): Promise<void> {
  if (!message.nonce) return;

  const previousRecords = await queryMessageRecord(db, {
    spaceId: spaceId,
    nonce: message.nonce,
  });

  if (previousRecords.length > 0) return;

  await createMessageRecord(db, {
    message: message,
    spaceId: spaceId,
    senderPublicKey: senderPublicKey,
    broadcastTimestamp: now(),
  });
}

/**
 * Inserts already built message rows in one statement, skipping rows whose message
 * (messageId or nonce) is already stored.
 * @param db - Drizzle database instance.
 * @param rows - Rows built by `buildMessageRecordPayload`.
 * @returns Message ids that were actually inserted.
 */
export async function insertMessageRecords(
  db: Database,
  rows: NewMessageRecord[],
): Promise<string[]> {
  if (rows.length === 0) return [];

  const inserted = await db
    .insert(messages)
    .values(rows)
    .onConflictDoNothing()
    .returning({ messageId: messages.messageId })
    .all();

  return inserted.map((row) => row.messageId);
}

/**
 * Delete message records from the database based on filter criteria.
 *
 * @param db - Drizzle DB instance
 * @param filters - query filters (all optional)
 * @param filters.id - exact ID match
 * @param filters.type - exact type match
 * @param filters.spaceId - The related space's ID.
 * @param filters.messageId - the message identity.
 * @param filters.senderPublicKey - sender's public key (exact match)
 * @param filters.broadcastTimestamp - broadcast timestamp range
 * @param filters.broadcastTimestamp.start - start timestamp (inclusive)
 * @param filters.broadcastTimestamp.end - end timestamp (inclusive)
 * @param filters.messageTimestamp - message timestamp range
 * @param filters.messageTimestamp.start - start timestamp (inclusive)
 * @param filters.messageTimestamp.end - end timestamp (inclusive)
 * @param filters.nonce - exact nonce match
 * @param filters.ownerPublicKey - owner's public key (exact match)
 * @param filters.signature - exact signature match
 * @param filters.payloadContains - substring search in payload (case-insensitive)
 */
export async function flushMessageRecords(
  db: Database,
  filters: MessageFilters & { limit?: number } = {},
): Promise<{ deleteCount: number }> {
  const conditions = createMessageFilter(filters);

  // no conditions → no WHERE clause
  const query = db
    .delete(messages)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  if (filters.limit) {
    query.limit(filters.limit);
  }

  const results = await query;

  return {
    deleteCount: results.changes ?? 0,
  };
}
