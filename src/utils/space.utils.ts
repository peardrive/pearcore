import { eq, like, gte, lte, and, asc, desc } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { fileRegistry } from '../database/schemas/file.schema.js';
import {
  spaces,
  broadcastWhitelist,
  readWhitelist,
} from '../database/schemas/space.schema.js';
import {
  hex,
  hash,
  signJSON,
  hexToUint8,
  randomNonce,
  verifySignedJSON,
  generateRandomSecretKey,
} from './crypto.utils.js';
import {
  isDefined,
  isString,
  isBooleanOrBinary,
  notNull,
  now,
  validateHexString,
  validateTimestamp,
  isObject,
} from './general.utils.js';
import type { Binary } from './general.utils.js';
import { deleteFileRecord } from './files.utils.js';
import { flushMessageRecords } from './message.utils.js';
import type { Database } from '../types/database.js';

/** A spaces table row. */
export type SpaceRecord = typeof spaces.$inferSelect;

/** A space together with its read and broadcast allow lists. */
export type SpaceWithWhitelists = SpaceRecord & {
  broadcastWhitelist: string[];
  readWhitelist: string[];
};

export interface ValidationResult {
  isValid: boolean;
  reason: string;
}

export interface SpacePayload {
  spaceName: string;
  publicKey: string;
  timestamp: number;
  permissionBroadcast: Binary;
  broadcastWhitelist: string[];
  permissionRead: Binary;
  readWhitelist: string[];
  nonce: string;
  secret: string | null;
}

/** Inputs accepted when building or creating a space. */
export interface SpaceInput {
  spaceName: string;
  publicKey: string;
  timestamp: number;
  permissionBroadcast: boolean | number;
  broadcastWhitelist?: string[];
  permissionRead: boolean | number;
  readWhitelist?: string[];
  nonce: string;
  secret?: string | null;
  signature?: string;
}

/** A signed space payload accepted by the database mutation helpers. */
export type SignedSpace = SpacePayload & { signature: string };

export type VerifiableSpace = SignedSpace | SpaceWithWhitelists;

/** Editable fields that updateSpaceForPublicKey can merge with a stored space. */
export type SpaceUpdateInput = Partial<SpaceInput>;

export interface SpaceFilters {
  spaceId?: number;
  spaceName?: string;
  spaceNameLike?: string;
  publicKey?: string;
  timestampFrom?: number;
  timestampTo?: number;
  permissionBroadcast?: boolean | 0 | 1;
  permissionRead?: boolean | 0 | 1;
  nonce?: string;
  orderBy?:
    | 'id'
    | 'spaceName'
    | 'publicKey'
    | 'timestamp'
    | 'permissionBroadcast'
    | 'permissionRead'
    | 'signature'
    | 'nonce'
    | 'secret'
    | (string & {});
  orderDirection?: 'asc' | 'desc' | (string & {});
  limit?: number;
}

type ValidationRule = [reason: string, condition: () => boolean];

/**
 * Generate a Hyperswarm topic name for a space
 * @param spaceName - Name of the space
 * @param publicKey - Hex string of the public key
 * @param nonce - 24 character nonce
 * @returns Topic name like "space___pubkey___nonce"
 */
export function generateSpaceTopic(
  spaceName: string,
  publicKey: string,
  nonce: string | number,
): string {
  if (!spaceName || !publicKey || !nonce) {
    throw new Error('spaceName, publicKey, and nonce are required');
  }

  return `${spaceName}___${publicKey}___${nonce}`;
}

/**
 * generate 64 character random hex key as secret
 */
export function generateSpaceSecret(): string {
  const result = generateRandomSecretKey(32);
  return result;
}

/**
 * Generate the topic hash for a given space.
 *
 * @param space
 * @returns Hex-encoded topic hash
 */
export function getSpaceTopicHash(
  space: Pick<SpacePayload, 'spaceName' | 'publicKey' | 'nonce'>,
): string {
  const topic = generateSpaceTopic(
    space.spaceName,
    space.publicKey,
    space.nonce,
  );

  return hex(hash(topic));
}

