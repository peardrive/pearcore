// @ts-nocheck
import path from 'path';
import * as EVENTS from '../../../../src/constants/events.constants.js';
import * as MESSAGES from '../../../../src/constants/messages.constants.js';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import {
  createSpaceForPublicKey,
  getSpace,
  getSpaceTopicHash,
  upsertSpace,
} from '../../../../src/utils/space.utils.js';
import {
  createSpaceFileContentRequestMessage,
  createSpaceFileEventMessage,
  createSpaceFileRecordSignature,
  createSpaceFileTreeRequestMessage,
  validateSpaceFileTreeResponsePayload,
} from '../../../../src/utils/protocol.utils.js';
import {
  buildTestSpacePayload,
  makeTempDir,
  cleanup,
  generateRandomFile,
} from '../../../helpers/general.utils.js';
import { MockCoreFactory } from '../../../helpers/mock.factory.js';
import {
  collectMessages,
  connectProtocolNodes,
  deliverMessage,
} from '../../../helpers/protocol.utils.js';
import {
  createDownloadRecord,
  createFileIndexRecord,
  deleteFileRecord,
  generateFileTreeRecord,
  getFileChunk,
  getFileTreeRecord,
  updateDownloadRecord,
} from '../../../../src/utils/files.utils.js';
import { generateMerkleTree } from '../../../../src/utils/merkletree.utils.js';
import {
  closeFile,
  createFileStream,
  getFileSize,
  openFile,
  posixPathJoin,
} from '../../../../src/utils/system.utils.js';
import { DEFAULT_CHUNK_SIZE } from '../../../../src/constants/global.constants.js';
import type { SignedSpace } from '../../../../src/utils/space.utils.js';
import type { SpaceFileRecordInput } from '../../../../src/utils/protocol.utils.js';

async function getExistingSpace(db: any, spaceId: number) {
  const space = await getSpace(db, spaceId);
  if (!space) throw new Error(`Space ${spaceId} was not found`);
  return space;
}

/**
 * Three factory cores that share one space on the in-memory peer network:
 * primary and secondary communicate, standby only receives broadcasts.
 * Replies and broadcasts are observed as the protocol messages the peers
 * receive (`EVENTS.General`), and streamed chunks as what the receiving
 * download task is fed.
 */
