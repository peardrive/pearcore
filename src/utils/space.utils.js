import { eq, inArray, like, gte, lte, and, asc, desc } from 'drizzle-orm';
import { spaces, broadcastWhitelist, readWhitelist } from "../database/schemas/space.schema.js";
import { spaceMembers } from "../database/schemas/spaceMembers.schema.js";
import { userProfiles } from "../database/schemas/profile.schema.js";
import { isString, now, validateHexString, validateTimestamp } from "./general.utils.js";
import {
  hex,
  hash,
  signJSON,
  hexToUint8,
  randomNonce,
  verifySignedJSON,
  generateRandomSecretKey,
} from "../utils/crypto.utils.js";
import {
  notNull,
  notUndefined,
  isDefined,
  isBinary,
  isBoolean,
  isBooleanOrBinary
} from './general.utils.js';
import { deleteFileRecord, queryFileRegistryRecords } from './files.utils.js';

/**
 * Generate a Hyperswarm topic name for a space
 * @param {string} spaceName - Name of the space
 * @param {string} publicKey - Hex string of the public key
 * @param {string} nonce - 24 character nonce
 * @returns {string} - Topic name like "space___pubkey___nonce"
 */
export function generateSpaceTopic(spaceName, publicKey, nonce) {
  if (!spaceName || !publicKey || !nonce) {
    throw new Error("spaceName, publicKey, and nonce are required");
  }

  return `${spaceName}___${publicKey}___${nonce}`;
}

/**
 * generate 64 character random hex key as secret
 */
export function generateSpaceSecret() {
  const result = generateRandomSecretKey(32);
  return result;
}


/**
 * Generate the topic hash for a given space.
 *
 * @param {object} space
 * @returns {string} hex-encoded topic hash
 */
export function getSpaceTopicHash(space) {
  const topic = generateSpaceTopic(
    space.spaceName,
    space.publicKey,
    space.nonce
  );

  return hex(hash(topic));
}

