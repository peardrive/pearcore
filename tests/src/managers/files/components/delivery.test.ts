import path from 'path';
import { describe, beforeEach, afterEach, it, expect } from 'vitest';
import {
  cleanup,
  generateRandomFile,
  getMockSocket,
  makeTempDir,
} from '../../../../helpers/general.utils.js';
import { MockCoreFactory } from '../../../../helpers/mock.factory.js';
import { hex, hexToUint8, randomNonce } from '../../../../../src/utils/crypto.utils.js';

describe('FileContentDeliveryManager', () => {
  let factory: MockCoreFactory;
  let core: any;
  let rootDirectory: any;
  let testFilePath: any;
  let fileManager: any;
  let deliveryManager: any;
  let mockSocket: any;

  beforeEach(async () => {
    rootDirectory = await makeTempDir();
    testFilePath = path.join(rootDirectory, 'testfile');

    await generateRandomFile(testFilePath, 1); // 1MB

    factory = new MockCoreFactory();
    await factory.init();
    core = await factory.createCore();

    fileManager = core.managers.spaceFiles;
    deliveryManager = fileManager.deliveryManager;
    mockSocket = getMockSocket('delivery-peer');
  });

  afterEach(async () => {
    await deliveryManager.stop();
    await factory.cleanup();
    await cleanup(rootDirectory);
  });

  it('should create a task and send chunks', async () => {
    const key = hex(randomNonce());
    const startLeaf = 0;
    const endLeaf = 2;

    const taskPromise = await fileManager.createDeliveryTask({
      socket: mockSocket,
      key: key,
      filePath: testFilePath,
      startLeaf: startLeaf,
      endLeaf: endLeaf,
    });

    expect(taskPromise.succeed).toBe(true);

    const completion = await fileManager.waitForDeliveryTask(key);
    expect(completion.succeed).toBe(true);

    const calls = mockSocket.write.mock.calls;
    expect(calls.length).toBe(endLeaf + startLeaf + 1);

    const keyBuffer = hexToUint8(key);
    for (let index = 0; index < calls.length; index++) {
      const payload = calls[index][0];
      const offset = 5 + keyBuffer.length; // frame type and length (5 bytes) + key length
      const leafIndex = payload.readUInt32BE(offset);

      expect(leafIndex).toBe(startLeaf + index);
    }

    expect(deliveryManager.fileTasks.has(testFilePath)).toBe(false);
    expect(deliveryManager.deliveryTasksByKey.has(key)).toBe(false);
    expect(fileManager.fileCache.has(testFilePath)).toBe(false);
  });

  it('should abort a task by key', async () => {
    const key = hex(randomNonce());
    const startLeaf = 0;
    const endLeaf = 100;

    const result = await fileManager.createDeliveryTask({
      socket: mockSocket,
      key,
      filePath: testFilePath,
      startLeaf,
      endLeaf,
    });

    expect(result.succeed).toBe(true);

    await new Promise((resolve) => setImmediate(resolve));
    fileManager.abortDeliveryTask(key);

    const completion = await fileManager.waitForDeliveryTask(key);
    expect(completion.succeed).toBe(false);
    expect(completion.reason).toMatch(/aborted/i);

    expect(deliveryManager.fileTasks.has(testFilePath)).toBe(false);
    expect(deliveryManager.deliveryTasksByKey.has(key)).toBe(false);
    expect(fileManager.fileCache.has(testFilePath)).toBe(false);

    const calls = mockSocket.write.mock.calls;
    expect(calls.length).not.toBe(startLeaf + endLeaf + 1);
  });

  it('should only abort a task for the peer that requested it', async () => {
    const key = hex(randomNonce());
    const owner = 'a'.repeat(64);
    const stranger = 'b'.repeat(64);

    await fileManager.createDeliveryTask({
      socket: mockSocket,
      key,
      publicKey: owner,
      filePath: testFilePath,
      startLeaf: 0,
      endLeaf: 100,
    });

    const [task] = deliveryManager.deliveryTasksByKey.get(key);

    fileManager.abortDeliveryTask(key, stranger);
    expect(task.controller.signal.aborted).toBe(false);

    fileManager.abortDeliveryTask(key, owner);
    expect(task.controller.signal.aborted).toBe(true);

    await fileManager.waitForDeliveryTask(key);
  });

  it('should abort all tasks for a file path on LocalFileChange event', async () => {
    const key1 = hex(randomNonce());
    const key2 = hex(randomNonce());
    const startLeaf = 0;
    const endLeaf = 50;

    const [result1, result2] = await Promise.all([
      fileManager.createDeliveryTask({
        socket: mockSocket,
        key: key1,
        filePath: testFilePath,
        startLeaf,
        endLeaf,
      }),
      fileManager.createDeliveryTask({
        socket: mockSocket,
        key: key2,
        filePath: testFilePath,
        startLeaf,
        endLeaf,
      }),
    ]);

    expect(result1.succeed).toBe(true);
    expect(result2.succeed).toBe(true);

    await new Promise((resolve) => setImmediate(resolve));
    // artificially trigger a local file change on the shared watcher bus
    fileManager.fileWatcher.emit('change', testFilePath);

    const [comp1, comp2] = await Promise.all([
      fileManager.waitForDeliveryTask(key1),
      fileManager.waitForDeliveryTask(key2),
    ]);

    expect(comp1.succeed).toBe(false);
    expect(comp2.succeed).toBe(false);
    expect(comp1.reason).toMatch(/aborted/i);
    expect(comp2.reason).toMatch(/aborted/i);

    expect(deliveryManager.fileTasks.has(testFilePath)).toBe(false);
    expect(deliveryManager.deliveryTasksByKey.has(key1)).toBe(false);
    expect(deliveryManager.deliveryTasksByKey.has(key2)).toBe(false);
    expect(fileManager.fileCache.has(testFilePath)).toBe(false);
  });
});