describe('Space File Protocols', () => {
  let factory: MockCoreFactory;
  let cores: any[];
  let primary: any;
  let primaryDB: any;
  let secondary: any;
  let secondaryDB: any;
  let standby: any;
  let standbyDB: any;
  let spaceParams: Awaited<ReturnType<typeof buildTestSpacePayload>>;
  let spaceTopicHash: string;
  let inboxes: Map<string, ReturnType<typeof collectMessages>>;

  const inboxOf = (core: any) => inboxes.get(core.name)!;

  beforeEach(async () => {
    factory = new MockCoreFactory();
    await factory.init();

    cores = await factory.createMultipleCores(3);
    const names = ['primary', 'secondary', 'standby'];
    cores.forEach((core, index) => {
      core.name = names[index];
    });
    [primary, secondary, standby] = cores;

    primaryDB = primary.managers.session.getDatabase().db;
    secondaryDB = secondary.managers.session.getDatabase().db;
    standbyDB = standby.managers.session.getDatabase().db;

    spaceParams = await buildTestSpacePayload({
      spaceName: 'TestSpace',
      publicKey: primary.publicKey,
      permissionRead: 0,
      permissionBroadcast: 0,
      readWhitelist: [
        primary.publicKey,
        secondary.publicKey,
        standby.publicKey,
      ],
      broadcastWhitelist: [secondary.publicKey],
    });

    const { spaceId } = await createSpaceForPublicKey(
      primaryDB,
      spaceParams,
      primary.secretKey,
    );
    const space = await getExistingSpace(primaryDB, spaceId);
    await upsertSpace(secondaryDB, space as unknown as SignedSpace);
    await upsertSpace(standbyDB, space as unknown as SignedSpace);

    spaceTopicHash = getSpaceTopicHash(spaceParams);

    await connectProtocolNodes(factory, spaceTopicHash, cores);

    inboxes = new Map(cores.map((core) => [core.name, collectMessages(core)]));
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  describe('SpaceFileEventHandler', () => {
    const createRecord = async (
      params: SpaceFileRecordInput & { secretKey: string | Uint8Array },
    ) => {
      const signature = await createSpaceFileRecordSignature(params);
      return { ...params, signature };
    };

    const toEvent = (record: Record<string, any>) => {
      return [
        record.path,
        record.publicKey,
        record.timestamp,
        record.rootHash,
        record.signature,
      ];
    };

    it('should reject message from unknown space', async () => {
      const unkownTopic = '0x012345';
      const message = await createSpaceFileEventMessage({
        topic: unkownTopic,
        events: [],
        publicKey: primary.publicKey,
        secretKey: primary.secretKey,
      });

      await deliverMessage(secondary, primary, message);
      await factory.settle();

      const replies = inboxOf(primary).of(EVENTS.Reject, secondary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        MESSAGES.SPACE_NOT_FOUND_MESSAGE,
      );
    });

    it('should reject when node is not allowed to broadcast', async () => {
      const message = await createSpaceFileEventMessage({
        topic: spaceTopicHash,
        events: [],
        publicKey: standby.publicKey,
        secretKey: standby.secretKey,
      });

      await deliverMessage(secondary, primary, message);
      await factory.settle();

      const replies = inboxOf(primary).of(EVENTS.Reject, secondary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        MESSAGES.BROADCAST_PERMISSION_NOT_ALLOWED_MESSAGE,
      );
    });

    it('should broadcast the event stack while duplicates are removed and locally stored events are dropped', async () => {
      const fileOneRecord = await createRecord({
        topic: spaceTopicHash,
        path: '/file1.txt',
        rootHash: 'a'.repeat(10),
        timestamp: 1000,
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      const fileOneRenewalRecord = await createRecord({
        ...fileOneRecord,
        timestamp: 2000,
      });

      const fileTwoRecord = await createRecord({
        ...fileOneRecord,
        path: '/file2.txt',
        rootHash: 'b'.repeat(10),
      });

      primary.managers.spaceFileList.add(fileOneRecord);

      const eventStack = [
        {
          action: EVENTS.SpaceFileEventOptions.ADD,
          files: [
            toEvent(fileOneRecord), // duplicate => drop
            toEvent(fileOneRenewalRecord), // new timestamp => include
            toEvent(fileTwoRecord), // new record => include
          ],
        },
      ];

      const message = await createSpaceFileEventMessage({
        topic: spaceTopicHash,
        events: eventStack,
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const primaryFiles = primary.managers.spaceFileList.get(spaceTopicHash);
      expect(primaryFiles['/file1.txt']).toBeDefined();

      const file1Peers = primaryFiles['/file1.txt']['a'.repeat(10)].peers;
      expect(file1Peers[secondary.publicKey].timestamp).toBe(2000);

      // standby received the filtered broadcast, byte for byte
      const broadcasts = inboxOf(standby).of(EVENTS.SpaceFileEvent, primary);
      expect(broadcasts).toHaveLength(1);

      const broadcastEvents = broadcasts[0].message.payload[0].files;
      expect(broadcastEvents).toEqual([
        toEvent(fileOneRenewalRecord),
        toEvent(fileTwoRecord),
      ]);
    });

    it('should handle removal events correctly', async () => {
      const initialRecord = await createRecord({
        topic: spaceTopicHash,
        path: '/file1.txt',
        rootHash: 'a'.repeat(10),
        timestamp: 1000,
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      primary.managers.spaceFileList.add(initialRecord);

      const removeRecord = await createRecord({
        topic: spaceTopicHash,
        path: '/file1.txt',
        rootHash: 'a'.repeat(10),
        timestamp: 2000, // newer than the existing 1000
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      const eventStack = [
        {
          action: EVENTS.SpaceFileEventOptions.REMOVE,
          files: [toEvent(removeRecord)],
        },
      ];

      const message = await createSpaceFileEventMessage({
        topic: spaceTopicHash,
        events: eventStack,
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      // ensure that the provider was removed from the primary node's list
      const primaryFiles = primary.managers.spaceFileList.get(spaceTopicHash);
      expect(primaryFiles['/file1.txt']).toBeUndefined();

      // ensure that the primary broadcast the removal to other peers
      const broadcasts = inboxOf(standby).of(EVENTS.SpaceFileEvent, primary);
      expect(broadcasts).toHaveLength(1);
      expect(broadcasts[0].message.payload[0].action).toBe(
        EVENTS.SpaceFileEventOptions.REMOVE,
      );
      expect(broadcasts[0].message.payload[0].files).toEqual([
        toEvent(removeRecord),
      ]);
    });
  });

  describe('SpaceFileTreeRequestHandler', () => {
    let root: any = null;
    let spacePath = '/root';
    let spaceFilename = 'tempfile';
    let rootHash: any = null;
    let tree: any = null;
    let filePath: any = null;
    let fileSize: any = null;

    beforeEach(async () => {
      root = await makeTempDir();
      filePath = path.join(root, 'tempfile');
      await generateRandomFile(filePath, 1); // 1 MB

      fileSize = await getFileSize(filePath);

      const result = await generateFileTreeRecord(primaryDB, {
        fileSourcePath: filePath,
        spacePath: spacePath,
        spaceFilename: spaceFilename,
        spaceId: 1,
      });

      rootHash = result.rootHash;
      tree = (await getFileTreeRecord(primaryDB, result.registryId))!;
    });

    afterEach(async () => {
      await cleanup(root);
    });

    it('should response with the correct file tree for valid request', async () => {
      const message = await createSpaceFileTreeRequestMessage({
        topic: spaceTopicHash,
        rootHash: rootHash,
        spaceFilePath: posixPathJoin(spacePath, spaceFilename),
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const responses = inboxOf(secondary).of(EVENTS.SpaceFileTreeResponse, primary);
      expect(responses).toHaveLength(1);

      const responseStatus = validateSpaceFileTreeResponsePayload(
        responses[0].message,
      );

      expect(responseStatus.isValid).toBe(true);
      expect(responses[0].message.payload.tree.rootHash).toEqual(rootHash);
    });

    it('should response with the last downloaded leaf for partially download file', async () => {
      await deleteFileRecord(primaryDB, 1); // remove preloaded file registry

      // suppose we have partial download record for certain file
      // here we first should insert the tree into the database
      const partialTree = await generateMerkleTree({
        stream: createFileStream(filePath),
        size: fileSize,
        chunkSize: DEFAULT_CHUNK_SIZE,
      });

      // now we need to create a download record the that file
      const { registryId } = await createDownloadRecord(primaryDB, {
        tempFilePath: path.join(root, 'temp.download'),
        finalDestination: path.join(root, 'final.download'),
        spaceId: 1,
        spaceFilename: spaceFilename,
        spacePath: spacePath,
        rootHash: partialTree.rootHash,
        leafCount: partialTree.levels[partialTree.height].length,
        height: partialTree.height,
      });

      await createFileIndexRecord(primaryDB, registryId, partialTree);

      // we download the first two chunks as our partial download
      const localFileHandler = await openFile(filePath);
      const firstChunk = await getFileChunk(
        localFileHandler,
        fileSize,
        0,
        DEFAULT_CHUNK_SIZE,
      );

      const writeHandler = await openFile(path.join(root, 'temp.download'));

      await updateDownloadRecord(primaryDB, {
        registryId: registryId,
        leafIndex: 0,
        leafContent: firstChunk,
        fileHandler: writeHandler,
      });

      const message = await createSpaceFileTreeRequestMessage({
        topic: spaceTopicHash,
        rootHash: rootHash,
        spaceFilePath: posixPathJoin(spacePath, spaceFilename),
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const responses = inboxOf(secondary).of(EVENTS.SpaceFileTreeResponse, primary);
      expect(responses).toHaveLength(1);

      const responseStatus = validateSpaceFileTreeResponsePayload(
        responses[0].message,
      );

      expect(responseStatus.isValid).toBe(true);
      expect(responses[0].message.payload.tree.rootHash).toEqual(rootHash);
      expect(responses[0].message.payload.lastRequestableLeaf).toBe(1);

      await closeFile(localFileHandler);
      await closeFile(writeHandler);
    });
  });

  describe('SpaceFileContentRequestHandler', () => {
    let root: any = null;
    let filePath: any = null;
    let spacePath = '/root';
    let spaceFilename = 'tempfile';
    let rootHash: any = null;
    let leafCount: any = null;
    let registryId: any = null;
    let fileSize: any = null;
    let testKey: any = null;

    beforeEach(async () => {
      root = await makeTempDir();
      filePath = path.join(root, 'tempfile');
      await generateRandomFile(filePath, 1); // 1 MB

      fileSize = await getFileSize(filePath);

      const result = await generateFileTreeRecord(primaryDB, {
        fileSourcePath: filePath,
        spacePath,
        spaceFilename,
        spaceId: 1, // space ID from the created space
      });

      registryId = result.registryId;
      rootHash = result.rootHash;
      leafCount = result.leafCount;

      // Generate a random key for content requests
      testKey = 'a'.repeat(24); // 24 character hex string
    });

    afterEach(async () => {
      await cleanup(root);
    });

    it('should reject when message is a relay', async () => {
      const message = await createSpaceFileContentRequestMessage({
        topic: spaceTopicHash,
        spaceFilePath: posixPathJoin(spacePath, spaceFilename),
        leafStart: 0,
        leafStop: 0,
        downloadKey: testKey,
        publicKey: standby.publicKey,
        secretKey: standby.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const replies = inboxOf(secondary).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(MESSAGES.NO_RELAY_MESSAGE);
    });

    it('should reject when space not found', async () => {
      const message = await createSpaceFileContentRequestMessage({
        topic: '0x999999999',
        spaceFilePath: posixPathJoin(spacePath, spaceFilename),
        leafStart: 0,
        leafStop: 0,
        downloadKey: testKey,
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const replies = inboxOf(secondary).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        MESSAGES.SPACE_NOT_FOUND_MESSAGE,
      );
    });

    it('should reject when the sender is not allowed to read', async () => {
      // create a node not in readWhitelist and bring it up on the topic
      const [unauthorized] = await factory.createMultipleCores(1);
      unauthorized.name = 'unauthorized';
      await unauthorized.managers.connection.join(spaceTopicHash);
      await factory.settle();
      const unauthorizedInbox = collectMessages(unauthorized);

      const message = await createSpaceFileContentRequestMessage({
        topic: spaceTopicHash,
        spaceFilePath: posixPathJoin(spacePath, spaceFilename),
        leafStart: 0,
        leafStop: 0,
        downloadKey: testKey,
        publicKey: unauthorized.publicKey,
        secretKey: unauthorized.secretKey,
      });

      await deliverMessage(primary, unauthorized, message);
      await factory.settle();

      const replies = unauthorizedInbox.of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE,
      );
    });

    it('should reject when space file path is not found', async () => {
      const nonExistentPath = '/nonexistent/file.txt';
      const message = await createSpaceFileContentRequestMessage({
        topic: spaceTopicHash,
        spaceFilePath: nonExistentPath,
        leafStart: 0,
        leafStop: 0,
        downloadKey: testKey,
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const replies = inboxOf(secondary).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        MESSAGES.SPACE_FILE_NOT_FOUND,
      );
    });

    it('should reject when slice is not available (beyond leaf count)', async () => {
      const message = await createSpaceFileContentRequestMessage({
        topic: spaceTopicHash,
        spaceFilePath: posixPathJoin(spacePath, spaceFilename),
        leafStart: leafCount,
        leafStop: leafCount + 1, // out of leaf index
        downloadKey: testKey,
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const replies = inboxOf(secondary).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        MESSAGES.SLICE_NOT_AVAILABLE_MESSAGE,
      );
    });

    it('should deliver the requested chunks to the requester download task', async () => {
      const startLeaf = 0;
      const endLeaf = 2;

      // the requester routes incoming stream chunks to the download task of the key
      const received: Array<{
        leafIndex: number;
        chunk: Buffer;
        publicKey: string;
      }> = [];
      const stubTask = {
        handleChunk: async (
          leafIndex: number,
          chunk: Buffer,
          publicKey: string,
        ) => {
          received.push({ leafIndex, chunk, publicKey });
        },
        stop: async () => {},
      };
      secondary.managers.spaceFiles.downloadTasks.set(testKey, stubTask);

      try {
        const message = await createSpaceFileContentRequestMessage({
          topic: spaceTopicHash,
          spaceFilePath: posixPathJoin(spacePath, spaceFilename),
          leafStart: startLeaf,
          leafStop: endLeaf,
          downloadKey: testKey,
          publicKey: secondary.publicKey,
          secretKey: secondary.secretKey,
        });

        await deliverMessage(primary, secondary, message);

        // wait for task to be assigned internally and then wait for completion of the task
        const taskResult = await primary.managers.spaceFiles.waitForDeliveryTask(testKey);
        expect(taskResult.succeed).toBe(true);
        await factory.settle();

        const expectedChunks = endLeaf - startLeaf + 1;
        expect(received).toHaveLength(expectedChunks);

        const fileHandler = await openFile(filePath);
        const stats = await fileHandler.stat();
        const size = stats.size;

        for (let index = 0; index < expectedChunks; index++) {
          const delivered = received[index];
          expect(delivered.leafIndex).toBe(startLeaf + index);
          expect(delivered.publicKey).toBe(primary.publicKey);

          const expectedChunk = await getFileChunk(
            fileHandler,
            size,
            startLeaf + index,
            DEFAULT_CHUNK_SIZE,
          );

          expect(delivered.chunk).toEqual(expectedChunk);
        }

        await closeFile(fileHandler);
      } finally {
        secondary.managers.spaceFiles.downloadTasks.delete(testKey);
      }
    });
  });

  describe('SpaceFileContentCancel');
});