function convertPermission(permission) {
  // undefined parameter or non-binary values should dropped as permission set
  if (!isDefined(permission) || !isBooleanOrBinary(permission)) 
  {
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
function secretIsRequired(input) {
  return convertPermission(input.permissionRead) ? false : true;
}

export function buildSpacePayload(source) {
  const permissionRead = convertPermission(source.permissionRead);
  const permissionBroadcast = convertPermission(source.permissionBroadcast);

  return {
    spaceName: source.spaceName,
    publicKey: source.publicKey,
    permissionBroadcast: permissionBroadcast,
    broadcastWhitelist: !permissionBroadcast && Array.isArray(source.broadcastWhitelist)
      ? source.broadcastWhitelist
      : [],
    permissionRead: permissionRead,
    readWhitelist: !permissionRead && Array.isArray(source.readWhitelist)
      ? source.readWhitelist
      : [],
    nonce: source.nonce,
    timestamp: source.timestamp,
    secret: secretIsRequired(source) ? source.secret : null
  };
}

/**
 * Validates the structure of space object to ensure it meets all required criteria.
 * @param {Object} space - the space object for validation
 * @returns {{isValid: boolean, reason: string}} An object indicating whether validation passed and the reason for failure if it did not.
 *         If `isValid` is true, then `reason` will be `'space is valid'`.
 *         Otherwise, `reason` describes which field failed validation.
 */
export function validateSpaceContext(space) {
  const validationRules = [
    ['spaceName is required', () => isDefined(space.spaceName)],
    ['publicKey is required', () => isDefined(space.publicKey)],
    ['timestamp is required', () => isDefined(space.timestamp)],
    ['signature is required', () => isDefined(space.signature)],
    ['nonce is required', () => isDefined(space.nonce)],
    ['permissionBroadcast is required', () => isDefined(space.permissionBroadcast)],
    ['broadcastWhitelist is required', () => isDefined(space.broadcastWhitelist)],
    ['permissionRead is required', () => isDefined(space.permissionRead)],
    ['readWhitelist is required', () => isDefined(space.readWhitelist)],

    ['spaceName should be string', () => isString(space.spaceName)],
    ['spaceName should not a larger that 64 characters', () => space.spaceName.length <= 64],

    ['publicKey should be a string', () => isString(space.publicKey)],
    ['publicKey should be 64 characters long', () => space.publicKey.length === 64],
    ['publicKey should be a valid hex string', () => validateHexString(space.publicKey)],

    ['timestamp should be a valid date', () => validateTimestamp(space.timestamp)],

    ['signature should be a string', () => isString(space.signature)],
    ['signature should be 128 characters long', () => space.signature.length === 128],
    ['signature should be a valid hex string', () => validateHexString(space.signature)],

    ['nonce should be a string', () => isString(space.nonce)],
    ['nonce should be 24 characters long', () => space.nonce.length === 24],
    ['nonce should be a valid hex string', () => validateHexString(space.nonce)],

    ['secret should be either null or 64 character hex string', () => (
      !notNull(space.secret) ||
      (typeof space.secret === 'string' && validateHexString(space.secret))
    )],

    ['permissionBroadcast should be boolean or binary', () => isBooleanOrBinary(space.permissionBroadcast)],

    ['broadcastWhitelist should be an array', () => Array.isArray(space.broadcastWhitelist)],
    ['broadcastWhitelist should contain only strings', () => space.broadcastWhitelist.every(pk => typeof pk === 'string')],
    ['in broadcastWhitelist, each publicKey should be 64 character long', () => space.broadcastWhitelist.every(pk => pk.length === 64)],
    ['in broadcastWhitelist, each publicKey should be valid hex string', () => space.broadcastWhitelist.every(pk => validateHexString(pk))],

    ['permissionRead should be boolean or binary', () => isBooleanOrBinary(space.permissionRead)],

    ['readWhitelist should be an array', () => Array.isArray(space.readWhitelist)],
    ['readWhitelist should contain only strings', () => space.readWhitelist.every(pk => typeof pk === 'string')],
    ['in readWhitelist, each publicKey should be 64 character long', () => space.readWhitelist.every(pk => pk.length === 64)],
    ['in readWhitelist, each publicKey should be valid hex string', () => space.readWhitelist.every(pk => validateHexString(pk))],
  ];

  for (const [reason, condition] of validationRules) {
    if (!condition()) {
      return {
        isValid: false,
        reason: reason
      };
    }
  }

  return {
    isValid: true,
    reason: 'space is valid'
  };
}


/**
 * Verify a space object using its Ed25519 signature.
 * @param {Object} space - JSON space object (including `signature`)
 * @returns {boolean} true if signature is valid
 */
export async function verifySpaceSignature(space) {

  if (!space.signature) {
    return false;
  }

  const signatureHex = space.signature;
  const publicKeyBytes = hexToUint8(space.publicKey);

  const payload = buildSpacePayload(space);
  const signatureIsOK = await verifySignedJSON(payload, signatureHex, publicKeyBytes);

  return signatureIsOK
}

/**
 * Create a new space and associated whitelist entries
 * @param {Object} input
 * @param {string} input.spaceName
 * @param {string} input.publicKey
 * @param {boolean} input.permissionBroadcast
 * @param {string[]} input.broadcastWhitelist
 * @param {boolean} input.permissionRead
 * @param {string[]} input.readWhitelist
 * @param {string} input.signature
 */
export async function createSpace(db, input) {
  const insertedSpace = await db.insert(spaces).values({
    spaceName: input.spaceName,
    publicKey: input.publicKey,
    timestamp: input.timestamp,
    permissionBroadcast: Number(input.permissionBroadcast),
    permissionRead: Number(input.permissionRead),
    signature: input.signature,
    nonce: input.nonce,
    secret: secretIsRequired(input) ? input.secret : null
  }).returning({ id: spaces.id });

  const spaceId = insertedSpace[0].id;

  // Insert broadcast whitelist entries if broadcasting is restricted
  if (!input.permissionBroadcast && input.broadcastWhitelist.length > 0) {
    const broadcastRows = input.broadcastWhitelist.map((key) => ({
      spaceId,
      allowedPublicKey: key,
    }));
    await db.insert(broadcastWhitelist).values(broadcastRows);
  }

  // Insert read whitelist entries if reading is restricted
  if (!input.permissionRead && input.readWhitelist.length > 0) {
    const readRows = input.readWhitelist.map((key) => ({
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
 * @param {Object} db - Drizzle database instance
 * @param {number} spaceId - ID of the space to update
 * @param {Object} input
 * @param {string} input.spaceName
 * @param {string} input.publicKey
 * @param {boolean} input.permissionBroadcast
 * @param {string[]} input.broadcastWhitelist
 * @param {boolean} input.permissionRead
 * @param {string[]} input.readWhitelist
 * @param {string} input.signature
 */
export async function updateSpace(db, spaceId, input) {
  await db.update(spaces)
    .set({
      spaceName: input.spaceName,
      publicKey: input.publicKey,
      timestamp: input.timestamp,
      permissionBroadcast: Number(input.permissionBroadcast),
      permissionRead: Number(input.permissionRead),
      signature: input.signature,
      nonce: input.nonce,
      secret: secretIsRequired(input) ? input.secret : null
    })
    .where(eq(spaces.id, spaceId));

  // Remove old whitelist entries
  await db.delete(broadcastWhitelist)
    .where(eq(broadcastWhitelist.spaceId, spaceId));

  await db.delete(readWhitelist)
    .where(eq(readWhitelist.spaceId, spaceId));

  // Insert broadcast whitelist entries if broadcasting is restricted
  if (!input.permissionBroadcast && input.broadcastWhitelist.length > 0) {
    const broadcastRows = input.broadcastWhitelist.map((key) => ({
      spaceId,
      allowedPublicKey: key,
    }));
    await db.insert(broadcastWhitelist).values(broadcastRows);
  }

  // Insert read whitelist entries if reading is restricted
  if (!input.permissionRead && input.readWhitelist.length > 0) {
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
 * @param {Object} db - Drizzle DB instace
 * @param {Object} input - The space payload
 * @param {Uint8Array} secretKey - Ed25519 secret key (Uint8Array)
 */
export async function createSpaceForPublicKey(db, input, secretKey) {

  const payload = buildSpacePayload({
    ...input,
    nonce: input.nonce ?? hex(randomNonce()),
    timestamp: input.timestamp ?? now(),
    secret: secretIsRequired(input) ? generateSpaceSecret() : null
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
export async function updateSpaceForPublicKey(db, spaceId, input, secretKey) {
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
    signature
  });
}

/**
 * Get a single space by ID, including its whitelists.
 * @param {Object} db - Database instance
 * @param {number} spaceId - ID of the space
 * @returns {Object|null} - Space object with whitelists, or null if not found
 */
export async function getSpace(db, spaceId) {
  const space = await db.select()
    .from(spaces)
    .where(eq(spaces.id, spaceId))
    .get();

  if (!space) return null;

  let broadcastList = [];
  let readList = [];

  if (!space.permissionBroadcast) {
    broadcastList = await db.select()
      .from(broadcastWhitelist)
      .where(eq(broadcastWhitelist.spaceId, spaceId))
      .all();
  }

  if (!space.permissionRead) {
    readList = await db.select()
      .from(readWhitelist)
      .where(eq(readWhitelist.spaceId, spaceId))
      .all();
  }

  return {
    ...space,
    broadcastWhitelist: broadcastList.length
      ? broadcastList.map(r => r.allowedPublicKey)
      : [],
    readWhitelist: readList.length
      ? readList.map(r => r.allowedPublicKey)
      : [],
  };
}

/**
 * Upsert a space.
 * If it exists, replace it entirely (including whitelists).
 *
 * @param {Object} db - Drizzle instance
 * @param {Object} input
 * @returns {Promise<{ spaceId: number }>}
 */
export async function upsertSpace(db, input) {
  if (!input.signature) {
    throw new Error('Signature is required for Space upsertion.');
  }
  const isValid = await verifySpaceSignature(input);
  if (!isValid) {
    throw new Error('Invalid signature for Space upsertion.');
  }

  const existingQuery = await querySpace(db, {
    spaceName: input.spaceName,
    publicKey: input.publicKey,
    nonce: input.nonce
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

/**
 * Query spaces with flexible filter options.
 *
 * @param {Object} db - Drizzle database instance.
 * @param {Object} filters - Flexible filtering criteria.
 * @param {string} [filters.spaceId] - Exact match by id.
 * @param {string} [filters.spaceName] - Exact match.
 * @param {string} [filters.spaceNameLike] - Partial name match.
 * @param {string} [filters.publicKey] - Filter by writer/broadcaster.
 * @param {number} [filters.timestampFrom] - Min timestamp.
 * @param {number} [filters.timestampTo] - Max timestamp.
 * @param {boolean} [filters.permissionBroadcast]
 * @param {boolean} [filters.permissionRead]
 * @param {string} [filters.orderBy="timestamp"] - Field to order by.
 * @param {"asc"|"desc"} [filters.orderDirection="asc"]
 * @param {number} [filters.limit] - Optional query limit.
 *
 * @returns {Promise<Array>} List of matching spaces with whitelists populated.
 */
export async function querySpace(db, filters = {}) {
  const {
    spaceId,
    spaceName,
    spaceNameLike,
    publicKey,
    timestampFrom,
    timestampTo,
    permissionBroadcast,
    permissionRead,
    nonce,
    orderBy = "timestamp",
    orderDirection = "asc",
    limit
  } = filters;

  const conditions = [];

  if (spaceId !== undefined) {
    conditions.push(eq(spaces.id, spaceId));
  }
  if (spaceName !== undefined) {
    conditions.push(eq(spaces.spaceName, spaceName));
  }
  if (spaceNameLike !== undefined) {
    conditions.push(like(spaces.spaceName, `%${spaceNameLike}%`));
  }
  if (publicKey !== undefined) {
    conditions.push(eq(spaces.publicKey, publicKey));
  }
  if (timestampFrom !== undefined) {
    conditions.push(gte(spaces.timestamp, timestampFrom));
  }
  if (timestampTo !== undefined) {
    conditions.push(lte(spaces.timestamp, timestampTo));
  }
  if (permissionBroadcast !== undefined) {
    conditions.push(eq(spaces.permissionBroadcast, permissionBroadcast ? 1 : 0));
  }
  if (permissionRead !== undefined) {
    conditions.push(eq(spaces.permissionRead, permissionRead ? 1 : 0));
  }

  if (nonce !== undefined) {
    conditions.push(eq(spaces.nonce, nonce));
  }

  let stmt = db
    .select()
    .from(spaces)
    .where(conditions.length ? and(...conditions) : undefined);

  if (orderBy) {
    stmt = stmt.orderBy(
      orderDirection === "desc"
        ? desc(spaces[orderBy])
        : asc(spaces[orderBy])
    );
  }

  if (limit) {
    stmt = stmt.limit(limit);
  }

  const rawSpaces = await stmt.all();

  // Here we Post-Process Whitelist data from the database
  // Effectively fetch all stored public-keys by the space ID
  const enrichedSpaces = [];

  for (const sp of rawSpaces) {
    let broadcastList = [];
    let readList = [];

    if (!sp.permissionBroadcast) {
      broadcastList = await db
        .select()
        .from(broadcastWhitelist)
        .where(eq(broadcastWhitelist.spaceId, sp.id))
        .all();
    }

    if (!sp.permissionRead) {
      readList = await db
        .select()
        .from(readWhitelist)
        .where(eq(readWhitelist.spaceId, sp.id))
        .all();
    }

    enrichedSpaces.push({
      ...sp,
      broadcastWhitelist: broadcastList.length
        ? broadcastList.map(r => r.allowedPublicKey)
        : [],
      readWhitelist: readList.length
        ? readList.map(r => r.allowedPublicKey)
        : [],
    });
  }

  return enrichedSpaces;
}

/**
 * List all spaces, optionally filtered by publicKey
 * @param {Object} db - Database instance
 * @param {Object} opts - Optional filters
 * @param {string} opts.publicKey - Filter by space creator's public key
 * @returns {Array} - Array of space objects with whitelists
 */
export async function listSpaces(db, opts = {}) {
  let query = db.select().from(spaces);

  if (opts.publicKey) {
    query = query.where(eq(spaces.publicKey, opts.publicKey));
  }

  const allSpaces = await query.all();

  return Promise.all(
    allSpaces.map(async (space) => {
      let broadcastList = [];
      let readList = [];

      // Only query broadcastWhitelist if permissionBroadcast is restricted
      if (!space.permissionBroadcast) {
        broadcastList = await db.select()
          .from(broadcastWhitelist)
          .where(eq(broadcastWhitelist.spaceId, space.id))
          .all();
      }

      // Only query readWhitelist if permissionRead is restricted
      if (!space.permissionRead) {
        readList = await db.select()
          .from(readWhitelist)
          .where(eq(readWhitelist.spaceId, space.id))
          .all();
      }

      return {
        ...space,
        broadcastWhitelist: broadcastList.length
          ? broadcastList.map(r => r.allowedPublicKey)
          : [],
        readWhitelist: readList.length
          ? readList.map(r => r.allowedPublicKey)
          : [],
      };
    })
  );
}

/**
 * Creates a map for space ID -> topic hash.
 * @param {Object} db - Drizzle database instance.
 * @returns {Map<number, string>}
 */
export async function getSpaceToTopicMap(db) {
  const spaces = await listSpaces(db);
  const spaceTopicMap = new Map();

  for (const space of spaces) {
    const topicHash = getSpaceTopicHash(space);
    spaceTopicMap.set(space.id, topicHash);
  }

  return spaceTopicMap;
}

/**
 * Creates a map for topic hash -> space ID.
 * @param {Object} db - Drizzle database instance.
 * @returns {Map<string, number>}
 */
export async function getTopicToSpaceMap(db) {
  const spaces = await listSpaces(db);
  const topicMap = new Map();

  for (const space of spaces) {
    const topicHash = getSpaceTopicHash(space);
    topicMap.set(topicHash, space.id);
  }

  return topicMap;
}

/**
 * Deletes a space and it's associated whitelist entries.
 * 
 * @param {Object} db - Drizzle database instance
 * @param {Number} spaceId - ID of the space to delete
 * @returns {Promise<void>} - Resolves when the row deletes.
 */
export async function deleteSpace(db, spaceId) {
  const fileRegisteries = await queryFileRegistryRecords(db, { spaceId: spaceId });
  
  for (const registry of fileRegisteries) {
    await deleteFileRecord(db, registry.id);
  }

  await db.delete(broadcastWhitelist)
    .where(eq(broadcastWhitelist.spaceId, spaceId));

  await db.delete(readWhitelist)
    .where(eq(readWhitelist.spaceId, spaceId));

  await db.delete(spaces)
    .where(eq(spaces.id, spaceId));
}