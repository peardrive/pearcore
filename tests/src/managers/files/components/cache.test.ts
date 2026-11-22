import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  cleanup,
  generateRandomFile,
  makeTempDir,
} from '../../../../helpers/general.utils.js';
import { FileHandlerCache } from '../../../../../src/managers/files/components/cache.js';

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
    const handler = await cache.acquire(testFilePath, key);

    expect(handler).toBeDefined();
    expect(typeof handler.stat).toBe('function');

    const stats = await handler.stat();
    expect(stats.size).toBeGreaterThan(0);

    const entry = cache.handlers.get(testFilePath);
    expect(entry.read.refs).toBe(1);
    expect(cache.owners.get(key)).toEqual({
      filePath: testFilePath,
      mode: 'read',
    });
  });

  it('should reuse the same handler for concurrent gets', async () => {
    const key1 = '0x1';
    const key2 = '0x2';

    const [handler1, handler2] = await Promise.all([
      cache.acquire(testFilePath, key1),
      cache.acquire(testFilePath, key2),
    ]);

    expect(handler1).toBe(handler2);

    const entry = cache.handlers.get(testFilePath);
    expect(entry.read.refs).toBe(2);
    expect(cache.owners.get(key1)).toEqual({
      filePath: testFilePath,
      mode: 'read',
    });
    expect(cache.owners.get(key2)).toEqual({
      filePath: testFilePath,
      mode: 'read',
    });
  });

  it('should throw if a key is reused for a different file', async () => {
    const key = 'sharedKey';
    const file1 = testFilePath;
    const file2 = path.join(rootDirectory, 'another');
    await generateRandomFile(file2, 1);

    await cache.acquire(file1, key);
    await expect(cache.acquire(file2, key)).rejects.toThrow(/already acquired/);
  });

  it('should drop a reference and close the handle when refCount reaches zero', async () => {
    const key = 'lastKey0x1';
    const handler = await cache.acquire(testFilePath, key);
    expect(handler).toBeDefined();

    let entry = cache.handlers.get(testFilePath);
    expect(entry.read.refs).toBe(1);

    // drop the task assigned to the key
    await cache.release(key);

    expect(cache.handlers.has(testFilePath)).toBe(false);
    expect(cache.owners.has(key)).toBe(false);
  });

  it('should keep separate read and write lanes for the same file', async () => {
    const readOwner = 'read-owner';
    const writeOwner = 'write-owner';

    const readHandler = await cache.acquire(testFilePath, readOwner);
    const writeHandler = await cache.acquire(testFilePath, writeOwner, {
      mode: 'write',
    });

    expect(readHandler).not.toBe(writeHandler);

    const entry = cache.handlers.get(testFilePath);
    expect(entry.read.refs).toBe(1);
    expect(entry.write.refs).toBe(1);

    await cache.release(readOwner);
    expect(cache.handlers.has(testFilePath)).toBe(true);

    await cache.release(writeOwner);
    expect(cache.handlers.has(testFilePath)).toBe(false);
  });

  it('should retry opening a file after a failed acquisition', async () => {
    const missingPath = path.join(rootDirectory, 'missing-file');

    await expect(cache.acquire(missingPath, 'missing-owner')).rejects.toThrow();
    expect(cache.has(missingPath)).toBe(false);
    expect(cache.owners.has('missing-owner')).toBe(false);

    await generateRandomFile(missingPath, 1);

    const handler = await cache.acquire(missingPath, 'retry-owner');
    expect(handler).toBeDefined();

    await cache.release('retry-owner');
    expect(cache.has(missingPath)).toBe(false);
  });

  it('should eject all handlers and owners for a file', async () => {
    await cache.acquire(testFilePath, 'read-owner');
    await cache.acquire(testFilePath, 'write-owner', { mode: 'write' });

    await cache.eject(testFilePath);

    expect(cache.has(testFilePath)).toBe(false);
    expect(cache.owners.size).toBe(0);
  });
});