function convertPermission(permission: unknown): Binary {
  // undefined parameter or non-binary values should dropped as permission set
  if (!isDefined(permission) || !isBooleanOrBinary(permission)) {
    return 1;
  }

  // convert boolean to binary if exists
  return permission ? 1 : 0;
}

/**
 * Resolve the secret associated with a space based on its read permission.
 *
 * Rules enforced:
 * 1. If permissionRead is true, the space must not have a secret => return null.
 * 2. If permissionRead is false and a secret is provided => use it.
 */
function secretIsRequired(input: { permissionRead?: unknown }): boolean {
  return convertPermission(input.permissionRead) ? false : true;
}

export function buildSpacePayload(source: SpaceInput): SpacePayload {
  const permissionRead = convertPermission(source.permissionRead);
  const permissionBroadcast = convertPermission(source.permissionBroadcast);

  return {
    spaceName: source.spaceName,
    publicKey: source.publicKey,
    permissionBroadcast: permissionBroadcast,
    broadcastWhitelist:
      !permissionBroadcast && Array.isArray(source.broadcastWhitelist)
        ? source.broadcastWhitelist
        : [],
    permissionRead: permissionRead,
    readWhitelist:
      !permissionRead && Array.isArray(source.readWhitelist)
        ? source.readWhitelist
        : [],
    nonce: source.nonce,
    timestamp: source.timestamp,
    secret: secretIsRequired(source) ? (source.secret ?? null) : null,
  };
}

/**
 * Validates the structure of space object to ensure it meets all required criteria.
 * @param space - The space object for validation.
 * @returns An object indicating whether validation passed and the reason for failure if it did not.
 *         If `isValid` is true, then `reason` will be `'space is valid'`.
 *         Otherwise, `reason` describes which field failed validation.
 */
export function validateSpaceContext(input: unknown): ValidationResult {
  if (input === null || typeof input !== 'object') {
    return { isValid: false, reason: 'space is required' };
  }

  const space = input as Record<keyof SignedSpace, any>;
  const validationRules: ValidationRule[] = [
    ['spaceName is required', () => isDefined(space.spaceName)],
    ['publicKey is required', () => isDefined(space.publicKey)],
    ['timestamp is required', () => isDefined(space.timestamp)],
    ['signature is required', () => isDefined(space.signature)],
    ['nonce is required', () => isDefined(space.nonce)],
    [
      'permissionBroadcast is required',
      () => isDefined(space.permissionBroadcast),
    ],
    [
      'broadcastWhitelist is required',
      () => isDefined(space.broadcastWhitelist),
    ],
    ['permissionRead is required', () => isDefined(space.permissionRead)],
    ['readWhitelist is required', () => isDefined(space.readWhitelist)],

    ['spaceName should be string', () => isString(space.spaceName)],
    [
      'spaceName should not a larger that 64 characters',
      () => space.spaceName.length <= 64,
    ],

    ['publicKey should be a string', () => isString(space.publicKey)],
    [
      'publicKey should be 64 characters long',
      () => space.publicKey.length === 64,
    ],
    [
      'publicKey should be a valid hex string',
      () => validateHexString(space.publicKey),
    ],

    [
      'timestamp should be a valid date',
      () => validateTimestamp(space.timestamp),
    ],

    ['signature should be a string', () => isString(space.signature)],
    [
      'signature should be 128 characters long',
      () => space.signature.length === 128,
    ],
    [
      'signature should be a valid hex string',
      () => validateHexString(space.signature),
    ],

    ['nonce should be a string', () => isString(space.nonce)],
    ['nonce should be 24 characters long', () => space.nonce.length === 24],
    [
      'nonce should be a valid hex string',
      () => validateHexString(space.nonce),
    ],

    [
      'secret should be either null or 64 character hex string',
      () =>
        !notNull(space.secret) ||
        (typeof space.secret === 'string' && validateHexString(space.secret)),
    ],

    [
      'permissionBroadcast should be boolean or binary',
      () => isBooleanOrBinary(space.permissionBroadcast),
    ],

    [
      'broadcastWhitelist should be an array',
      () => Array.isArray(space.broadcastWhitelist),
    ],
    [
      'broadcastWhitelist should contain only strings',
      () =>
        space.broadcastWhitelist.every((pk: unknown) => typeof pk === 'string'),
    ],
    [
      'in broadcastWhitelist, each publicKey should be 64 character long',
      () =>
        space.broadcastWhitelist.every(
          (pk: unknown) => typeof pk === 'string' && pk.length === 64,
        ),
    ],
    [
      'in broadcastWhitelist, each publicKey should be valid hex string',
      () =>
        space.broadcastWhitelist.every(
          (pk: unknown) => typeof pk === 'string' && validateHexString(pk),
        ),
    ],

    [
      'permissionRead should be boolean or binary',
      () => isBooleanOrBinary(space.permissionRead),
    ],

    [
      'readWhitelist should be an array',
      () => Array.isArray(space.readWhitelist),
    ],
    [
      'readWhitelist should contain only strings',
      () => space.readWhitelist.every((pk: unknown) => typeof pk === 'string'),
    ],
    [
      'in readWhitelist, each publicKey should be 64 character long',
      () =>
        space.readWhitelist.every(
          (pk: unknown) => typeof pk === 'string' && pk.length === 64,
        ),
    ],
    [
      'in readWhitelist, each publicKey should be valid hex string',
      () =>
        space.readWhitelist.every(
          (pk: unknown) => typeof pk === 'string' && validateHexString(pk),
        ),
    ],
  ];

  for (const [reason, condition] of validationRules) {
    if (!condition()) {
      return {
        isValid: false,
        reason: reason,
      };
    }
  }

  return {
    isValid: true,
    reason: 'space is valid',
  };
}

