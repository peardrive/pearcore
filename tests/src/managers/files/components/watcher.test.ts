import path from 'path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import {
  cleanup,
  generateRandomFile,
  makeTempDir,
} from '../../../../helpers/general.utils.js';
import { LocalFileWatcher } from '../../../../../src/managers/files/components/watcher.js';

describe('LocalFileWatcher', () => {
  let rootDirectory: any;
  let filePath: any;
  let watcher: LocalFileWatcher;

  beforeEach(async () => {
    rootDirectory = await makeTempDir();
    filePath = path.join(rootDirectory, 'watched.txt');
    await generateRandomFile(filePath, 1);

    watcher = new LocalFileWatcher();
  });

  afterEach(async () => {
    await watcher.close();
    await cleanup(rootDirectory);
  });

  it('should not create the OS watcher before a path is registered', () => {
    expect(watcher.started).toBe(false);
    expect(watcher.watchedPaths).toEqual([]);
  });

  it('should start watching the given paths', async () => {
    await watcher.start([filePath]);

    expect(watcher.started).toBe(true);
    expect(watcher.isWatching(filePath)).toBe(true);
    expect(watcher.watchedPaths).toEqual([filePath]);
  });

  it('should not register the same path twice', async () => {
    await watcher.start([filePath]);
    await watcher.add(filePath);

    expect(watcher.watchedPaths).toEqual([filePath]);
  });

  it('should be safe to start more than once', async () => {
    await watcher.start([filePath]);
    await watcher.start([filePath]);

    expect(watcher.watchedPaths).toEqual([filePath]);
  });

  it('should stop watching a removed path but keep the watcher running', async () => {
    await watcher.start([filePath]);

    await watcher.remove(filePath);

    expect(watcher.isWatching(filePath)).toBe(false);
    expect(watcher.started).toBe(true);
  });

  it('should ignore removal of a path that is not watched', async () => {
    await watcher.start([filePath]);

    await watcher.remove(path.join(rootDirectory, 'unknown.txt'));

    expect(watcher.watchedPaths).toEqual([filePath]);
  });

  it('should re-emit OS change events', async () => {
    await watcher.start([filePath]);

    const received: string[] = [];
    watcher.on('change', (changedPath) => {
      received.push(changedPath);
    });

    (watcher as any).watcher.emit('change', filePath);

    expect(received).toEqual([filePath]);
  });

  it('should re-emit OS unlink events as delete', async () => {
    await watcher.start([filePath]);

    const received: string[] = [];
    watcher.on('delete', (deletedPath) => {
      received.push(deletedPath);
    });

    (watcher as any).watcher.emit('unlink', filePath);

    expect(received).toEqual([filePath]);
  });

  it('should close the OS watcher and forget its paths', async () => {
    await watcher.start([filePath]);

    await watcher.close();

    expect(watcher.started).toBe(false);
    expect(watcher.watchedPaths).toEqual([]);
    expect((watcher as any).watcher).toBeNull();
  });
});
