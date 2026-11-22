import path from 'path';
import { createReadStream } from 'fs';
import * as EVENTS from '../../../../../src/constants/events.constants.js';
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { MockCoreFactory } from '../../../../helpers/mock.factory.js';
import { cleanup, generateRandomFile, makeTempDir } from '../../../../helpers/general.utils.js';
import { waitForEvent } from '../../../../helpers/file.test.utils.js';
import {
  createFileStream,
  closeFile,
  getFileSize,
} from '../../../../../src/utils/system.utils.js';
import { generateMerkleTree } from '../../../../../src/utils/merkletree.utils.js';
import { parseFilePath } from '../../../../../src/utils/parsers.utils.js';

describe('SpaceDownloadTask', () => {
  const SPACE_FILE_PATH = '/document.txt';
  let factory: any;
  let providerCore: any, downloaderCore: any;
  let space: any;
  let temporaryDirectory: any;
  let providerFilePath: any, downloadFinalPath: any;
  let rootHash: any;
  let tree: any;

  beforeAll(async () => {
    factory = new MockCoreFactory();
    await factory.init();

    providerCore = await factory.createCore('provider');
    downloaderCore = await factory.createCore('downloader');

    space = await providerCore.space.create({ spaceName: 'download-space' });

    // let provider and the primary cores connect
    await new Promise((resolve) => {
      downloaderCore.emitter.once(EVENTS.SpaceSync, resolve);
      downloaderCore.space.join(space.sharelink);
    });

    temporaryDirectory = await makeTempDir();
    providerFilePath = path.join(temporaryDirectory, 'source.bin');
    downloadFinalPath = path.join(temporaryDirectory, 'downloaded.bin');

    await generateRandomFile(providerFilePath, 1); // 1MB

    // generate the original Merkle tree for the source file
    const size = await getFileSize(providerFilePath);
    const stream = createFileStream(providerFilePath);
    tree = await generateMerkleTree({ stream, size });
    rootHash = tree.rootHash;

    // create the local file registry for the provider
    const parsed = parseFilePath(SPACE_FILE_PATH);
    // index and broadcast the local file
    await providerCore.managers.spaceFiles.localFileRegistry.add({
      spaceId: space.id,
      spacePath: parsed.dir,
      spaceFilename: parsed.filename,
      fileSourcePath: providerFilePath,
    });

    await waitForEvent(downloaderCore, EVENTS.SpaceFileEvent);
  });

  afterAll(async () => {
    await factory.cleanup();
    await cleanup(temporaryDirectory);
  });

  beforeEach(async () => {
    const downloadTasks = downloaderCore.managers.spaceFiles.downloadTasks;
    for (const [key, task] of downloadTasks) {
      await task.stop();
    }
    downloadTasks.clear();

    const session = downloaderCore.managers.session;
    session.set('download.heartbeatInterval', 200);
    session.set('download.requestTimeout', 500);
    // small to force multiple requests
    session.set('download.assignedChunkSize', 2);
    session.set('files.broadcastThrottleTime', 0);
  });

  it('should throw if start is called before setTask or setRecord', async () => {
    const spaceFileManager = downloaderCore.managers.spaceFiles;
    const task = spaceFileManager.createDownloadTask();
    await expect(task.start()).rejects.toThrow(
      'Task initialization failed. Call setRecord() or setTask() first.',
    );
  });

  it('should successfully download a file from a provider', async () => {
    const spaceFileManager = downloaderCore.managers.spaceFiles;

    const key = await spaceFileManager.download(
      space,
      SPACE_FILE_PATH,
      rootHash,
      downloadFinalPath,
    );
    const downloadTask = spaceFileManager.downloadTasks.get(key);

    await vi.waitFor(
      () => {
        expect(downloadTask.downloadComplete).toBe(true);
      },
      { timeout: 5000, interval: 100 },
    );

    const size = await getFileSize(downloadFinalPath);
    const handler = await createReadStream(downloadFinalPath);
    const { rootHash: finalRootHash } = await generateMerkleTree({
      stream: handler,
      size,
    });

    await closeFile(handler as any);

    const progress = downloadTask.getProgress();
    expect(finalRootHash).toBe(rootHash);
    expect(progress.percent).toBe(100);
  });
});