/**
 * Verify a space object using its Ed25519 signature.
 * @param space - JSON space object (including `signature`).
 * @returns True if the signature is valid.
 */
export async function verifySpaceSignature(space: VerifiableSpace): Promise<boolean> {
  if (!space.signature) {
    return false;
  }

  const signatureHex = space.signature;
  const publicKeyBytes = hexToUint8(space.publicKey);

  const payload = buildSpacePayload(space as unknown as SpaceInput);
  const signatureIsOK = await verifySignedJSON(
    payload,
    signatureHex,
    publicKeyBytes,
  );

  return signatureIsOK;
}

/**
 * Create a new space and associated whitelist entries
 * @param input
 * @param input.spaceName
 * @param input.publicKey
 * @param input.permissionBroadcast
 * @param input.broadcastWhitelist
 * @param input.permissionRead
 * @param input.readWhitelist
 * @param input.signature
 */
export async function createSpace(
  db: Database,
  input: SignedSpace,
): Promise<{ spaceId: number }> {
  const insertedSpace = await db
    .insert(spaces)
    .values({
      spaceName: input.spaceName,
      publicKey: input.publicKey,
      timestamp: input.timestamp,
      permissionBroadcast: Number(input.permissionBroadcast),
      permissionRead: Number(input.permissionRead),
      signature: input.signature,
      nonce: input.nonce,
      secret: secretIsRequired(input) ? input.secret : null,
    })
    .returning({ id: spaces.id });

  const spaceId = insertedSpace[0].id;

  // Insert broadcast whitelist entries if broadcasting is restricted
  if (!input.permissionBroadcast && input.broadcastWhitelist.length > 0) {
    const broadcastRows = input.broadcastWhitelist.map((key: string) => ({
      spaceId,
      allowedPublicKey: key,
    }));
    await db.insert(broadcastWhitelist).values(broadcastRows);
  }

  // Insert read whitelist entries if reading is restricted
  if (!input.permissionRead && input.readWhitelist.length > 0) {
    const readRows = input.readWhitelist.map((key: string) => ({
      spaceId,
      allowedPublicKey: key,
    }));
    await db.insert(readWhitelist).values(readRows);
  }

  return { spaceId };
}

/**
 * Update an existing space and replace its whitelist entries.
 *
 * @param db - Drizzle database instance.
 * @param spaceId - ID of the space to update.
 * @param input
 * @param input.spaceName
 * @param input.publicKey
 * @param input.permissionBroadcast
 * @param input.broadcastWhitelist
 * @param input.permissionRead
 * @param input.readWhitelist
 * @param input.signature
 */
