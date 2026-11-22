import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { MockCoreFactory } from '../../../../helpers/mock.factory.js';
import { now } from '../../../../../src/utils/general.utils.js';
import { ProviderList } from '../../../../../src/managers/files/components/providers.js';

describe('ProviderList', () => {
  const SPACE_FILE_PATH = '/doc.txt';
  const ROOT_HASH = 'hash01';
  const TOPIC = 'topic1';

  let factory: MockCoreFactory;
  let publicKey: any;
  let spaceFileListManager: any;
  let onDrop: any;
  let providerList: any;

  beforeEach(async () => {
    factory = new MockCoreFactory();
    await factory.init();
    const core = await factory.createCore();

    onDrop = vi.fn();
    publicKey = core.publicKey;
    spaceFileListManager = core.managers.spaceFileList;
    providerList = new ProviderList({
      spaceFileListManager: spaceFileListManager,
      topic: TOPIC,
      spaceFilePath: SPACE_FILE_PATH,
      rootHash: ROOT_HASH,
      onDrop: onDrop,
    });
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  it('should add a new provider with an unkown lastRequestableLeaf', () => {
    spaceFileListManager.add({
      topic: TOPIC,
      path: SPACE_FILE_PATH,
      rootHash: ROOT_HASH,
      timestamp: now(),
      signature: 'abc',
      publicKey,
    });

    providerList.refresh();
    expect(providerList.has(publicKey)).toBe(true);
    expect(providerList.get(publicKey)).toEqual({
      lastRequestableLeaf: undefined,
    });
  });

  it('should not add provider from another file or rootHash', () => {
    spaceFileListManager.add({
      topic: TOPIC,
      path: 'random1',
      rootHash: ROOT_HASH,
      timestamp: now(),
      signature: 'abc',
      publicKey,
    });

    spaceFileListManager.add({
      topic: TOPIC,
      path: SPACE_FILE_PATH,
      rootHash: 'random2',
      timestamp: now(),
      signature: 'abc',
      publicKey,
    });

    providerList.refresh();

    expect([...providerList.peers()].length).toBe(0);
  });

  it('should add every peer listed for the space file', () => {
    spaceFileListManager.add({
      topic: TOPIC,
      path: SPACE_FILE_PATH,
      rootHash: ROOT_HASH,
      timestamp: now(),
      signature: 'abc',
      publicKey: 'A1',
    });

    spaceFileListManager.add({
      topic: TOPIC,
      path: SPACE_FILE_PATH,
      rootHash: ROOT_HASH,
      timestamp: now(),
      signature: 'abc',
      publicKey: 'A2',
    });

    providerList.refresh();
    providerList.setAdvertisedLeaf('A1', 10);

    expect([...providerList.peers()]).toEqual(['A1', 'A2']);
    expect(providerList.get('A1').lastRequestableLeaf).toBe(10);
  });

  it('should drop a provider that is no longer listed and call onDrop', () => {
    spaceFileListManager.add({
      topic: TOPIC,
      path: SPACE_FILE_PATH,
      rootHash: ROOT_HASH,
      timestamp: now(),
      signature: 'abc',
      publicKey: 'A1',
    });

    providerList.refresh();

    spaceFileListManager.remove({
      topic: TOPIC,
      path: SPACE_FILE_PATH,
      rootHash: ROOT_HASH,
      publicKey: 'A1',
    });

    providerList.refresh();
    expect(providerList.has('A1')).toBe(false);
    expect(onDrop).toHaveBeenCalledOnce();
  });
});
