import path from 'path';
import * as EVENTS from '../../../../../src/constants/events.constants.js';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { MockCoreFactory } from '../../../../helpers/mock.factory.js';
import { cleanup, generateRandomFile, makeTempDir } from '../../../../helpers/general.utils.js';
import {
  generateFileTreeRecord,
  queryFileRegistryRecords,
  createDownloadRecord,
  getTemporarySourcePathForSpaceFile,
  getFileRegistryRecord,
} from '../../../../../src/utils/files.utils.js';
import {
  deleteFile,
  getFileSize,
  createFileStream,
} from '../../../../../src/utils/system.utils.js';
import { generateMerkleTree } from '../../../../../src/utils/merkletree.utils.js';
import { FileEventBroadcaster } from '../../../../../src/managers/files/components/events.js';
import { LocalFileRegistry } from '../../../../../src/managers/files/components/registry.js';
import { FileHandlerCache } from '../../../../../src/managers/files/components/cache.js';
import { LocalFileWatcher } from '../../../../../src/managers/files/components/watcher.js';

describe('LocalFileRegistry', () => {
  let factory: any;
  let core: any = null;
  let broadcaster: any = null;
  let localFileRegistry: any = null;
  let temporaryDirectory: any = null;
  let filePath: any = null;
  let space: any = null;
  let db: any = null;
  let fileWatcher: any = null;

  beforeEach(async () => {
    factory = new MockCoreFactory();
    await factory.init();

    core = await factory.createCore();
    temporaryDirectory = await makeTempDir();

    filePath = path.join(temporaryDirectory, 'test.txt');
    await generateRandomFile(filePath, 1); // 1MB

    space = await core.space.create({ spaceName: 'testspace' });
    db = core.managers.session.getDatabase().db;

    broadcaster = new FileEventBroadcaster(core.emitter, {
      sessionManager: core.managers.session,
      socketManager: core.managers.sockets,
      messageManager: core.managers.message,
    });

    fileWatcher = new LocalFileWatcher();

    localFileRegistry = new LocalFileRegistry(core.emitter, {
      sessionManager: core.managers.session,
      spaceFileListManager: core.managers.spaceFileList,
      fileEventBroadcaster: broadcaster,
      fileCache: new FileHandlerCache(),
      fileWatcher: fileWatcher,
    });
  });

  afterEach(async () => {
    await localFileRegistry.stop();
    await fileWatcher.close();
    await localFileRegistry.fileCache.stop();
    await broadcaster.flush();
    await cleanup(temporaryDirectory);
    await factory.cleanup();
  });

  describe('init', () => {
    it('should load existing registries and add them to SpaceFileList and broadcast to network', async () => {
      const { registryId } = await generateFileTreeRecord(db, {
        fileSourcePath: filePath,
        spacePath: '/',
        spaceFilename: 'file.txt',
        spaceId: 1,
      });

      const addSpy = vi.spyOn(core.managers.spaceFileList, 'add');
      const broadcastSpy = vi.spyOn(
        localFileRegistry.fileEventBroadcaster,
        'add',
      );

      await localFileRegistry.init();

      expect(addSpy).toHaveBeenCalledTimes(1);

      const addedRecord: any = addSpy.mock.calls[0][0];
      expect(addedRecord.path).toBe('/file.txt');
      expect(addedRecord.rootHash).toBeDefined();

      expect(broadcastSpy).toHaveBeenCalledTimes(1);
      expect(broadcastSpy).toHaveBeenCalledWith(
        EVENTS.SpaceFileEventOptions.ADD,
        expect.objectContaining({ path: '/file.txt' }),
      );
    });

    it('should delete registry if the source file does not exist', async () => {
      const { registryId } = await generateFileTreeRecord(db, {
        fileSourcePath: filePath,
        spacePath: '/',
        spaceFilename: 'file.txt',
        spaceId: 1,
      });

      await deleteFile(filePath);
      await localFileRegistry.init();

      const list = await queryFileRegistryRecords(db, {});
      expect(list.length).toBe(0);
    });

    it('should skip registry if download record exists', async () => {
      const topic = 'a'.repeat(64);

      const { directory, username } = core.managers.session.getAccount();
      const temporaryPath = getTemporarySourcePathForSpaceFile({
        root: directory,
        username,
        topic: topic,
        spaceFilePath: '/file.txt',
        rootHash: 'b'.repeat(64),
      });

      const size = await getFileSize(filePath);
      const stream = createFileStream(filePath);
      const tree = await generateMerkleTree({ stream, size });

      const { registryId } = await createDownloadRecord(db, {
        tempFilePath: temporaryPath,
        finalDestination: path.join(temporaryDirectory, 'final.file.txt'),
        spaceId: 1,
        spacePath: '/',
        spaceFilename: 'file.txt',
        rootHash: tree.rootHash,
        leafCount: tree.levels[tree.height].length,
        height: tree.height,
      });

      const addSpy = vi.spyOn(core.managers.spaceFileList, 'add');

      await localFileRegistry.init();

      expect(addSpy).not.toHaveBeenCalled();

      const fileList = localFileRegistry.spaceFileListManager.get(topic);
      expect(Object.keys(fileList).length).toBe(0);
    });
  });

  describe('onChangeEvent', () => {
    it('should update registry if the file content has been changed', async () => {
      const { registryId } = await generateFileTreeRecord(db, {
        fileSourcePath: filePath,
        spacePath: '/',
        spaceFilename: 'file.txt',
        spaceId: 1,
      });

      // retrieve the original metaHash
      const originalRegistry = await getFileRegistryRecord(db, registryId);
      const addSpy = vi.spyOn(localFileRegistry.fileEventBroadcaster, 'add');

      // set short backoff for testing
      const session = core.managers.session;
      session.set('files.localChangeBackoff', {
        baseDelay: 10,
        maxDelay: 15,
        backoffIncrement: 1,
      });

      // change the file content (from 1MB size to 2MB)
      await generateRandomFile(filePath, 2);

      await localFileRegistry.init();
      await localFileRegistry.onChangeEvent(filePath);

      // wait until the file-indexing settles
      await new Promise((resolve) => setTimeout(resolve, 100));

      // check SpaceFileList to be updated with new registry record
      const updatedRegistry = (await getFileRegistryRecord(db, registryId))!;
      const spaceFile = localFileRegistry.spaceFileListManager.get(
        space.topicHash,
      )['/file.txt'];
      const finalRootHash = Object.keys(spaceFile)[0];
      expect(finalRootHash).toBe(updatedRegistry.rootHash);

      expect(addSpy).toHaveBeenCalled();
    });

    it('should increase delay on rapid changes and only run indexing once after last change', async () => {
      vi.useFakeTimers();

      const session = core.managers.session;
      session.set('files.localChangeBackoff', {
        baseDelay: 100,
        maxDelay: 500,
        backoffIncrement: 150,
      });

      await generateFileTreeRecord(db, {
        fileSourcePath: filePath,
        spacePath: '/',
        spaceFilename: 'file.txt',
        spaceId: 1,
      });
      await localFileRegistry.init();

      const processSpy = vi.spyOn(localFileRegistry, 'processFileIndex');

      for (let i = 0; i < 3; i++) {
        await generateRandomFile(filePath, 2 + i);
        await localFileRegistry.onChangeEvent(filePath);
        vi.advanceTimersByTime(50); // less than baseDelay
      }

      expect(processSpy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(400);
      expect(processSpy).toHaveBeenCalledTimes(1);

      vi.useRealTimers();
    });

    it('should set pending flag when changes occur during active indexing', async () => {
      vi.useFakeTimers();

      const session = core.managers.session;
      session.set('files.localChangeBackoff', {
        baseDelay: 100,
        maxDelay: 500,
        backoffIncrement: 150,
      });

      await generateFileTreeRecord(db, {
        fileSourcePath: filePath,
        spacePath: '/',
        spaceFilename: 'file.txt',
        spaceId: 1,
      });
      await localFileRegistry.init();

      const originalProcess = localFileRegistry.processFileIndex;
      const processSpy = vi
        .spyOn(localFileRegistry, 'processFileIndex')
        .mockImplementation(async function (...args) {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return originalProcess.apply(this, args);
        });

      await generateRandomFile(filePath, 2);
      await localFileRegistry.onChangeEvent(filePath);

      // this will trigger initial indexing
      vi.advanceTimersByTime(100);

      await generateRandomFile(filePath, 3);
      await localFileRegistry.onChangeEvent(filePath);

      // finish the indexing and allow a follow-up
      vi.advanceTimersByTime(300);
      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(localFileRegistry.pendingAfterIndex.get(filePath)).toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe('onDeleteEvent', () => {
    it('should remove registry if the file has been deleted', async () => {
      const { registryId } = await generateFileTreeRecord(db, {
        fileSourcePath: filePath,
        spacePath: '/',
        spaceFilename: 'file.txt',
        spaceId: 1,
      });

      const addSpy = vi.spyOn(localFileRegistry.fileEventBroadcaster, 'add');
      const fileListRemoveSpy = vi.spyOn(
        localFileRegistry.spaceFileListManager,
        'remove',
      );

      await localFileRegistry.init();
      await deleteFile(filePath);
      await localFileRegistry.onDeleteEvent(filePath);

      const registryList = await queryFileRegistryRecords(db, {});
      expect(registryList.length).toBe(0);
      expect(addSpy).toHaveBeenCalled();
      expect(fileListRemoveSpy).toHaveBeenCalled();
    });
  });

  describe('add', () => {
    it('should create new registry and broadcast to the space', async () => {
      const addSpy = vi.spyOn(localFileRegistry.spaceFileListManager, 'add');
      const broadcastSpy = vi.spyOn(
        localFileRegistry.fileEventBroadcaster,
        'add',
      );

      await localFileRegistry.init();

      const registryId = await localFileRegistry.add({
        spaceId: 1,
        spacePath: '/docs',
        spaceFilename: 'file.txt',
        fileSourcePath: filePath,
      });

      const registry = (await getFileRegistryRecord(db, registryId))!;
      expect(registry).toBeDefined();
      expect(registry.fileSourcePath).toBe(filePath);
      expect(registry.spaceId).toBe(1);
      expect(registry.spacePath).toBe('/docs');
      expect(registry.spaceFilename).toBe('file.txt');

      expect(addSpy).toHaveBeenCalledTimes(1);
      const addedRecord: any = addSpy.mock.calls[0][0];
      expect(addedRecord.path).toBe('/docs/file.txt');
      expect(addedRecord.rootHash).toBe(registry.rootHash);

      expect(broadcastSpy).toHaveBeenCalledWith(
        EVENTS.SpaceFileEventOptions.ADD,
        expect.objectContaining({
          path: '/docs/file.txt',
          rootHash: registry.rootHash,
        }),
      );
    });
  });

  describe('remove', () => {
    it('should delete the registry and broadcast to the space', async () => {
      await localFileRegistry.init();

      const removeSpy = vi.spyOn(
        localFileRegistry.spaceFileListManager,
        'remove',
      );
      const broadcastSpy = vi.spyOn(
        localFileRegistry.fileEventBroadcaster,
        'add',
      );

      const registryId = await localFileRegistry.add({
        spaceId: 1,
        spacePath: '/docs/',
        spaceFilename: 'to-delete.txt',
        fileSourcePath: filePath,
      });

      const { rootHash } = (await getFileRegistryRecord(db, registryId))!;

      await localFileRegistry.delete({ registryId });

      const registry = (await getFileRegistryRecord(db, registryId))!;
      expect(registry).toBeUndefined();

      expect(removeSpy).toHaveBeenCalledTimes(1);
      const removeRecord: any = removeSpy.mock.calls[0][0];
      expect(removeRecord.path).toBe('/docs/to-delete.txt');
      expect(removeRecord.rootHash).toBe(rootHash);

      expect(broadcastSpy).toHaveBeenCalledWith(
        EVENTS.SpaceFileEventOptions.REMOVE,
        expect.objectContaining({
          path: '/docs/to-delete.txt',
          rootHash: rootHash,
        }),
      );
    });
  });

  describe('progress tracking', () => {
    it('should have no active trackers when idle', async () => {
      await localFileRegistry.init();
      expect(localFileRegistry.progressTrackers.size).toBe(0);
      expect(localFileRegistry.getProgressTracker(filePath)).not.toBeDefined();
    });

    it('should track progress while add() is indexing', async () => {
      await localFileRegistry.init();

      const addPromise = localFileRegistry.add({
        spaceId: 1,
        spacePath: '/docs',
        spaceFilename: 'file.txt',
        fileSourcePath: filePath,
      });

      await vi.waitFor(
        () => {
          expect(localFileRegistry.progressTrackers.has(filePath)).toBe(true);
        },
        { timeout: 3000, interval: 10 },
      );

      const tracker = localFileRegistry.getProgressTracker(filePath);

      const snapshots: any[] = [];
      tracker.on('progress', (snapshot: any) => snapshots.push(snapshot));

      await addPromise;

      expect(localFileRegistry.progressTrackers.has(filePath)).toBe(false);
      expect(localFileRegistry.getProgressTracker(filePath)).not.toBeDefined();

      expect(snapshots.length).toBeGreaterThan(0);

      const last = snapshots[snapshots.length - 1];
      expect(last.percent).toBe(100);
      expect(last.contributions).toEqual([{ source: 'local', percent: 100 }]);
    });

    it('should track progress during scheduled re-indexing after a file change, and dispose it after', async () => {
      await generateFileTreeRecord(db, {
        fileSourcePath: filePath,
        spacePath: '/',
        spaceFilename: 'file.txt',
        spaceId: 1,
      });

      const session = core.managers.session;
      session.set('files.localChangeBackoff', {
        baseDelay: 10,
        maxDelay: 15,
        backoffIncrement: 1,
      });

      await localFileRegistry.init();

      await generateRandomFile(filePath, 2);
      await localFileRegistry.onChangeEvent(filePath);

      await vi.waitFor(
        () => {
          expect(localFileRegistry.progressTrackers.has(filePath)).toBe(true);
        },
        { timeout: 3000, interval: 10 },
      );

      await vi.waitFor(
        () => {
          expect(localFileRegistry.progressTrackers.has(filePath)).toBe(false);
        },
        { timeout: 3000, interval: 10 },
      );

      expect(localFileRegistry.getProgressTracker(filePath)).not.toBeDefined();
    });
  });
});