export async function updateSpace(
  db: Database,
  spaceId: number,
  input: SpaceUpdateInput,
): Promise<{ spaceId: number }> {
  await db
    .update(spaces)
    .set({
      spaceName: input.spaceName,
      publicKey: input.publicKey,
      timestamp: input.timestamp,
      permissionBroadcast: Number(input.permissionBroadcast),
      permissionRead: Number(input.permissionRead),
      signature: input.signature,
      nonce: input.nonce,
      secret: secretIsRequired(input) ? input.secret : null,
    })
    .where(eq(spaces.id, spaceId));

  // Remove old whitelist entries
  await db
    .delete(broadcastWhitelist)
    .where(eq(broadcastWhitelist.spaceId, spaceId));

  await db.delete(readWhitelist).where(eq(readWhitelist.spaceId, spaceId));

  // Insert broadcast whitelist entries if broadcasting is restricted
  if (!input.permissionBroadcast && input.broadcastWhitelist?.length) {
    const broadcastRows = input.broadcastWhitelist.map((key) => ({
      spaceId,
      allowedPublicKey: key,
    }));
    await db.insert(broadcastWhitelist).values(broadcastRows);
  }

  // Insert read whitelist entries if reading is restricted
  if (!input.permissionRead && input.readWhitelist?.length) {
    const readRows = input.readWhitelist.map((key) => ({
      spaceId,
      allowedPublicKey: key,
    }));
    await db.insert(readWhitelist).values(readRows);
  }

  return { spaceId };
}

/**
 * Create a space given keypair credentials.
 * Signs the full input payload using the Ed25519 secret key.
 *
 * @param db - Drizzle DB instance.
 * @param input
 * @param input.spaceName
 * @param input.publicKey
 * @param input.permissionBroadcast
 * @param input.broadcastWhitelist
 * @param input.permissionRead
 * @param input.readWhitelist
 * @param secretKey - Ed25519 secret key.
 */
export async function createSpaceForPublicKey(
  db: Database,
  input: SpaceInput,
  secretKey: Uint8Array | string,
): Promise<{ spaceId: number }> {
  const payload = buildSpacePayload({
    ...input,
    nonce: input.nonce ?? hex(randomNonce()),
    timestamp: input.timestamp ?? now(),
    secret: secretIsRequired(input) ? generateSpaceSecret() : null,
  });

  const signature = await signJSON(payload, secretKey);

  return createSpace(db, {
    ...payload,
    signature,
  });
}

/**
 * Updates a space row by recreating the payload from existing space data,
 * merging with input changes (excluding publicKey and nonce), updating timestamp,
 * and calculating a new signature using the keypair credentials.
 *
 * @param db - Drizzle DB instance
 * @param space - Existing space row from database
 * @param input - Partial space data to update (excluding publicKey and nonce)
 * @param secretKey - Secret key to sign the updated payload
 * @returns Updated space row
 */
export async function updateSpaceForPublicKey(
  db: Database,
  spaceId: number,
  input: SpaceUpdateInput,
  secretKey: Uint8Array | string,
): Promise<{ spaceId: number }> {
  const existing = await getSpace(db, spaceId);
  if (!existing) {
    throw new Error('Space not found');
  }

  const payload = buildSpacePayload({
    ...existing,
    ...input,
    timestamp: now(), // timestamp should be updated each time
  });

  const signature = await signJSON(payload, secretKey);

  return updateSpace(db, spaceId, {
    ...payload,
    signature,
  });
}

async function withWhitelists(
  db: Database,
  space: SpaceRecord,
): Promise<SpaceWithWhitelists> {
  const broadcastList = space.permissionBroadcast
    ? []
    : await db
        .select()
        .from(broadcastWhitelist)
        .where(eq(broadcastWhitelist.spaceId, space.id))
        .all();
  const readList = space.permissionRead
    ? []
    : await db
        .select()
        .from(readWhitelist)
        .where(eq(readWhitelist.spaceId, space.id))
        .all();

  return {
    ...space,
    broadcastWhitelist: broadcastList.map((row) => row.allowedPublicKey),
    readWhitelist: readList.map((row) => row.allowedPublicKey),
  };
}

