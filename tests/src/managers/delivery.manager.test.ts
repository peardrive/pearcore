import * as EVENTS from '../../../src/constants/events.constants.js';
import path from 'path';
import { describe, beforeEach, afterEach, it, expect } from 'vitest';
import {
  cleanup,
  generateRandomFile,
  getMockSocket,
  makeTempDir,
} from '../../helpers/general.utils.js';
import { MockCoreFactory } from '../../helpers/mock.factory.js';
import { FileHandlerCache } from '../../../src/managers/delivery.manager.js';
import { hex, hexToUint8, randomNonce } from '../../../src/utils/crypto.utils.js';

describe('FileHandlerCache', () => {
  let rootDirectory: any;
  let testFilePath: any;
  let cache: any;

  beforeEach(async () => {
    rootDirectory = await makeTempDir();
    testFilePath = path.join(rootDirectory, 'testfile');

    await generateRandomFile(testFilePath, 2); // 2MB
    cache = new FileHandlerCache();
  });

  afterEach(async () => {
    await cache.stop();
    await cleanup(rootDirectory);
  });

  it('should open a file and return a handler', async () => {
    const key = 'x01';
    const handler = await cache.get(testFilePath, key);

    expect(handler).toBeDefined();
    expect(typeof handler.stat).toBe('function');

    const stats = await handler.stat();
    expect(stats.size).toBeGreaterThan(0);

    const entry = cache.handlers.get(testFilePath);
    expect(entry.refCount).toBe(1);
    expect(cache.keyToPath.get(key)).toBe(testFilePath);
  });

  it('should reuse the same handler for concurrent gets', async () => {
    const key1 = '0x1';
    const key2 = '0x2';

    const [handler1, handler2] = await Promise.all([
      cache.get(testFilePath, key1),
      cache.get(testFilePath, key2),
    ]);

    expect(handler1).toBe(handler2);

    const entry = cache.handlers.get(testFilePath);
    expect(entry.refCount).toBe(2);
    expect(cache.keyToPath.get(key1)).toBe(testFilePath);
    expect(cache.keyToPath.get(key2)).toBe(testFilePath);
  });

  it('should throw if a key is reused for a different file', async () => {
    const key = 'sharedKey';
    const file1 = testFilePath;
    const file2 = path.join(rootDirectory, 'another');
    await generateRandomFile(file2, 1);

    await cache.get(file1, key);
    await expect(cache.get(file2, key)).rejects.toThrow(/already associated/);
  });

  it('should drop a reference and close the handle when refCount reaches zero', async () => {
    const key = 'lastKey0x1';
    const handler = await cache.get(testFilePath, key);
    expect(handler).toBeDefined();

    let entry = cache.handlers.get(testFilePath);
    expect(entry.refCount).toBe(1);

    // drop the task assigned to the key
    await cache.drop(key);

    expect(cache.handlers.has(testFilePath)).toBe(false);
    expect(cache.keyToPath.has(key)).toBe(false);
  });
});

describe('FileContentDeliveryManager', () => {
  let factory: MockCoreFactory;
  let core: any;
  let rootDirectory: any;
  let testFilePath: any;
  let manager: any;
  let deliveryManager: any;
  let mockSocket: any;

  beforeEach(async () => {
    rootDirectory = await makeTempDir();
    testFilePath = path.join(rootDirectory, 'testfile');

    await generateRandomFile(testFilePath, 1); // 1MB

    factory = new MockCoreFactory();
    await factory.init();
    core = await factory.createCore();

    manager = core.managers;
    deliveryManager = manager.delivery;
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

    const taskPromise = await deliveryManager.createTask({
      socket: mockSocket,
      key: key,
      filePath: testFilePath,
      startLeaf: startLeaf,
      endLeaf: endLeaf,
    });

    expect(taskPromise.succeed).toBe(true);

    const completion = await deliveryManager.waitForTask(key);
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
    expect(deliveryManager.fileCache.handlers.has(testFilePath)).toBe(false);
  });

  it('should abort a task by key', async () => {
    const key = hex(randomNonce());
    const startLeaf = 0;
    const endLeaf = 100;

    const result = await deliveryManager.createTask({
      socket: mockSocket,
      key,
      filePath: testFilePath,
      startLeaf,
      endLeaf,
    });

    expect(result.succeed).toBe(true);

    await new Promise((resolve) => setImmediate(resolve));
    deliveryManager.abortTask(key);

    const completion = await deliveryManager.waitForTask(key);
    expect(completion.succeed).toBe(false);
    expect(completion.reason).toMatch(/aborted/i);

    expect(deliveryManager.fileTasks.has(testFilePath)).toBe(false);
    expect(deliveryManager.deliveryTasksByKey.has(key)).toBe(false);
    expect(deliveryManager.fileCache.handlers.has(testFilePath)).toBe(false);

    const calls = mockSocket.write.mock.calls;
    expect(calls.length).not.toBe(startLeaf + endLeaf + 1);
  });

  it('should only abort a task for the peer that requested it', async () => {
    const key = hex(randomNonce());
    const owner = 'a'.repeat(64);
    const stranger = 'b'.repeat(64);

    await deliveryManager.createTask({
      socket: mockSocket,
      key,
      publicKey: owner,
      filePath: testFilePath,
      startLeaf: 0,
      endLeaf: 100,
    });

    const [task] = deliveryManager.deliveryTasksByKey.get(key);

    deliveryManager.abortTask(key, stranger);
    expect(task.controller.signal.aborted).toBe(false);

    deliveryManager.abortTask(key, owner);
    expect(task.controller.signal.aborted).toBe(true);

    await deliveryManager.waitForTask(key);
  });

  it('should abort all tasks for a file path on LocalFileChange event', async () => {
    const key1 = hex(randomNonce());
    const key2 = hex(randomNonce());
    const startLeaf = 0;
    const endLeaf = 50;

    const [result1, result2] = await Promise.all([
      deliveryManager.createTask({
        socket: mockSocket,
        key: key1,
        filePath: testFilePath,
        startLeaf,
        endLeaf,
      }),
      deliveryManager.createTask({
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
    // artifically trigger file-change event
    core.emitter.emit(EVENTS.LocalFileChange, testFilePath);

    const [comp1, comp2] = await Promise.all([
      deliveryManager.waitForTask(key1),
      deliveryManager.waitForTask(key2),
    ]);

    expect(comp1.succeed).toBe(false);
    expect(comp2.succeed).toBe(false);
    expect(comp1.reason).toMatch(/aborted/i);
    expect(comp2.reason).toMatch(/aborted/i);

    expect(deliveryManager.fileTasks.has(testFilePath)).toBe(false);
    expect(deliveryManager.deliveryTasksByKey.has(key1)).toBe(false);
    expect(deliveryManager.deliveryTasksByKey.has(key2)).toBe(false);
    expect(deliveryManager.fileCache.handlers.has(testFilePath)).toBe(false);
  });
});
