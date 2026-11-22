import type { FileHandle } from 'fs/promises';
import { closeFile, openFile, readFile } from '../../../utils/system.utils.js';

export type FileHandlerMode = 'read' | 'write';

/**
 * State for one access mode of a cached file.
 *
 * A lane owns at most one open handle, counts the owners referencing it, and
 * keeps the in-flight open promise so concurrent acquisitions share one
 * `open()` call.
 */
type FileHandlerLane = {
  /** Open handle, or `null` while opening or after being closed. */
  handle: FileHandle | null;
  /** Number of owners currently holding this lane. */
  refs: number;
  /** Shared in-flight open operation, if an open is in progress. */
  opening: Promise<FileHandle> | null;
};

/**
 * Per-file cache entry with one lane per access mode.
 *
 * Read and write lanes are tracked separately because they use different file
 * descriptors and can be held by different owners at the same time.
 */
type FileHandlerEntry = {
  read: FileHandlerLane;
  write: FileHandlerLane;
};

type OwnerRecord = {
  filePath: string;
  mode: FileHandlerMode;
};

/**
 * Shared, reference-counted cache of open file handlers.
 *
 * The cache is owned by the file manager and used by every file component that
 * needs to read or write a local source file. Handlers are opened once per file
 * and access mode, then shared between all owners until the last reference is
 * released.
 */
export class FileHandlerCache {
  handlers: Map<string, FileHandlerEntry>;
  owners: Map<string, OwnerRecord>;

  constructor() {
    // filePath -> entry
    this.handlers = new Map();
    // owner -> { filePath, mode }
    this.owners = new Map();
  }

  /**
   * Checks whether the cache currently holds a handler for the file path.
   * @param filePath - path to the file
   */
  has(filePath: string): boolean {
    return this.handlers.has(filePath);
  }

  /**
   * Number of files currently tracked by the cache.
   */
  get size(): number {
    return this.handlers.size;
  }

  /**
   * Get a shared file handler for the given path.
   *
   * @param filePath - path to the file
   * @param owner - unique owner token for the acquisition
   * @param options
   * @param options.mode - read or write access (defaults to read)
   */
  async acquire(
    filePath: string,
    owner: string,
    options: {
      mode?: FileHandlerMode;
    } = {},
  ): Promise<FileHandle> {
    const mode = options.mode ?? 'read';

    if (this.owners.has(owner)) {
      throw new Error(`Owner "${owner}" has already acquired a file handler`);
    }

    let entry = this.handlers.get(filePath);
    if (!entry) {
      entry = {
        read: { handle: null, refs: 0, opening: null },
        write: { handle: null, refs: 0, opening: null },
      };

      this.handlers.set(filePath, entry);
    }

    const lane = entry[mode];

    // increment the number of owners assigned to this lane
    lane.refs++;
    this.owners.set(owner, { filePath, mode });

    if (lane.handle) {
      return lane.handle;
    }

    // reuse an in-flight open so concurrent acquisitions share one descriptor
    if (!lane.opening) {
      if (mode == 'read') {
        // open in read-only mode
        lane.opening = readFile(filePath);
      } else {
        // open with write privilage
        lane.opening = openFile(filePath);
      }
    }

    const opening = lane.opening;

    try {
      const handler = await opening;

      if (lane.opening === opening) {
        lane.opening = null;
      }

      // the entry may have been ejected while the file was being opened
      if (this.handlers.get(filePath) !== entry) {
        try {
          await closeFile(handler);
        } catch (error) {} // the entry may already be closed

        throw new Error(`File handler for "${filePath}" was ejected`);
      }

      // another open may have won the race; keep the cached handle
      if (lane.handle) {
        if (lane.handle !== handler) {
          try {
            await closeFile(handler);
          } catch (error) {}
        }

        return lane.handle;
      }

      lane.handle = handler;
      return handler;
    } catch (error) {
      if (lane.opening === opening) {
        lane.opening = null;
      }

      lane.refs = Math.max(0, lane.refs - 1);
      this.owners.delete(owner);

      await this.cleanupEntry(filePath, entry);
      throw error;
    }
  }

  /**
   * Release the reference held by the given owner.
   * @param owner - unique owner token used for the acquisition
   */
  async release(owner: string): Promise<void> {
    const record = this.owners.get(owner);
    if (!record) return;

    this.owners.delete(owner);

    const entry = this.handlers.get(record.filePath);
    if (!entry) return;

    const lane = entry[record.mode];
    lane.refs = Math.max(0, lane.refs - 1);

    await this.cleanupEntry(record.filePath, entry);
  }

  /**
   * Force close all handlers for a file path and invalidate their owners.
   * @param filePath - path to the file
   */
  async eject(filePath: string): Promise<void> {
    const entry = this.handlers.get(filePath);
    if (!entry) return;

    this.handlers.delete(filePath);

    for (const [owner, record] of this.owners.entries()) {
      if (record.filePath === filePath) {
        this.owners.delete(owner);
      }
    }

    await this.closeEntry(filePath, entry);
  }

  async stop(): Promise<void> {
    const entries = [...this.handlers.entries()];

    this.handlers.clear();
    this.owners.clear();

    for (const [filePath, entry] of entries) {
      await this.closeEntry(filePath, entry);
    }
  }

  private async cleanupEntry(
    filePath: string,
    entry: FileHandlerEntry,
  ): Promise<void> {
    if (entry.read.refs > 0 || entry.write.refs > 0) return;

    if (this.handlers.get(filePath) === entry) {
      this.handlers.delete(filePath);
    }

    await this.closeEntry(filePath, entry);
  }

  private async closeEntry(
    filePath: string,
    entry: FileHandlerEntry,
  ): Promise<void> {
    const handles = [entry.read.handle, entry.write.handle].filter(
      (handle): handle is FileHandle => handle !== null,
    );

    // clear synchronously so a concurrent close sees nothing left to do
    entry.read.handle = null;
    entry.write.handle = null;

    if (handles.length === 0) return;

    let failure: unknown = null;

    for (const handle of handles) {
      try {
        await closeFile(handle);
      } catch (error) {
        failure ??= error;
      }
    }

    if (failure) {
      throw new Error(`Error closing file ${filePath}`);
    }
  }
}
