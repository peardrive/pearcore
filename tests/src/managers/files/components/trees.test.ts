import path from 'path';
import * as EVENTS from '../../../../../src/constants/events.constants.js';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { MockCoreFactory } from '../../../../helpers/mock.factory.js';
import { cleanup, generateRandomFile, makeTempDir } from '../../../../helpers/general.utils.js';
import { waitForEvent } from '../../../../helpers/file.test.utils.js';
import {
  generateFileTreeRecord,
  getFileRegistryRecord,
} from '../../../../../src/utils/files.utils.js';
import { SpaceTreePuller } from '../../../../../src/managers/files/components/trees.js';

describe('SpaceTreePuller', () => {
  const SPACE_FILE_PATH = '/shared.txt';

  let factory: any;
  let primaryCore: any;
  let secondaryCore: any;
  let space: any;

  // file related variables
  let temporaryDirectory: any;
  let filePath: any;
  let rootHash: any;
  let leafCount: any;

  let puller: any;

  beforeEach(async () => {
    factory = new MockCoreFactory();
    await factory.init();

    primaryCore = await factory.createCore();
    secondaryCore = await factory.createCore();

    space = await secondaryCore.space.create({ spaceName: 'tree-puller' });
    // wait for primaryCore to connect with secondary
    await factory.condition(
      async (core: any, success: (value?: any) => void) => {
        core.emitter.once(EVENTS.SpaceSync, () => success());
        await core.space.join(space.sharelink);
      },
      { excludeIndices: [1], timeout: 5000 },
    );

    temporaryDirectory = await makeTempDir();
    filePath = path.join(temporaryDirectory, 'shared.txt');

    await generateRandomFile(filePath, 1); // 1MB

    const db = primaryCore.managers.session.getDatabase().db;
    const { registryId } = await generateFileTreeRecord(db, {
      fileSourcePath: filePath,
      spacePath: '/',
      spaceFilename: 'shared.txt',
      spaceId: space.id,
    });

    const registry = (await getFileRegistryRecord(db, registryId))!;
    rootHash = registry.rootHash;
    leafCount = registry.leafCount;

    puller = new SpaceTreePuller({
      sessionManager: secondaryCore.managers.session,
      socketManager: secondaryCore.managers.sockets,
      messageManager: secondaryCore.managers.message,
      connectionManager: secondaryCore.managers.connection,
      topic: space.topicHash,
      spaceFilePath: SPACE_FILE_PATH,
      rootHash,
    });
  });

  afterEach(async () => {
    await factory.cleanup();
    await cleanup(temporaryDirectory);
  });

  it('should send SpaceFileTreeRequest and mark the peer as pending', async () => {
    await puller.request(primaryCore.publicKey);
    expect(puller.isPending(primaryCore.publicKey)).toBe(true);
  });

  it('should ask to connect and record nothing for a peer with no active connection', async () => {
    const isolatedCore = await factory.createCore('isolated');
    const connectSpy = vi.spyOn(puller.connectionManager, 'connectWith');

    await puller.request(isolatedCore.publicKey);

    expect(connectSpy).toHaveBeenCalledOnce();
    expect(puller.isPending(isolatedCore.publicKey)).toBe(false);
  });

  it('should verify a genuine tree response from the provider', async () => {
    const responsePromise = waitForEvent(
      secondaryCore,
      EVENTS.SpaceFileTreeResponse,
    );

    await puller.request(primaryCore.publicKey);
    const { message } = await responsePromise;
    const result = puller.verify(message);

    expect(result.succeed).toBe(true);
    expect(result.publicKey).toBe(primaryCore.publicKey);
    expect(result.tree.rootHash).toBe(rootHash);
    expect(result.lastRequestableLeaf).toBe(leafCount);
    expect(puller.isPending(primaryCore.publicKey)).toBe(false);
  });

  describe('shouldRequest', () => {
    it('should return false while a request is already pending for that peer', async () => {
      await puller.request(primaryCore.publicKey);
      expect(puller.shouldRequest(primaryCore.publicKey, undefined, null)).toBe(
        false,
      );
    });

    it('should return true when there is no info at all for the peer', () => {
      expect(puller.shouldRequest(primaryCore.publicKey, undefined, 10)).toBe(
        true,
      );
    });

    it('should return true when the leaf count is not known yet', () => {
      expect(
        puller.shouldRequest(
          primaryCore.publicKey,
          { lastRequestableLeaf: 5 },
          null,
        ),
      ).toBe(true);
    });

    it('should return true for a partial provider (advertised leaf below leafCount - 1)', () => {
      expect(
        puller.shouldRequest(
          primaryCore.publicKey,
          { lastRequestableLeaf: 5 },
          10,
        ),
      ).toBe(true);
    });
  });
});
