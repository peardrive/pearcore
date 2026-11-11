import { and, eq, gte, lte, like, asc, desc } from 'drizzle-orm';
import { userProfiles } from '../database/schemas/profile.schema.js';
import {
  verifySignedJSON,
  hexToUint8,
  signJSON,
} from '../utils/crypto.utils.js';
import {
  isTimestampNewer,
  isValidURL,
  now,
  stripIds,
  validateHexString,
  validateTimestamp,
} from '../utils/general.utils.js';
import type { SQL } from 'drizzle-orm';
import type { Database } from '../types/database.js';

/** A user_profiles row. */
export type ProfileRecord = typeof userProfiles.$inferSelect;

/** The fields covered by a profile signature. */
export interface ProfilePayload {
  username: string;
  tag: string;
  profileURL?: string | null;
  publicKey: string;
  timestamp: number;
}

export type SignedProfile = ProfilePayload & { signature: string };

/** Editable profile fields, as accepted by the create/update helpers. */
export type ProfileInput = Partial<
  Pick<ProfilePayload, 'username' | 'tag' | 'profileURL'>
> & { publicKey?: string };

export interface ProfileFilters {
  username?: string;
  tag?: string;
  profileURL?: string;
  publicKey?: string;
  signature?: string;
  timestampRange?: { start?: number; end?: number };
  orderBy?: 'id' | 'username' | 'tag' | 'timestamp' | (string & {});
  orderDirection?: 'asc' | 'desc' | (string & {});
  limit?: number;
  offset?: number;
}

type ValidationRule = [reason: string, condition: () => boolean];

/**
 * Build the canonical payload object that should be signed/verified.
 *
 * Ensures the same field names/structure used for signing.
 *
 * @returns payload to sign/verify
 */
export function buildProfilePayload(input: ProfilePayload): ProfilePayload {
  return {
    username: input.username,
    tag: input.tag,
    profileURL: input.profileURL,
    publicKey: input.publicKey,
    timestamp: input.timestamp,
  };
}

/**
 *
 * @param publicKey - 64 character hex string for publicKey
 * @returns - Returns Object with pre-loaded profile parameters
 */
export function createPreloadedProfile(publicKey: string): ProfilePayload {
  return buildProfilePayload({
    username: 'unkown',
    tag: 'no_tag',
    profileURL: null,
    publicKey: publicKey,
    timestamp: now(),
  });
}

/**
 * Validates the structure of profile object to ensure it meets all required criteria.
 * @param profile - the profile object for validation
 * @returns An object indicating whether validation passed and the reason for failure if it did not.
 *         If `isValid` is true, then `reason` will be `'profile is valid'`.
 *         Otherwise, `reason` describes which field failed validation.
 */
