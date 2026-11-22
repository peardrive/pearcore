import { EventEmitter } from 'node:events';
import { createWatcher, WatchTypes } from '../../../utils/files.utils.js';

export type LocalFileEvent = 'change' | 'delete';

/** Listener invoked with the absolute path of the affected file. */
export type LocalFileEventListener = (filePath: string) => void | Promise<void>;

/**
 * Shared event bus between the OS file watcher and the file components.
 *
 * `LocalFileWatcher` owns the chokidar watcher, normalizes its platform events
 * into a small typed contract, and re-emits them to every subscriber. File
 * components therefore depend on this bus instead of chokidar or the global
 * core emitter, and a single watcher serves the whole file manager.
 *
 * @example
 * const watcher = new LocalFileWatcher();
 * watcher.on('change', (filePath) => { ... });
 * await watcher.start(['/path/to/file']);
 */
export class LocalFileWatcher extends EventEmitter {
  private watcher: ReturnType<typeof createWatcher> | null;
  private paths: Set<string>;

  constructor() {
    super();
    this.watcher = null;
    this.paths = new Set();
  }

  /** Whether the underlying OS watcher has been created. */
  get started(): boolean {
    return this.watcher !== null;
  }

  /** Paths currently registered for watching. */
  get watchedPaths(): string[] {
    return [...this.paths];
  }

  /**
   * Check whether a path is registered for watching.
   * @param filePath - absolute path of the file
   */
  isWatching(filePath: string): boolean {
    return this.paths.has(filePath);
  }

  /**
   * Start watching the given paths.
   *
   * Safe to call more than once: paths are added to the existing watcher and
   * already-watched paths are ignored.
   *
   * @param paths - absolute paths of the files to watch
   */
  async start(paths: string[] = []): Promise<void> {
    this.setupWatcher();

    for (const filePath of paths) {
      await this.add(filePath);
    }
  }

  /**
   * Add a path to the watch list.
   * @param filePath - absolute path of the file
   */
  add(filePath: string): void {
    if (this.paths.has(filePath)) return;

    this.paths.add(filePath);
    if (this.watcher) {
      this.watcher.add(filePath);
      return;
    }
  }

  /**
   * Stop watching a path. The watcher keeps running for the remaining paths.
   * @param filePath - absolute path of the file
   */
  remove(filePath: string): void {
    if (!this.paths.delete(filePath)) return;

    this.watcher?.unwatch(filePath);
  }

  /** Close the underlying watcher and drop every subscription. */
  async close(): Promise<void> {
    if (!this.watcher) return;

    this.watcher.removeAllListeners();
    await this.watcher.close();

    this.watcher = null;
    this.paths.clear();
  }

  override on(event: LocalFileEvent, listener: LocalFileEventListener): this {
    return super.on(event, listener);
  }

  override off(event: LocalFileEvent, listener: LocalFileEventListener): this {
    return super.off(event, listener);
  }

  /**
   * Create the chokidar watcher on first use and forward its raw events as the
   * typed `change` / `delete` events of this bus.
   */
  private setupWatcher(): ReturnType<typeof createWatcher> {
    if (this.watcher) return this.watcher;

    const watcher = createWatcher([]);

    watcher.on(WatchTypes.CHANGE, (filePath: string) => {
      this.emit('change', filePath);
    });

    watcher.on(WatchTypes.DELETE, (filePath: string) => {
      this.emit('delete', filePath);
    });

    this.watcher = watcher;
    return watcher;
  }
}
