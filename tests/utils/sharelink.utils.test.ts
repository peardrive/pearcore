import { describe, it, expect, beforeEach } from 'vitest';
import {
  encodeShareLink,
  decodeShareLink,
  deleteShareLink,
  queryShareLink,
  saveShareLink,
} from '../../src/utils/sharelink.utils.js';
import { buildTestSpacePayload, createTempDatabase } from '../general.utils.js';
import type { Database } from '../../src/types/database.js';

describe('Share Link Utilities', async () => {
  const mockSpace = await buildTestSpacePayload({
    spaceName: 'space0x1',
  });

  const mockSpace02 = await buildTestSpacePayload({
    spaceName: 'space0x2',
  });

  let db: Database;

  beforeEach(async () => {
    const { db: dbInstance } = await createTempDatabase();
    db = dbInstance;
  });

  describe('createShareLink', () => {
    it('should create a valid share link', () => {
      const result = encodeShareLink(mockSpace, 'pearcore');
      expect(result).toMatch(/^pearcore:\/\//);
    });
  });

  describe('decodeShareLink', () => {
    it('should decode a valid share link', () => {
      const link = encodeShareLink(mockSpace);
      const decoded = decodeShareLink(link);

      expect(decoded).toEqual({
        spaceName: mockSpace.spaceName,
        publicKey: mockSpace.publicKey,
        nonce: mockSpace.nonce,
      });
    });

    it('should return null for invalid protocol', () => {
      const result = decodeShareLink('invalid://data');
      expect(result).toBeNull();
    });

    it('should return null for malformed data', () => {
      const result = decodeShareLink('pearcore://invalidbase58');
      expect(result).toBeNull();
    });

    it('should handle edge cases', () => {
      expect(decodeShareLink('')).toBeNull();
      expect(decodeShareLink('pearcore://')).toBeNull();
    });
  });

  describe('saveSharelink', () => {
    it('should save sharelink and return result', async () => {
      const result = await saveShareLink(db, {
        spaceName: mockSpace.spaceName,
        publicKey: mockSpace.publicKey,
        nonce: mockSpace.nonce,
      });

      expect(result.id).toEqual(1);
      expect(result.spaceName).toEqual(mockSpace.spaceName);
      expect(result.publicKey).toEqual(mockSpace.publicKey);
      expect(result.nonce).toEqual(mockSpace.nonce);
      expect(result.timestamp).toBeDefined();
    });

    it('should throw error if parameters are missing', async () => {
      await expect(
        // @ts-expect-error -- exercise required-field validation at runtime
        saveShareLink(db, {
          spaceName: mockSpace.spaceName,
          // no publicKey and no nonce
        }),
      ).rejects.toThrow();
    });
  });

  describe('queryshareLink', () => {
    it('should return sharelink when no query parameter is provided', async () => {
      const sharelink1 = await saveShareLink(db, {
        spaceName: mockSpace.spaceName,
        publicKey: mockSpace.publicKey,
        nonce: mockSpace.nonce,
      });

      const sharelink2 = await saveShareLink(db, {
        spaceName: mockSpace02.spaceName,
        publicKey: mockSpace02.publicKey,
        nonce: mockSpace02.nonce,
      });

      const queryResult = await queryShareLink(db, {});
      const expectedQueryResult = [sharelink1, sharelink2];

      expect(queryResult.length).toBe(2);
      expect(queryResult).toEqual(expectedQueryResult);
    });

    it('should query sharelink based on spaceName', async () => {
      const sharelink = await saveShareLink(db, {
        spaceName: mockSpace.spaceName,
        publicKey: mockSpace.publicKey,
        nonce: mockSpace.nonce,
      });

      await saveShareLink(db, {
        spaceName: mockSpace02.spaceName,
        publicKey: mockSpace02.publicKey,
        nonce: mockSpace02.nonce,
      });

      const queryResult = await queryShareLink(db, {
        spaceName: mockSpace.spaceName,
      });

      expect(queryResult.length).toBe(1);
      expect(queryResult[0].id).toEqual(sharelink.id);
      expect(queryResult[0].spaceName).toEqual(sharelink.spaceName);
      expect(queryResult[0].publicKey).toEqual(sharelink.publicKey);
      expect(queryResult[0].nonce).toEqual(sharelink.nonce);
    });

    it('should query sharelink based on publicKey', async () => {
      const sharelink = await saveShareLink(db, {
        spaceName: mockSpace.spaceName,
        publicKey: mockSpace.publicKey,
        nonce: mockSpace.nonce,
      });

      await saveShareLink(db, {
        spaceName: mockSpace02.spaceName,
        publicKey: mockSpace02.publicKey,
        nonce: mockSpace02.nonce,
      });

      const queryResult = await queryShareLink(db, {
        publicKey: mockSpace.publicKey,
      });

      expect(queryResult.length).toBe(1);
      expect(queryResult[0].id).toEqual(sharelink.id);
      expect(queryResult[0].spaceName).toEqual(sharelink.spaceName);
      expect(queryResult[0].publicKey).toEqual(sharelink.publicKey);
      expect(queryResult[0].nonce).toEqual(sharelink.nonce);
    });

    it('should query sharelink based on nonce', async () => {
      const sharelink = await saveShareLink(db, {
        spaceName: mockSpace.spaceName,
        publicKey: mockSpace.publicKey,
        nonce: mockSpace.nonce,
      });

      await saveShareLink(db, {
        spaceName: mockSpace02.spaceName,
        publicKey: mockSpace02.publicKey,
        nonce: mockSpace02.nonce,
      });

      const queryResult = await queryShareLink(db, {
        nonce: mockSpace.nonce,
      });

      expect(queryResult.length).toBe(1);
      expect(queryResult[0].id).toEqual(sharelink.id);
      expect(queryResult[0].spaceName).toEqual(sharelink.spaceName);
      expect(queryResult[0].publicKey).toEqual(sharelink.publicKey);
      expect(queryResult[0].nonce).toEqual(sharelink.nonce);
    });
  });

  describe('deleteSharelink', () => {
    it('should delete sharelink', async () => {
      const sharelink = await saveShareLink(db, {
        spaceName: mockSpace.spaceName,
        publicKey: mockSpace.publicKey,
        nonce: mockSpace.nonce,
      });

      await deleteShareLink(db, sharelink.id);

      const queryResult = await queryShareLink(db, {
        spaceName: mockSpace.spaceName,
        publicKey: mockSpace.publicKey,
        nonce: mockSpace.nonce,
      });

      expect(queryResult.length).toBe(0);
    });

    it('should throw error if sharelink record does not exists', async () => {
      await expect(deleteShareLink(db, 1)).rejects.toThrow(
        /Sharelink with id 1 not found/,
      );
    });
  });
});