/**
 * Get a single space by ID, including its whitelists.
 * @param db - Database instance.
 * @param spaceId - ID of the space.
 * @returns Space object with whitelists, or null if not found.
 */
export async function getSpace(
  db: Database,
  spaceId: number,
): Promise<SpaceWithWhitelists | null> {
  const space = await db
    .select()
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .get();

  if (!space) return null;
  return withWhitelists(db, space);
}

/**
 * Upsert a space.
 * If it exists, replace it entirely (including whitelists).
 *
 * @param db - Drizzle instance.
 * @param input
 */
export async function upsertSpace(
  db: Database,
  input: SignedSpace,
): Promise<{ spaceId: number }> {
  if (!input.signature) {
    throw new Error('Signature is required for space upsertion.');
  }
  const isValid = await verifySpaceSignature(input);
  if (!isValid) {
    throw new Error('Invalid signature for space upsertion.');
  }

  const existingQuery = await querySpace(db, {
    spaceName: input.spaceName,
    publicKey: input.publicKey,
    nonce: input.nonce,
  });

  const exists = existingQuery.length > 0;

  let spaceId;

  if (!exists) {
    const created = await createSpace(db, input);
    spaceId = created.spaceId;
  } else {
    const existing = existingQuery[0];
    if (input.timestamp <= existing.timestamp) {
      throw new Error('Timestamp must be greater than existing timestamp');
    }

    spaceId = existing.id;

    await updateSpace(db, spaceId, input);
  }

  return { spaceId };
}

/** Create SQL conditions for the supported space query filters. */
export function createSpaceFilter(filters: SpaceFilters = {}): SQL[] {
  const conditions: SQL[] = [];

  if (filters.spaceId !== undefined) {
    conditions.push(eq(spaces.id, filters.spaceId));
  }
  if (filters.spaceName !== undefined) {
    conditions.push(eq(spaces.spaceName, filters.spaceName));
  }
  if (filters.spaceNameLike !== undefined) {
    conditions.push(like(spaces.spaceName, `%${filters.spaceNameLike}%`));
  }
  if (filters.publicKey !== undefined) {
    conditions.push(eq(spaces.publicKey, filters.publicKey));
  }
  if (filters.timestampFrom !== undefined) {
    conditions.push(gte(spaces.timestamp, filters.timestampFrom));
  }
  if (filters.timestampTo !== undefined) {
    conditions.push(lte(spaces.timestamp, filters.timestampTo));
  }
  if (filters.permissionBroadcast !== undefined) {
    conditions.push(
      eq(spaces.permissionBroadcast, filters.permissionBroadcast ? 1 : 0),
    );
  }
  if (filters.permissionRead !== undefined) {
    conditions.push(eq(spaces.permissionRead, filters.permissionRead ? 1 : 0));
  }
  if (filters.nonce !== undefined) {
    conditions.push(eq(spaces.nonce, filters.nonce));
  }

  return conditions;
}

/** Resolve and validate the requested sort column and direction. */
function getSpaceOrderExpression(
  filters: Pick<SpaceFilters, 'orderBy' | 'orderDirection'> = {},
): SQL {
  const orderByMap = {
    id: spaces.id,
    spaceName: spaces.spaceName,
    publicKey: spaces.publicKey,
    timestamp: spaces.timestamp,
    permissionBroadcast: spaces.permissionBroadcast,
    permissionRead: spaces.permissionRead,
    signature: spaces.signature,
    nonce: spaces.nonce,
    secret: spaces.secret,
  };
  const orderByKey = filters.orderBy ?? 'timestamp';
  const orderByField = orderByMap[orderByKey as keyof typeof orderByMap];

  if (!orderByField) {
    throw new Error(
      `Invalid orderBy value: ${String(filters.orderBy)}. Allowed: ${Object.keys(orderByMap).join(', ')}`,
    );
  }

  return filters.orderDirection === 'desc'
    ? desc(orderByField)
    : asc(orderByField);
}