export function validateProfileContext(input: unknown): {
  isValid: boolean;
  reason: string;
} {
  const profile = input as Record<keyof SignedProfile, any>;
  const notNull = (obj: unknown): boolean => obj !== null;
  const notUndefined = (obj: unknown): boolean => obj !== undefined;
  const isDefined = (obj: unknown): boolean =>
    notNull(obj) && notUndefined(obj);

  const validationRules: ValidationRule[] = [
    ['username is required', () => isDefined(profile.username)],
    ['tag is required', () => isDefined(profile.tag)],
    ['profileURL is required', () => notUndefined(profile.profileURL)],
    ['publicKey is required', () => isDefined(profile.publicKey)],
    ['signature is required', () => isDefined(profile.signature)],
    ['timestamp is required', () => isDefined(profile.timestamp)],

    ['username should be string', () => typeof profile.username === 'string'],
    [
      'username should not a larger that 64 characters',
      () => profile.username.length <= 64,
    ],

    ['tag should be string', () => typeof profile.tag === 'string'],
    [
      'tag should not a larger that 64 characters',
      () => profile.tag.length <= 64,
    ],

    [
      'profileURL should be a string or null',
      () =>
        typeof profile.profileURL === 'string' || !notNull(profile.profileURL),
    ],
    [
      'profileURL should be a valid URL if not null',
      () =>
        notNull(profile.profileURL) ? isValidURL(profile.profileURL) : true,
    ],
    [
      'profileURL is too long (as string)',
      () =>
        notNull(profile.profileURL) ? profile.profileURL.length <= 2048 : true,
    ],

    [
      'signature should be a string',
      () => typeof profile.signature === 'string',
    ],
    [
      'signature should be 128 characters long',
      () => profile.signature.length === 128,
    ],
    [
      'signature should be a valid hex string',
      () => validateHexString(profile.signature),
    ],

    [
      'timestamp should be a valid date',
      () => validateTimestamp(profile.timestamp),
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
    reason: 'profile is valid',
  };
}

/**
 * Verify a profile payload with a hex signature and hex publicKey.
 *
 * @param profile - the profile fields plus their hex signature
 * @returns true if signature valid
 */
export async function verifyProfileSignature(
  profile: Partial<SignedProfile>,
): Promise<boolean> {
  if (!profile.publicKey) return false;
  if (!profile.signature) return false;
  if (!validateHexString(profile.publicKey)) return false;
  if (!validateHexString(profile.signature)) return false;

  const signatureHex = profile.signature;
  const publicKeyBytes = hexToUint8(profile.publicKey);

  const payload = buildProfilePayload(profile as SignedProfile);
  const signatureIsOK = await verifySignedJSON(
    payload,
    signatureHex,
    publicKeyBytes,
  );

  return signatureIsOK;
}

/**
 * Create database filter conditions for user profile queries.
 * Handles all user profile field filters including timestamp ranges and text field searches.
 *
 * @param filters - query filters (all optional)
 * @param filters.username - exact username match
 * @param filters.tag - exact tag match
 * @param filters.profileURL - exact profile URL match
 * @param filters.publicKey - exact public key match
 * @param filters.signature - exact signature match
 * @param filters.timestampRange - timestamp range filter
 * @param filters.timestampRange.start - start timestamp (inclusive)
 * @param filters.timestampRange.end - end timestamp (inclusive)
 * @returns array of SQL conditions for use with drizzle-orm's and() function
 */
export function createProfileFilter(filters: ProfileFilters = {}): SQL[] {
  const conditions: SQL[] = [];

  if (filters.username) {
    conditions.push(eq(userProfiles.username, filters.username));
  }

  if (filters.tag) {
    conditions.push(eq(userProfiles.tag, filters.tag));
  }

  if (filters.profileURL) {
    conditions.push(eq(userProfiles.profileURL, filters.profileURL));
  }

  if (filters.publicKey) {
    conditions.push(eq(userProfiles.publicKey, filters.publicKey));
  }

  if (filters.timestampRange) {
    const { start, end } = filters.timestampRange;
    if (start !== undefined) {
      conditions.push(gte(userProfiles.timestamp, start));
    }
    if (end !== undefined) {
      conditions.push(lte(userProfiles.timestamp, end));
    }
  }

  return conditions;
}

/**
 * Get order expression for user profile queries.
 *
 * @param filters - query filters
 * @param filters.orderBy - field to order by: 'id', 'username', 'tag', 'timestamp'
 * @param filters.orderDirection - 'asc' for ascending, 'desc' for descending
 * @returns drizzle-orm order expression
 * @throws {Error} if orderBy value is invalid
 */
function getProfileOrderExpression(
  filters: Pick<ProfileFilters, 'orderBy' | 'orderDirection'> = {},
): SQL {
  // Whitelist and map allowed orderBy keys to actual column objects
  const orderByMap = {
    id: userProfiles.id,
    username: userProfiles.username,
    tag: userProfiles.tag,
    timestamp: userProfiles.timestamp,
  };

  const orderByKey =
    typeof filters.orderBy === 'string' ? filters.orderBy : 'timestamp';
  const orderByField = orderByMap[orderByKey as keyof typeof orderByMap];

  if (!orderByField) {
    throw new Error(
      `Invalid orderBy value: ${String(filters.orderBy)}. Allowed: ${Object.keys(orderByMap).join(', ')}`,
    );
  }

  // Canonicalize orderDirection
  const orderDir =
    typeof filters.orderDirection === 'string' &&
    filters.orderDirection.toLowerCase() === 'asc'
      ? 'asc'
      : 'desc';

  return orderDir === 'asc' ? asc(orderByField) : desc(orderByField);
}

/**
 * Get pagination limits for user profile queries.
 *
 * @param filters - query filters
 * @param filters.limit - maximum records to return
 * @param filters.offset - records to skip
 * @returns object with limit and offset properties
 */
function getPaginationLimits(
  filters: Pick<ProfileFilters, 'limit' | 'offset'> = {},
): { limit: number; offset: number } {
  const limit = Math.min(
    typeof filters.limit === 'number' && filters.limit > 0 ? filters.limit : 50,
    500, // Maximum limit to prevent excessive queries
  );
  const offset =
    typeof filters.offset === 'number' && filters.offset >= 0
      ? filters.offset
      : 0;

  return { limit, offset };
}

/**
 * Query user profile records with filtering, ordering, and pagination.
 *
 * @param db - Drizzle database instance
 * @param filters - query filters (see createProfileFilter for details)
 * @returns array of user profile records
 */
export async function queryProfileRecord(
  db: Database,
  filters: ProfileFilters = {},
): Promise<ProfileRecord[]> {
  // build filters and ordering
  const conditions = createProfileFilter(filters);
  const orderExpr = getProfileOrderExpression(filters);
  const { limit, offset } = getPaginationLimits(filters);

  // setup dribble query (no conditions → no WHERE clause)
  const query = db
    .select()
    .from(userProfiles)
    .where(conditions.length > 0 ? and(...conditions) : undefined);

  // finally query profiles
  const results = await query
    .orderBy(orderExpr)
    .limit(limit)
    .offset(offset)
    .all();

  return results;
}

/**
 * Get a single user profile by public key.
 * Convenience wrapper around queryProfileRecord.
 *
 * @param db - Drizzle database instance
 * @param publicKey - public key to search for
 * @returns user profile or null if not found
 */
export async function getProfileByPublicKey(
  db: Database,
  publicKey: string,
): Promise<ProfileRecord | null> {
  const results = await queryProfileRecord(db, {
    publicKey,
    limit: 1,
  });

  return results[0] || null;
}

/**
 * Create a new user profile.
 * Note: profile should not already exist.
 * @param db - Drizzle DB instance
 * @param input - profile input
 * @param secretKey - Ed25519 secret key
 * @param [timestamp] - unix epoch seconds (defaults to now)
 *
 * @returns created profile row
 *
 * @throws {Error} if profile already exists
 * @throws {Error} if required fields are missing
 */
export async function createProfile(
  db: Database,
  input: SignedProfile,
): Promise<ProfileRecord> {
  const inserted = await db
    .insert(userProfiles)
    .values({
      username: input.username,
      tag: input.tag,
      profileURL: input.profileURL,
      publicKey: input.publicKey,
      timestamp: input.timestamp,
      signature: input.signature,
    })
    .returning({
      id: userProfiles.id,
      username: userProfiles.username,
      tag: userProfiles.tag,
      profileURL: userProfiles.profileURL,
      publicKey: userProfiles.publicKey,
      signature: userProfiles.signature,
      timestamp: userProfiles.timestamp,
    });

  return inserted[0];
}

/**
 * Get a single profile by ID.
 * @param db - Database instance
 * @param profileID - The ID of the profile
 * @returns Resolves when profile has been getched from database.
 */
export async function getProfile(
  db: Database,
  profileId: number,
): Promise<ProfileRecord | null> {
  const profile = await db
    .select()
    .from(userProfiles)
    .where(eq(userProfiles.id, profileId))
    .get();

  if (!profile) return null;
  return profile;
}

/**
 * Update an existing profile.
 * @param db - Drizzle DB instance
 * @param profileId - ID of the profile to update
 *
 * TODO: profileURL is not written here, so profile URL changes are dropped
 * (the signature still covers the new URL). Left as-is during the migration.
 */
export async function updateProfile(
  db: Database,
  profileId: number,
  input: SignedProfile,
): Promise<{ profileId: number }> {
  await db
    .update(userProfiles)
    .set({
      username: input.username,
      tag: input.tag,
      publicKey: input.publicKey,
      timestamp: input.timestamp,
      signature: input.signature,
    })
    .where(eq(userProfiles.id, profileId));

  return { profileId };
}

/**
 * Upsert (verify then insert/update) a user profile identified by publicKey.
 *
 * All DB modifications are performed inside a transaction to avoid races.
 *
 * @param db - Drizzle DB instance (supports db.transaction)
 * @param input - profile input
 * @returns final profile row (inserted/updated/existing)
 */
export async function upsertVerifiedUserProfile(
  db: Database,
  input: SignedProfile,
): Promise<ProfileRecord> {
  const payload = buildProfilePayload(input);
  const signature = input.signature;

  if (!validateProfileContext({ ...payload, signature }).isValid) {
    throw new Error('Profile payload is missing required fields');
  }

  const isValid = await verifyProfileSignature({ ...payload, signature });
  if (!isValid) {
    throw new Error('Invalid signature for user profile payload');
  }

  const existing = await getProfileByPublicKey(db, payload.publicKey);
  return db.transaction((tx) => {
    if (!existing) {
      return tx
        .insert(userProfiles)
        .values({
          username: payload.username,
          tag: payload.tag,
          profileURL: payload.profileURL ?? null,
          publicKey: payload.publicKey,
          signature: input.signature,
          timestamp: payload.timestamp,
        })
        .returning({
          id: userProfiles.id,
          username: userProfiles.username,
          tag: userProfiles.tag,
          profileURL: userProfiles.profileURL,
          publicKey: userProfiles.publicKey,
          signature: userProfiles.signature,
          timestamp: userProfiles.timestamp,
        })
        .get();
    }

    // EXISTING but timestamp not newer → no-op
    if (!isTimestampNewer(payload.timestamp, existing.timestamp)) {
      return existing;
    }

    // UPDATE if newer
    return tx
      .update(userProfiles)
      .set({
        username: payload.username,
        tag: payload.tag,
        profileURL: payload.profileURL ?? null,
        timestamp: payload.timestamp,
        signature,
      })
      .where(eq(userProfiles.publicKey, payload.publicKey))
      .returning({
        id: userProfiles.id,
        username: userProfiles.username,
        tag: userProfiles.tag,
        profileURL: userProfiles.profileURL,
        publicKey: userProfiles.publicKey,
        signature: userProfiles.signature,
        timestamp: userProfiles.timestamp,
      })
      .get();
  });
}

/**
 * Create a profile given keypair credentials.
 *
 * @param db - Drizzle DB instance
 * @param input - profile input (username, tag, profileURL, publicKey)
 * @param secretKey - Ed25519 secret key
 * @param [timestamp] - unix epoch seconds (defaults to now)
 * @returns final profile row
 */
export async function createProfileForPublicKey(
  db: Database,
  input: Omit<ProfilePayload, 'timestamp'>,
  secretKey: Uint8Array,
): Promise<ProfileRecord> {
  const profilePayload = buildProfilePayload({
    ...input,
    timestamp: now(),
  });

  const signature = await signJSON(profilePayload, secretKey);
  return createProfile(db, { ...profilePayload, signature });
}

/**
 * Update a profile given keypair credentials.
 *
 * @param db - Drizzle DB instance
 * @param input - profile input (username, tag, profileURL, publicKey)
 * @param secretKey - Ed25519 secret key
 * @param [timestamp] - unix epoch seconds (defaults to now)
 * @returns final profile row
 */
export async function updateProfileForPublicKey(
  db: Database,
  profileId: number,
  input: ProfileInput,
  secretKey: Uint8Array,
): Promise<{ profileId: number }> {
  const profile = await getProfile(db, profileId);
  if (!profile) throw new Error('Profile not found');

  const profilePayload = buildProfilePayload({
    ...profile,
    ...input,
    timestamp: now(),
  });

  const signature = await signJSON(profilePayload, secretKey);
  return updateProfile(db, profileId, { ...profilePayload, signature });
}
