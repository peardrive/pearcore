import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { userProfiles } from '../../src/database/schemas/profile.schema.js';
import {
  generateKeypair,
  createTempDatabase,
  buildTestProfilePayload,
} from '../general.utils.js';
import { now } from '../../src/utils/general.utils.js';
import { hex } from '../../src/utils/crypto.utils.js';
import {
  validateProfileContext,
  verifyProfileSignature,
  createProfile,
  getProfile,
  getProfileByPublicKey,
  queryProfileRecord,
  createProfileForPublicKey,
  updateProfileForPublicKey,
} from '../../src/utils/profile.utils.js';
import type { Database } from '../../src/types/database.js';

describe('Profile operations', () => {
  let db: Database;

  beforeEach(async () => {
    const { db: dbInstance } = await createTempDatabase();
    db = dbInstance;
  });

  describe('validateProfileContext', () => {
    const healthyProfile = {
      username: 'My Profile',
      tag: '@pancake',
      publicKey: 'a'.repeat(64),
      profileURL: 'https://example.com',
      timestamp: now(),
      signature: 'b'.repeat(128),
    };

    it('should validate valid profile object', () => {
      const result = validateProfileContext(healthyProfile);
      expect(result.isValid).toBe(true);
      expect(result.reason).toBe('profile is valid');
    });

    it('should reject missing parameters', () => {
      const testCases = [
        { field: 'username', value: undefined, reason: 'username is required' },
        { field: 'tag', value: undefined, reason: 'tag is required' },
        {
          field: 'profileURL',
          value: undefined,
          reason: 'profileURL is required',
        },
        {
          field: 'publicKey',
          value: undefined,
          reason: 'publicKey is required',
        },
        {
          field: 'signature',
          value: undefined,
          reason: 'signature is required',
        },
        {
          field: 'timestamp',
          value: undefined,
          reason: 'timestamp is required',
        },
      ];

      testCases.forEach(({ field, value, reason }) => {
        const invalidProfile = { ...healthyProfile, [field]: value };
        const result = validateProfileContext(invalidProfile);
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe(reason);
      });
    });

    it('should reject invalid username', () => {
      const testCases = [
        { field: 'username', value: 123, reason: 'username should be string' },
        {
          field: 'username',
          value: 'a'.repeat(65),
          reason: 'username should not a larger that 64 characters',
        },
      ];

      testCases.forEach(({ field, value, reason }) => {
        const invalidProfile = { ...healthyProfile, [field]: value };
        const result = validateProfileContext(invalidProfile);
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe(reason);
      });
    });

    it('should reject invalid tag', () => {
      const testCases = [
        { field: 'tag', value: 123, reason: 'tag should be string' },
        {
          field: 'tag',
          value: 'a'.repeat(65),
          reason: 'tag should not a larger that 64 characters',
        },
      ];

      testCases.forEach(({ field, value, reason }) => {
        const invalidProfile = { ...healthyProfile, [field]: value };
        const result = validateProfileContext(invalidProfile);
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe(reason);
      });
    });

    it('should reject invalid profileURL', () => {
      const testCases = [
        {
          field: 'profileURL',
          value: 123,
          reason: 'profileURL should be a string or null',
        },
        {
          field: 'profileURL',
          value: 'not-a-url',
          reason: 'profileURL should be a valid URL if not null',
        },
        {
          field: 'profileURL',
          value: 'http://'.repeat(500),
          reason: 'profileURL is too long (as string)',
        },
      ];

      testCases.forEach(({ field, value, reason }) => {
        const invalidProfile = { ...healthyProfile, [field]: value };
        const result = validateProfileContext(invalidProfile);
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe(reason);
      });
    });

    it('should reject invalid signature', () => {
      const testCases = [
        {
          field: 'signature',
          value: 123,
          reason: 'signature should be a string',
        },
        {
          field: 'signature',
          value: '',
          reason: 'signature should be 128 characters long',
        },
        {
          field: 'signature',
          value: 'a'.repeat(127),
          reason: 'signature should be 128 characters long',
        },
        {
          field: 'signature',
          value: 'x'.repeat(128),
          reason: 'signature should be a valid hex string',
        },
      ];

      testCases.forEach(({ field, value, reason }) => {
        const invalidProfile = { ...healthyProfile, [field]: value };
        const result = validateProfileContext(invalidProfile);
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe(reason);
      });
    });

    it('should reject invalid timestamp', () => {
      const testCases = [
        {
          field: 'timestamp',
          value: 'invalid-date',
          reason: 'timestamp should be a valid date',
        },
        {
          field: 'timestamp',
          value: NaN,
          reason: 'timestamp should be a valid date',
        },
      ];

      testCases.forEach(({ field, value, reason }) => {
        const invalidProfile = { ...healthyProfile, [field]: value };
        const result = validateProfileContext(invalidProfile);
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe(reason);
      });
    });

    it('should reject invalid publicKey', () => {
      const testCases = [
        { field: 'publicKey', value: null, reason: 'publicKey is required' },
        {
          field: 'publicKey',
          value: undefined,
          reason: 'publicKey is required',
        },
      ];

      testCases.forEach(({ field, value, reason }) => {
        const invalidProfile = { ...healthyProfile, [field]: value };
        const result = validateProfileContext(invalidProfile);
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe(reason);
      });
    });
  });

  describe('verifyProfileSignature', () => {
    it('should verify the signature of a valid profile', async () => {
      const profile = await buildTestProfilePayload();
      const isValid = await verifyProfileSignature(profile);

      expect(isValid).toBe(true);
    });
  });

  describe('createProfile', () => {
    it('should create a new profile successfully', async () => {
      const input = await buildTestProfilePayload();
      const profile = await createProfile(db, input);

      expect(profile).toHaveProperty('id');
      expect(profile.username).toBe(input.username);
      expect(profile.tag).toBe(input.tag);
      expect(profile.profileURL).toBe(input.profileURL);
      expect(profile.publicKey).toBe(input.publicKey);
      expect(profile.signature).toBe(input.signature);
      expect(profile.timestamp).toBe(input.timestamp);

      const [dbRow] = await db
        .select()
        .from(userProfiles)
        .where(eq(userProfiles.id, profile.id));
      expect(dbRow).not.toBeUndefined();
      expect(dbRow.publicKey).toBe(input.publicKey);
    });
  });

  describe('getProfile', () => {
    it('should fetch stored profile successfully', async () => {
      const input = await buildTestProfilePayload();
      const profile = await createProfile(db, input);

      const fetchResponse = await getProfile(db, profile.id);
      expect(fetchResponse).toEqual(profile);
    });
  });

  describe('queryProfileRecord', () => {
    it('should filter by exact fields and timestamp range', async () => {
      const nowTs = now();
      const profileOne = await buildTestProfilePayload({
        username: 'alice',
        tag: '@alice',
        profileURL: 'https://example.com',
        publicKey: 'a'.repeat(64),
        timestamp: nowTs,
      });

      const profileTwo = await buildTestProfilePayload({
        username: 'bob',
        tag: '@bob',
        profileURL: 'https://example.com',
        publicKey: 'b'.repeat(64),
        timestamp: nowTs + 100,
      });

      await createProfile(db, profileOne);
      await createProfile(db, profileTwo);

      const results = await queryProfileRecord(db, {
        username: 'alice',
        tag: '@alice',
        profileURL: 'https://example.com',
        publicKey: 'a'.repeat(64),
        timestampRange: {
          start: nowTs - 10,
          end: nowTs + 10,
        },
      });

      expect(results.length).toBe(1);
      expect(results[0].username).toBe('alice');
      expect(results[0].tag).toBe('@alice');
      expect(results[0].profileURL).toBe('https://example.com');
      expect(results[0].publicKey).toBe('a'.repeat(64));
    });

    it('should apply ordering asc and desc correctly', async () => {
      const baseTs = now();
      const profileOne = await buildTestProfilePayload({
        username: 'alice',
        tag: '@alice',
        timestamp: baseTs,
      });
      const profileTwo = await buildTestProfilePayload({
        username: 'bob',
        tag: '@bob',
        timestamp: baseTs + 10,
      });

      await createProfile(db, profileOne);
      await createProfile(db, profileTwo);

      const ascResults = await queryProfileRecord(db, {
        orderBy: 'timestamp',
        orderDirection: 'asc',
      });

      const descResults = await queryProfileRecord(db, {
        orderBy: 'timestamp',
        orderDirection: 'desc',
      });

      expect(ascResults[0].timestamp).toBeLessThanOrEqual(
        ascResults[1].timestamp,
      );
      expect(descResults[0].timestamp).toBeGreaterThanOrEqual(
        descResults[1].timestamp,
      );
    });

    it('should apply pagination with limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        const profile = await buildTestProfilePayload({
          username: `p${i}`,
          tag: `@p${i}`,
          timestamp: i,
        });

        await createProfile(db, profile);
      }

      const results = await queryProfileRecord(db, {
        orderBy: 'timestamp',
        orderDirection: 'asc',
        limit: 2,
        offset: 1,
      });

      expect(results.length).toBe(2);
      expect(results[0].timestamp).toBe(1);
    });

    it('should enforce default and max limit cap', async () => {
      for (let i = 0; i < 60; i++) {
        const profile = await buildTestProfilePayload({
          username: `bulk${i}`,
          tag: `@bulk${i}`,
          timestamp: i,
        });

        await createProfile(db, profile);
      }

      const defaultResults = await queryProfileRecord(db);
      const cappedResults = await queryProfileRecord(db, {
        limit: 1000,
      });

      expect(defaultResults.length).toBeLessThanOrEqual(50);
      expect(cappedResults.length).toBeLessThanOrEqual(500);
    });

    it('should throw error for invalid orderBy value', async () => {
      await expect(
        queryProfileRecord(db, {
          orderBy: 'invalid_field',
        }),
      ).rejects.toThrow('Invalid orderBy value');
    });
  });

  describe('getProfileByPublicKey', () => {
    it('should return matching profile by publicKey', async () => {
      const profileOne = await buildTestProfilePayload({
        username: 'alice',
        tag: '@alice',
      });
      const profileTwo = await buildTestProfilePayload({
        username: 'bob',
        tag: '@bob',
      });

      const target = await createProfile(db, profileOne);
      await createProfile(db, profileTwo);

      const result = await getProfileByPublicKey(db, profileOne.publicKey);

      expect(result).not.toBeNull();
      expect(result!.publicKey).toBe(target.publicKey);
      expect(result!.username).toBe('alice');
    });

    it('should return null when no profile exists for publicKey', async () => {
      const result = await getProfileByPublicKey(db, 'non-existent-key');
      expect(result).toBeNull();
    });
  });

  describe('createProfileForPublicKey', () => {
    it('should create profile and sign with keypair', async () => {
      const { publicKey, secretKey } = await generateKeypair();
      const input = await buildTestProfilePayload({
        username: 'alice',
        publicKey: hex(publicKey),
        secretKey: secretKey,
      });

      const { signature, ...noSignaturePayload } = input;
      const profile = await createProfileForPublicKey(
        db,
        noSignaturePayload,
        secretKey,
      );

      const valid = await verifyProfileSignature(profile);
      expect(valid).toBe(true);
    });
  });

  describe('updateProfileForPublicKey', async () => {
    it('should maintain profile signature valid after update', async () => {
      const { publicKey, secretKey } = await generateKeypair();
      const input = await buildTestProfilePayload({
        username: 'alice',
        publicKey: hex(publicKey),
        secretKey: secretKey,
      });

      const originalProfile = await createProfile(db, input);
      await updateProfileForPublicKey(
        db,
        originalProfile.id,
        { username: 'bob' },
        secretKey,
      );

      const updatedProfile = await getProfile(db, originalProfile.id);
      const valid = await verifyProfileSignature(updatedProfile!);
      expect(valid).toBe(true);
    });
  });
});
