import path from 'path';
import type { SpaceInstance } from '../../space.service.js';
import { getFileRegistryRecord } from '../../../utils/files.utils.js';
import type { ProgressTracker } from '../../../managers/files/components/progress.js';

export class GenericFileEntry {
  [key: string]: any;
  _path;
  _spaceInstance;
  _spaceFileListManager;
  _spaceFileManager;
  _sessionManager;

  /**
   * @param params
   * @param params.path - virtual space file path
   * @param params.spaceInstance - Associated space for the file hierarchy
   * @param params.spaceFileListManager - the file-list manager instance
   * @param params.spaceFileManager - the file manager instance.
   */
  constructor(params: any) {
    this._path = params.path;
    this._spaceInstance = params.spaceInstance;
    this._spaceFileListManager = params.spaceFileListManager;
    this._spaceFileManager = params.spaceFileManager;
    this._sessionManager = params.sessionManager;
  }

  get name() {
    return path.basename(this._path);
  }

  get path() {
    return this._path;
  }

  get exists() {
    return this.variants.length > 0;
  }

  /**
   * Get list of all available hash variants of single space file.
   * @returns - list of hex hash strings.
   */
  get variants() {
    const topic = this._spaceInstance.topicHash;
    const records = this._spaceFileListManager.get(topic)[this._path] || {};
    return Object.keys(records);
  }

  /**
   * Get current list of providers for a given space file variant.
   * @param rootHash
   * @returns - list of provider publicKeys.
   */
  getProvidersForVariant(rootHash: string) {
    const topic = this._spaceInstance.topicHash;
    const records = this._spaceFileListManager.get(topic)[this._path] || {};
    const providersInfo = records[rootHash]?.peers || {};
    return Object.keys(providersInfo);
  }
}

/**
 * Virtual space file entry (files that are sourced from space).
 */
export class SpaceFileEntry extends GenericFileEntry {
  /**
   * Create and initiate download task for specific variant of space file.
   * @param rootHash - root hash of the file variant.
   * @param destination - local path destination to place the file.
   * @returns */
  async download(rootHash: string, destination: string) {
    if (this.exists) {
      const key = await this._spaceFileManager.download(
        this._spaceInstance,
        this._path,
        rootHash,
        destination,
      );

      const task = this._spaceFileManager.getDownloadTask(key);
      return task;
    }
  }
}

/**
 * Space file entry that is backed by a file on local disk.
 */
export class LocalFileEntry extends GenericFileEntry {
  #fileSourcePath: string;
  #registryId: number | null;
  #rootHash: string | null = null;
  #settled = false;
  #tracker: ProgressTracker | null = null;
  #error: unknown = null;
  #onIndexingCallback: ((tracker: ProgressTracker) => void) | undefined;
  #onCompletionCallback: (() => void) | undefined;
  #onErrorCallback: ((error: unknown) => void) | undefined;

  /**
   * @param params
   * @param params.path - virtual space file path
   * @param [params.registryId] - Local file registry ID.
   * @param params.spaceInstance - Associated space for the file hierarchy
   * @param params.spaceFileListManager - the file-list manager instance
   * @param params.spaceFileManager - the file manager instance
   * @param params.sessionManager
   * @param params.fileSourcePath - absolute local file path backing this entry
   * @param params.rootHash - The root hash of the local file registry.
   */
  constructor(params: any) {
    super(params);

    this.#fileSourcePath = params.fileSourcePath;
    this.#registryId = params.registryId;
    this.#tracker = params.tracker;

    if (params.rootHash) {
      this.#rootHash = params.rootHash;
      this.#settled = true;
    }
  }

  /**
   * Get local data for the file registry.
   *
   * @returns Registry record, or null when it has not been registered.
   */
  async getRegistry() {
    const { db } = this._sessionManager.getDatabase();
    if (this.#registryId === null) return null;
    const registry = await getFileRegistryRecord(db, this.#registryId);
    return registry;
  }

  async settle(registryId: number) {
    this.#registryId = registryId;
    const registry = await this.getRegistry();

    if (!registry) {
      throw new Error(`Local registry ${registryId} not found`);
    }

    this.#rootHash = registry.rootHash;
    this.#settled = true;

    return registry;
  }

  get fileSourcePath() {
    return this.#fileSourcePath;
  }

  get registryId() {
    return this.#registryId;
  }

  get rootHash() {
    return this.#rootHash;
  }

  /**
   * Get rootHash of file registry as the only variant in array (to follow `SpaceFileEntry`).
   * @returns */
  override get variants() {
    if (this.rootHash) {
      return [this.rootHash];
    }

    return [];
  }

  /**
   * Whether this node currently has its own registry broadcasted to space.
   * @returns */
  override get exists() {
    if (!this.#rootHash) {
      return false;
    }

    const { publicKey } = this._sessionManager.getCredentials();
    const providers = this.getProvidersForVariant(this.#rootHash);

    return providers.includes(publicKey);
  }

  /**
   * Remove local file registry drive.
   * @returns */
  async remove() {
    if (!this.#registryId) {
      throw new Error(
        `Cannot remove file entry for ${this._path}. registry ID is unkown`,
      );
    }

    await this._spaceFileManager.removeLocalFile(this.#registryId);
    this.#registryId = null;
    this.#rootHash = null;
    this.#settled = false;
  }

  /**
   * Get current indexing progress snapshot.
   * @returns Current indexing progress snapshot.
   */
  get indexingProgress() {
    return this.#tracker?.snapshot();
  }

  /**
   * Set indexing event emitter for the entry.
   * @param tracker
   */
  setIndexingTracker(tracker: ProgressTracker) {
    this.#tracker = tracker;
    if (this.#onIndexingCallback) {
      tracker.on('progress', this.#onIndexingCallback);
    }
  }

  /**
   * Listen to local file indexing event.
   * @param callback
   */
  onIndexing(callback: (result: any) => void) {
    this.#onIndexingCallback = callback;
    this.#tracker?.on('progress', callback);
  }

  offIndexingCallback() {
    if (this.#tracker) {
      if (this.#onIndexingCallback) {
        this.#tracker.off('progress', this.#onIndexingCallback);
      }
    }
  }

  /**
   * Triggers callback for `onComplete()`
   */
  triggerCompletion() {
    return this.#onCompletionCallback?.();
  }

  /**
   * Listen to local file indexing completion event
   * @param callback
   */
  onComplete(callback: () => void) {
    if (this.#settled) {
      callback();
      return;
    }

    this.#onCompletionCallback = callback;
  }

  /**
   *
   * @param error
   */
  triggerError(error: unknown) {
    this.#onErrorCallback?.(error);
    this.#error = error;
  }

  /**
   * Listen to this entry's indexing failure. Fires immediately if it already failed.
   * @param callback
   */
  onError(callback: (result: any) => void) {
    if (this.#error) {
      callback(this.#error);
    }

    this.#onErrorCallback = callback;
  }
}