/**
 * Query spaces with flexible filter options.
 *
 * @param db - Drizzle database instance.
 * @param filters - Flexible filtering criteria.
 * @param filters.spaceId - Exact match by ID.
 * @param filters.spaceName - Exact match.
 * @param filters.spaceNameLike - Partial name match.
 * @param filters.publicKey - Filter by writer/broadcaster.
 * @param filters.timestampFrom - Minimum timestamp.
 * @param filters.timestampTo - Maximum timestamp.
 * @param filters.permissionBroadcast
 * @param filters.permissionRead
 * @param filters.orderBy - Field to order by. Defaults to `timestamp`.
 * @param filters.orderDirection - Sort direction. Defaults to `asc`.
 * @param filters.limit - Optional query limit.
 *
 * @returns List of matching spaces with whitelists populated.
 */
export async function querySpace(
  db: Database,
  filters: SpaceFilters = {},
): Promise<SpaceWithWhitelists[]> {
  const conditions = createSpaceFilter(filters);
  const query = db
    .select()
    .from(spaces)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(getSpaceOrderExpression(filters));

  const rawSpaces = filters.limit
    ? await query.limit(filters.limit).all()
    : await query.all();

  return Promise.all(rawSpaces.map((space) => withWhitelists(db, space)));
}

/**
 * List all spaces, optionally filtered by publicKey
 * @param db - Database instance.
 * @param opts - Optional filters.
 * @param opts.publicKey - Filter by the space creator's public key.
 * @returns Space objects with whitelists.
 */
export async function listSpaces(
  db: Database,
  opts: Pick<SpaceFilters, 'publicKey'> = {},
): Promise<SpaceWithWhitelists[]> {
  const allSpaces = opts.publicKey
    ? await db
        .select()
        .from(spaces)
        .where(eq(spaces.publicKey, opts.publicKey))
        .all()
    : await db.select().from(spaces).all();

  return Promise.all(allSpaces.map((space) => withWhitelists(db, space)));
}

/**
 * Returns space topic hashes as an array.
 * @param db
 */
export async function getTopicList(db: Database): Promise<string[]> {
  const spaces = await listSpaces(db);
  return spaces.map((space) => getSpaceTopicHash(space));
}

/**
 * Creates a map for space ID -> topic hash.
 * @param db - Drizzle database instance.
 */
export async function getSpaceToTopicMap(
  db: Database,
): Promise<Map<number, string>> {
  const spaces = await listSpaces(db);
  const spaceTopicMap = new Map<number, string>();

  for (const space of spaces) {
    const topicHash = getSpaceTopicHash(space);
    spaceTopicMap.set(space.id, topicHash);
  }

  return spaceTopicMap;
}

/**
 * Creates a map for topic hash -> space ID.
 * @param db - Drizzle database instance.
 */
export async function getTopicToSpaceMap(
  db: Database,
): Promise<Map<string, number>> {
  const spaces = await listSpaces(db);
  const topicMap = new Map<string, number>();

  for (const space of spaces) {
    const topicHash = getSpaceTopicHash(space);
    topicMap.set(topicHash, space.id);
  }

  return topicMap;
}

/**
 * Deletes a space and it's associated whitelist entries.
 *
 * @param db - Drizzle database instance.
 * @param spaceId - ID of the space to delete.
 * @returns Resolves when the row is deleted.
 */
export async function deleteSpace(
  db: Database,
  spaceId: number,
): Promise<void> {
  const fileRegistries = await db
    .select({ id: fileRegistry.id })
    .from(fileRegistry)
    .where(eq(fileRegistry.spaceId, spaceId))
    .all();

  for (const registry of fileRegistries) {
    await deleteFileRecord(db, registry.id);
  }

  await flushMessageRecords(db, { spaceId: spaceId });

  await db
    .delete(broadcastWhitelist)
    .where(eq(broadcastWhitelist.spaceId, spaceId));

  await db.delete(readWhitelist).where(eq(readWhitelist.spaceId, spaceId));

  await db.delete(spaces).where(eq(spaces.id, spaceId));
}
