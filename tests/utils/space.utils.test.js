import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { hex, signJSON } from "../../src/utils/crypto.utils.js";
import { spaces, broadcastWhitelist, readWhitelist } from "../../src/database/schemas/space.schema.js"
import { generateKeypair, createTempDatabase, buildTestSpacePayload, createSandbox, makeTempDir, generateRandomFile, cleanup } from "../general.utils.js"
import { now } from "../../src/utils/general.utils.js";
import {
  generateSpaceTopic,
  getSpaceTopicHash,
  validateSpaceContext,
  verifySpaceSignature,
  createSpace,
  getSpace,
  updateSpace,
  createSpaceForPublicKey,
  upsertSpace,
  buildSpacePayload,
  updateSpaceForPublicKey,
  querySpace,
  listSpaces,
  deleteSpace
} from "../../src/utils/space.utils.js";
import { createFileIndexRecord, generateFileTreeRecord } from "../../src/utils/files.utils.js";
import path from "path";


const generateValidHex = (length) => {
  return Array.from({ length }, () => Math.floor(Math.random() * 16).toString(16)).join('');
};

const generateValidPublicKey = () => generateValidHex(64);
const generateValidSignature = () => generateValidHex(128);
const generateValidNonce = () => generateValidHex(24);

describe("Space operations", () => {
  let db;
  let testSpace;

  beforeEach(async () => {
    const { db: dbInstance } = await createTempDatabase();
    db = dbInstance;
    testSpace = await buildTestSpacePayload();
  })

  describe("generateSpaceTopic", () => {
    it("should generate topic string with given inputs", () => {
      const topic = generateSpaceTopic("mySpace", "abc123", 42);
      expect(topic).toBe("mySpace___abc123___42");
    });

    it("should throw if spaceName is missing", () => {
      expect(() => generateSpaceTopic(null, "pub", 1)).toThrow(
        "spaceName, publicKey, and nonce are required"
      );
    });

    it("should throw if publicKey is missing", () => {
      expect(() => generateSpaceTopic("name", null, 1)).toThrow(
        "spaceName, publicKey, and nonce are required"
      );
    });

    it("should throw if nonce is missing", () => {
      expect(() => generateSpaceTopic("name", "pub", null)).toThrow(
        "spaceName, publicKey, and nonce are required"
      );
    });

    it("should handle nonce as string", () => {
      const topic = generateSpaceTopic("test", "key", "123");
      expect(topic).toBe("test___key___123");
    });
  });

  describe("getSpaceTopicHash", () => {
    it("should generate space topic hash", () => {
      const mockSpace = {
        spaceName: "TestSpace",
        publicKey: "pubKeyHex",
        nonce: 99,
      };

      const result = getSpaceTopicHash(mockSpace);
      expect(typeof result).toBe("string");
      expect(result).toMatch(/^[0-9a-f]+$/);
      expect(result.length).toBe(64);
    });

    it("should propagate errors from generateSpaceTopic", () => {
      const invalidSpace = { spaceName: "onlyName" }; // missing publicKey
      expect(() => getSpaceTopicHash(invalidSpace)).toThrow(
        "spaceName, publicKey, and nonce are required"
      );
    });
  });

  describe('validateSpaceContext', () => {

    const healthySpace = {
      spaceName: 'test-space',
      publicKey: generateValidPublicKey(),
      timestamp: now(),
      signature: generateValidSignature(),
      nonce: generateValidNonce(),
      permissionBroadcast: 1,
      broadcastWhitelist: [generateValidPublicKey()],
      permissionRead: 0,
      readWhitelist: [generateValidPublicKey()],
      secret: null
    };

    it('should validate valid space object', () => {
      const result = validateSpaceContext(healthySpace);
      expect(result.isValid).toBe(true);
    });

    it('should reject missing parameters', () => {
      const testCases = [
        { field: 'spaceName', value: undefined, reason: 'spaceName is required' },
        { field: 'publicKey', value: undefined, reason: 'publicKey is required' },
        { field: 'timestamp', value: undefined, reason: 'timestamp is required' },
        { field: 'signature', value: undefined, reason: 'signature is required' },
        { field: 'nonce', value: undefined, reason: 'nonce is required' },
        { field: 'secret', value: undefined, reason: 'secret should be either null or 64 character hex string' },
        { field: 'permissionBroadcast', value: undefined, reason: 'permissionBroadcast is required' },
        { field: 'permissionRead', value: undefined, reason: 'permissionRead is required' },
        { field: 'broadcastWhitelist', value: undefined, reason: 'broadcastWhitelist is required' },
        { field: 'readWhitelist', value: undefined, reason: 'readWhitelist is required' }
      ];

      testCases.forEach(({ field, value, reason }) => {
        const invalidSpace = { ...healthySpace, [field]: value };
        const result = validateSpaceContext(invalidSpace);
        expect(result.isValid).toBe(false);
        expect(result.reason).toBe(reason);
      });
    });

    it('should reject spaceName longer that 64 characters');
    it('should reject invalid publicKey');
    it('should reject invalid signature');
    it('should reject invalid nonce');
    it('should reject invalid secret');
    it('should reject invalid timestamp');
    it('should reject invalid broadcast parameters');
    it('should reject invalid read parameters');
  })

  describe('createSpace', () => {
    it('should insert space and whitelist entries', async () => {
      const { spaceId } = await createSpace(db, testSpace);

      const insertedSpace = await db.select().from(spaces).where(eq(spaces.id, spaceId));
      expect(insertedSpace.length).toBe(1);
      expect(insertedSpace[0].spaceName).toBe(testSpace.spaceName);
      expect(insertedSpace[0].publicKey).toBe(testSpace.publicKey);
      expect(insertedSpace[0].permissionBroadcast).toBe(Number(testSpace.permissionBroadcast));
      expect(insertedSpace[0].permissionRead).toBe(Number(testSpace.permissionRead));

      const broadcastRows = await db.select().from(broadcastWhitelist).where(eq(broadcastWhitelist.spaceId, spaceId));
      expect(broadcastRows.length).toBe(1);
      expect(broadcastRows.map(r => r.allowedPublicKey)).toEqual([testSpace.publicKey]);

      const readRows = await db.select().from(readWhitelist).where(eq(readWhitelist.spaceId, spaceId));
      expect(readRows.length).toBe(1);
      expect(readRows[0].allowedPublicKey).toBe(testSpace.publicKey);
    })
  })

  describe('getSpace', () => {
    it('should return space and whitelists', async () => {
      const { spaceId } = await createSpace(db, testSpace);
      const result = await getSpace(db, spaceId);

      expect(result).not.toBeNull();
      expect(result.spaceName).toBe(testSpace.spaceName);
      expect(result.publicKey).toBe(testSpace.publicKey);
      expect(result.broadcastWhitelist).toEqual([testSpace.publicKey]);
      expect(result.readWhitelist).toEqual([testSpace.publicKey]);
    })

    it('should return null when space does not exist', async () => {
      const result = await getSpace(db, 999999);
      expect(result).toBeNull();
    })
  })

  describe('updateSpace', () => {
    it('should modify space fields and replaces whitelists', async () => {
      const { spaceId } = await createSpace(db, testSpace);

      const randomPublibKeyOne = 'a'.repeat(64);
      const randomPublicKeyTwo = 'b'.repeat(64);

      const updateInput = {
        permissionBroadcast: 0,
        broadcastWhitelist: [randomPublibKeyOne, randomPublicKeyTwo],
        permissionRead: 0,
        readWhitelist: [randomPublibKeyOne, randomPublicKeyTwo],
      };

      await updateSpace(db, spaceId, updateInput);

      const updatedSpace = await getSpace(db, spaceId);
      expect(updatedSpace.id).toBe(spaceId);
      expect(updatedSpace.spaceName).toBe(testSpace.spaceName);
      expect(updatedSpace.permissionBroadcast).toBe(0);
      expect(updatedSpace.permissionRead).toBe(0);
      expect(updatedSpace.broadcastWhitelist).toEqual([randomPublibKeyOne, randomPublicKeyTwo]);
      expect(updatedSpace.readWhitelist).toEqual([randomPublibKeyOne, randomPublicKeyTwo]);
    })
  })

  describe('verifySpaceSignature', () => {
    it('should verify the signature of a created space', async () => {
      const { publicKey, secretKey } = await generateKeypair();
      const space = { ...testSpace, publicKey: hex(publicKey) };

      const { spaceId } = await createSpaceForPublicKey(db, space, hex(secretKey))

      const storedSpace = await getSpace(db, spaceId);
      const isValid = await verifySpaceSignature(storedSpace);
      expect(isValid).toBe(true);
    })
  })

  describe('upsertSpace', () => {
    it('should create space if not exists with valid signature', async () => {
      // pass valid publickey for signature verification
      const { publicKey, secretKey } = await generateKeypair();
      const space = buildSpacePayload({ ...testSpace, publicKey: hex(publicKey) });
      const signature = await signJSON(space, hex(secretKey));
      const spaceWithSignature = { ...space, signature: signature };

      const { spaceId } = await upsertSpace(db, spaceWithSignature);
      const storedSpace = await getSpace(db, spaceId);
      const isValid = await verifySpaceSignature(storedSpace);

      expect(storedSpace).toBeDefined();
      expect(buildSpacePayload(storedSpace)).toEqual(space);
      expect(isValid).toBe(true);
    })

    it('should update existing space and keeps signature valid', async () => {
      const { publicKey, secretKey } = await generateKeypair();
      const primarySpace = buildSpacePayload({ ...testSpace, publicKey: hex(publicKey) });
      const primarySignature = await signJSON(primarySpace, hex(secretKey));

      const { spaceId } = await upsertSpace(db, { ...primarySpace, signature: primarySignature });

      const randomPublibKeyOne = 'a'.repeat(64);
      const randomPublicKeyTwo = 'b'.repeat(64);

      // updated parameters
      const updateInput = {
        permissionBroadcast: 0,
        broadcastWhitelist: [randomPublibKeyOne, randomPublicKeyTwo],
        permissionRead: 0,
        readWhitelist: [randomPublibKeyOne, randomPublicKeyTwo],
        timestamp: now(), // always should be updated
      };

      const updatedPayload = buildSpacePayload({ ...primarySpace, ...updateInput });
      const secondarySignature = await signJSON(updatedPayload, hex(secretKey));
      const updatedSpace = { ...updatedPayload, signature: secondarySignature };

      const result = await upsertSpace(db, updatedSpace);
      const updated = await getSpace(db, result.spaceId);
      const isValid = await verifySpaceSignature(updated);

      expect(isValid).toBe(true)
      expect(result.spaceId).toBe(spaceId);
      expect(updated.permissionBroadcast).toBe(0)
      expect(updated.broadcastWhitelist).toEqual([randomPublibKeyOne, randomPublicKeyTwo]);
      expect(updated.readWhitelist).toEqual([randomPublibKeyOne, randomPublicKeyTwo]);
    })
  });

  describe('createSpaceForPublicKey', () => {
    it('should create space and sign with keypair', async () => {
      const { publicKey, secretKey } = await generateKeypair();
      const space = buildSpacePayload({ ...testSpace, publicKey: hex(publicKey) });

      const { spaceId } = await createSpaceForPublicKey(db, space, hex(secretKey));

      const storedSpace = await getSpace(db, spaceId);
      const valid = await verifySpaceSignature(storedSpace);
      expect(valid).toBe(true);
    })
  })

  describe('updateSpaceForPublicKey', () => {
    it('should maintain space signature valid after update', async () => {
      const { publicKey, secretKey } = await generateKeypair();
      const spacePayload = buildSpacePayload({ ...testSpace, publicKey: hex(publicKey) });

      const { spaceId } = await createSpaceForPublicKey(db, spacePayload, hex(secretKey));
      const originalSpace = await getSpace(db, spaceId);

      const randomPublibKeyOne = 'a'.repeat(64);
      const randomPublicKeyTwo = 'b'.repeat(64);

      // updated parameters
      const updateInput = {
        permissionBroadcast: 0,
        broadcastWhitelist: [randomPublibKeyOne, randomPublicKeyTwo],
        permissionRead: 0,
        readWhitelist: [randomPublibKeyOne, randomPublicKeyTwo],
        timestamp: now(), // always should be updated
      };

      const updatedSpacePayload = buildSpacePayload({ ...spacePayload, ...updateInput });
      await updateSpaceForPublicKey(db, spaceId, updatedSpacePayload, hex(secretKey));

      const updatedSpace = await getSpace(db, spaceId);
      const isValid = await verifySpaceSignature(updatedSpace);

      expect(isValid).toBe(true);
      expect(updatedSpace.nonce).toEqual(originalSpace.nonce);
      expect(updatedSpace.publicKey).toEqual(originalSpace.publicKey);
      expect(updatedSpace.broadcastWhitelist).toEqual([randomPublibKeyOne, randomPublicKeyTwo]);
      expect(updatedSpace.readWhitelist).toEqual([randomPublibKeyOne, randomPublicKeyTwo]);
    })
  })

  describe("querySpace", () => {
    it('should filter by exact and partial fields and return populated whitelists', async () => {

      const pubA = generateValidPublicKey();
      const pubB = generateValidPublicKey();
      const pubC = generateValidPublicKey();

      const spaceOnePayload = await buildTestSpacePayload({
        spaceName: 'alpha',
        publicKey: pubA,
        permissionBroadcast: 0,
        broadcastWhitelist: [pubA, pubB],
        permissionRead: 0,
        readWhitelist: [pubA]
      });

      const spaceTwoPayload = await buildTestSpacePayload({
        spaceName: 'beta',
        publicKey: pubB,
        permissionBroadcast: 0,
        broadcastWhitelist: [pubB, pubC],
        permissionRead: 0,
        readWhitelist: [pubB]
      });

      const { spaceId: spaceOneId } = await createSpace(db, spaceOnePayload);
      const { spaceId: spaceTwoId } = await createSpace(db, spaceTwoPayload);

      const spaceOneQuery = await querySpace(db, {
        spaceName: 'alpha',
        publicKey: pubA,
        permissionBroadcast: 0,
        permissionRead: 0
      });

      const spaceTwoQuery = await querySpace(db, {
        spaceName: 'beta',
        publicKey: pubB
      });

      const multiSpaceQuery = await querySpace(db, {
        permissionRead: 0
      });

      expect(spaceOneQuery.length).toBe(1);
      expect(spaceTwoQuery.length).toBe(1);
      expect(multiSpaceQuery.length).toBe(2);

      expect(spaceOneQuery[0].id).toBe(spaceOneId);
      expect(spaceOneQuery[0].spaceName).toBe('alpha');
      expect(spaceOneQuery[0].broadcastWhitelist).toEqual([pubA, pubB]);
      expect(spaceOneQuery[0].readWhitelist).toEqual([pubA]);

      expect(spaceTwoQuery[0].id).toBe(spaceTwoId);
      expect(spaceTwoQuery[0].spaceName).toBe('beta');
      expect(spaceTwoQuery[0].broadcastWhitelist).toEqual([pubB, pubC]);
      expect(spaceTwoQuery[0].readWhitelist).toEqual([pubB]);
    })

    it('should apply timestamp range, ordering, direction and limit', async () => {

      const pubA = generateValidPublicKey();
      const baseTimestamp = now();

      for (let i = 0; i < 3; i++) {
        let payload = await buildTestSpacePayload({ spaceName: `order-${i}`, publicKey: pubA });
        await createSpace(db, payload);
      }

      const results = await querySpace(db, {
        publicKey: pubA,
        timestampFrom: baseTimestamp,
        timestampTo: baseTimestamp + 500, // 500ms time window
        orderBy: 'timestamp',
        orderDirection: 'desc',
        limit: 2
      });

      expect(results.length).toBe(2);
      expect(results[0].timestamp).toBeGreaterThan(results[1].timestamp);
    })
  })

  describe('listSpace', () => {
    it('listSpaces lists all spaces with populated whitelists', async () => {
      const pubA = generateValidPublicKey();
      const pubB = generateValidPublicKey();
      const pubC = generateValidPublicKey();

      const spaceOnePayload = await buildTestSpacePayload({
        spaceName: 'Restricted',
        publicKey: pubA,
        permissionBroadcast: 0,
        broadcastWhitelist: [pubA, pubB],
        permissionRead: 0,
        readWhitelist: [pubA]
      });

      const spaceTwoPayload = await buildTestSpacePayload({
        spaceName: 'Public',
        publicKey: pubB,
        permissionBroadcast: 1,
        broadcastWhitelist: [],
        permissionRead: 1,
        readWhitelist: []
      });

      await createSpace(db, spaceOnePayload);
      await createSpace(db, spaceTwoPayload);

      const results = await listSpaces(db);

      expect(results.length).toBe(2);

      const restricted = results.find(s => s.spaceName === 'Restricted');
      const publicSpace = results.find(s => s.spaceName === 'Public');

      expect(restricted.broadcastWhitelist).toEqual([pubA, pubB]);
      expect(restricted.readWhitelist).toEqual([pubA]);
      expect(publicSpace.broadcastWhitelist).toEqual([]);
      expect(publicSpace.readWhitelist).toEqual([]);
    })
  })

  describe('deleteSpace', () => {
    it('should delete space with provided spaceId', async () => {
      const spacePayload = await buildTestSpacePayload({ spaceName: 'Test Space' });
      const space = await createSpace(db, spacePayload);

      const earlyList = await listSpaces(db);
      expect(earlyList.length).toBe(1);

      await deleteSpace(db, space.spaceId);
      const finalList = await listSpaces(db);

      expect(finalList.length).toBe(0);
    })

    it('should delete space which includes file registeries included', async () => {
      const spacePayload = await buildTestSpacePayload({ spaceName: 'Test Space' });
      const { spaceId } = await createSpace(db, spacePayload);

      const root = await makeTempDir();
      const tempFilePath = path.join(root, 'tempfile.bin');
      
      await generateRandomFile(tempFilePath, 1); // 1MB

      const registry = await generateFileTreeRecord(db, {
        fileSourcePath: tempFilePath,
        spacePath: '/files',
        spaceFilename: 'temp.bin',
        spaceId: spaceId
      });

      // attemp deleting the space
      await deleteSpace(db, spaceId);

      const list = await listSpaces(db);
      expect(list.length).toBe(0);

      await cleanup(root);
    });
  })
})