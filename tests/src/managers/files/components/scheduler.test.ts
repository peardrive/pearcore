import path from 'path';
import * as EVENTS from '../../../../../src/constants/events.constants.js';
import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { MockCoreFactory } from '../../../../helpers/mock.factory.js';
import { cleanup, generateRandomFile, makeTempDir } from '../../../../helpers/general.utils.js';
import { waitForEvent } from '../../../../helpers/file.test.utils.js';
import { createFileStream, getFileSize } from '../../../../../src/utils/system.utils.js';
import { generateMerkleTree } from '../../../../../src/utils/merkletree.utils.js';
import { hex, randomNonce } from '../../../../../src/utils/crypto.utils.js';
import { parseFilePath } from '../../../../../src/utils/parsers.utils.js';
import { FileEventBroadcaster } from '../../../../../src/managers/files/components/events.js';
import { LocalFileRegistry } from '../../../../../src/managers/files/components/registry.js';
import { ProviderList } from '../../../../../src/managers/files/components/providers.js';
import { LeafDeliveryScheduler } from '../../../../../src/managers/files/components/scheduler.js';

describe('LeafDeliveryScheduler', () => {
  let spaceFilePath = 'document.txt';
  let localFilePath = './file.bin';
  let rootHash: any;
  let factory: any;
  let primaryCore: any;
  let providerCore: any;
  let space: any;
  let tempDirectory: any;
  let scheduler: any;

  const setupCore = async (core: any, params: any) => {
    const { rootHash } = params;
    const spaceFileListManager = core.managers.spaceFileList;

    core.managers.session.set('files.broadcastThrottleTime', 0);

    const fileEventBroadcaster = new FileEventBroadcaster(core.emitter, {
      sessionManager: core.managers.session,
      socketManager: core.managers.sockets,
      messageManager: core.managers.message,
    });

    const localFileRegistry = new LocalFileRegistry(core.emitter, {
      sessionManager: core.managers.session,
      spaceFileListManager: core.managers.spaceFileList,
      fileEventBroadcaster: fileEventBroadcaster,
      fileCache: core.managers.spaceFiles.fileCache,
      fileWatcher: core.managers.spaceFiles.fileWatcher,
    });

    await localFileRegistry.init();

    const providerList = new ProviderList({
      spaceFileListManager: core.managers.spaceFileList,
      topic: space.topicHash,
      spaceFilePath: spaceFilePath,
      rootHash: rootHash,
      onDrop: () => {}, // void
    });

    return {
      ...core,
      spaceFileListManager,
      fileEventBroadcaster,
      localFileRegistry,
      providerList,
    };
  };

  beforeAll(async () => {
    factory = new MockCoreFactory();
    await factory.init();

    tempDirectory = await makeTempDir();
    localFilePath = path.join(tempDirectory, localFilePath);
    await generateRandomFile(localFilePath, 1); // 1MB - 4 chunks

    const tree = await generateMerkleTree({
      stream: createFileStream(localFilePath),
      size: await getFileSize(localFilePath),
    });

    rootHash = tree.rootHash;

    const core = await factory.createCore('primary');
    space = await core.space.create({ spaceName: 'deliveryApp' });
    primaryCore = await setupCore(core, { rootHash });

    const provider = await factory.createCore('provider');
    providerCore = await setupCore(provider, { rootHash });

    await new Promise<void>((resolve) => {
      providerCore.emitter.on(EVENTS.SpaceSync, () => {
        resolve();
      });
      providerCore.space.join(space.sharelink);
    });

    const parsed = parseFilePath(spaceFilePath);
    // index and broadcast the local file
    await providerCore.localFileRegistry.add({
      spaceId: space.id,
      spacePath: parsed.dir,
      spaceFilename: parsed.filename,
      fileSourcePath: localFilePath,
    });

    await waitForEvent(primaryCore, EVENTS.SpaceFileEvent);

    primaryCore.providerList.refresh();
    // manually pass the lastRequestableLeaf parameter for the providerList
    primaryCore.providerList.setAdvertisedLeaf(providerCore.publicKey, 4);
  });

  beforeEach(async () => {
    const downloadKey = hex(randomNonce());

    scheduler = new LeafDeliveryScheduler({
      sessionManager: primaryCore.managers.session,
      socketManager: primaryCore.managers.sockets,
      messageManager: primaryCore.managers.message,
      connectionManager: primaryCore.managers.connection,
      providerList: primaryCore.providerList,
      topic: space.topicHash,
      spaceFilePath: spaceFilePath,
      downloadKey: downloadKey,
    });
  });

  afterEach(() => {
    // beforeAll wires providerCore's advertised leaf to 4 once but some tests below bump it
    // or inject extra providers for isolation. therefore put it back so test order doesn't matter.
    primaryCore.providerList.setAdvertisedLeaf(providerCore.publicKey, 4);
    primaryCore.providerList.providers.delete(
      'injected-partial-coverage-provider',
    );
    primaryCore.providerList.providers.delete(
      'injected-full-coverage-provider',
    );
  });

  afterAll(async () => {
    await primaryCore.localFileRegistry.stop();
    await providerCore.localFileRegistry.stop();
    await factory.cleanup();
    await cleanup(tempDirectory);
  });

  describe('assign', () => {
    it('should assign a provider according to the advertised lastRequestableLeaf', async () => {
      scheduler.seed(0, 1000); // the range is 4 chunks (256KB each)
      scheduler.assign();

      const publicKey = providerCore.publicKey;
      const queue = scheduler.queue;
      const assignment = scheduler.assignments.get(publicKey);

      expect(queue.length).toBe(1);
      expect(queue[0]).toEqual([5, 1000]);
      expect(scheduler.assignments.size).toBe(1);
      expect(assignment.remaining.size).toBe(5); // couting from index 0 to 4
    });

    it('should leave the queue untouched when no known provider can currently serve it', () => {
      scheduler.seed(100, 200);
      scheduler.assign();

      expect(scheduler.queue).toEqual([[100, 200]]); // queue with single range in it
      expect(scheduler.assignments.size).toBe(0);
    });
  });

  describe('markDelivered', () => {
    it('should mark leavs for the provider and free it once every leaf has arrived', () => {
      scheduler.seed(0, 4);
      scheduler.assign();

      scheduler.markDelivered(0);
      scheduler.markDelivered(1);
      scheduler.markDelivered(2);
      scheduler.markDelivered(3);

      expect(scheduler.assignments.has(providerCore.publicKey)).toBe(true);

      scheduler.markDelivered(4);
      expect(scheduler.assignments.has(providerCore.publicKey)).toBe(false);
    });
  });

  describe('getProviderForLeaf', () => {
    it('should report the assigned provider for a leaf inside its range', () => {
      scheduler.seed(0, 4);
      scheduler.assign();

      expect(scheduler.getProviderForLeaf(2)).toBe(providerCore.publicKey);
    });

    it('should return null for a leaf that is not assigned to any provider', () => {
      expect(scheduler.getProviderForLeaf(999)).toBeNull();
    });
  });

  describe('releaseProvider', () => {
    it('should remove to assignment record and requeue the leaves', () => {
      scheduler.seed(0, 4);
      scheduler.assign();

      scheduler.markDelivered(0);
      scheduler.markDelivered(1); // 2, 3, 4 still remains

      scheduler.releaseProvider(providerCore.publicKey);

      expect(scheduler.assignments.has(providerCore.publicKey)).toBe(false);
      expect(scheduler.queue).toEqual([[2, 4]]);
    });
  });

  describe('reclaimStalled', () => {
    it('should not touch an assignment that is not yet stale', async () => {
      scheduler.seed(0, 4);
      scheduler.assign();

      // providerCore's assignment is fresh
      await expect(scheduler.reclaimStalled()).resolves.toBeUndefined();
      expect(scheduler.assignments.has(providerCore.publicKey)).toBe(true);
    });

    it('should not reclaim when the only provider alternative covers just part of the remaining range', async () => {
      // setting a fake provider with only half the required leaf range
      const fakeProvider = 'injected-partial-coverage-provider';
      primaryCore.providerList.providers.set(fakeProvider, {
        lastRequestableLeaf: 2,
      });

      scheduler.seed(0, 4);
      scheduler.assign();

      const assignment = scheduler.assignments.get(providerCore.publicKey);
      assignment.requestedAt = Date.now() - 999999; // force it stale

      await scheduler.reclaimStalled();

      // The reclaim should be ignored because the fake provider
      // doesn't carry the full leaf range coverage
      expect(scheduler.assignments.has(providerCore.publicKey)).toBe(true);
      expect(scheduler.assignments.has(fakeProvider)).toBe(false);
      expect(scheduler.queue).toEqual([]);
    });

    it('should reclaim and fully reassign a stalled assignment once an alternative covers the entire remaining range', async () => {
      primaryCore.providerList.providers.set(
        'injected-full-coverage-provider',
        { lastRequestableLeaf: 90 },
      );

      scheduler.seed(0, 4);
      scheduler.assign(); // providerCore takes [0, 4]

      const assignment = scheduler.assignments.get(providerCore.publicKey);
      assignment.requestedAt = Date.now() - 999999; // force it stale

      await scheduler.reclaimStalled();

      scheduler.assign();

      expect(scheduler.assignments.has(providerCore.publicKey)).toBe(false);
      const newAssignment = scheduler.assignments.get(
        'injected-full-coverage-provider',
      );
      expect(newAssignment).toBeDefined();
      expect([newAssignment.start, newAssignment.end]).toEqual([0, 4]); // whole range should be assigned to new provider
      expect(scheduler.queue).toEqual([]);
    });
  });
});
