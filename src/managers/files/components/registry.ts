import * as EVENTS from '../../../constants/events.constants.js';
import { now } from '../../../utils/general.utils.js';
import {
  getSpace,
  getSpaceTopicHash,
  getSpaceToTopicMap,
} from '../../../utils/space.utils.js';
import {
  fileExists,
  getFileSize,
  posixPathJoin,
} from '../../../utils/system.utils.js';
import { createSpaceFileRecordSignature } from '../../../utils/protocol.utils.js';
import {
  deleteFileRecord,
  generateFileTreeRecord,
  queryFileRegistryRecords,
  getFileMetaHash,
  updateFileTreeRecord,
  getDownloadRecord,
  getFileRegistryRecord,
  type FileRegistryRecord,
} from '../../../utils/files.utils.js';
import {
  generateMerkleTree,
  getLeafCount,
  type MerkleTree,
} from '../../../utils/merkletree.utils.js';
import { createChild } from '../../../logger.js';
import { ProgressTracker } from './progress.js';
import { DEFAULT_CHUNK_SIZE } from '../../../constants/global.constants.js';
import { hex, randomNonce } from '../../../utils/crypto.utils.js';
import type { Database } from '../../../types/database.js';
import type { FileHandle } from 'node:fs/promises';
import type { EventEmitter } from 'node:events';
import type { SessionManager, FilesSession } from '../../session.manager.js';
import type { SpaceFileListManager } from '../files.manager.js';
import type { FileEventBroadcaster } from './events.js';
import type { FileHandlerCache } from './cache.js';
import type { LocalFileWatcher } from './watcher.js';

const logger = createChild('LocalFileRegistry');

/** Managers and shared state required by {@link LocalFileRegistry}. */
export interface LocalFileRegistryDependencies {
  /** Credentials, configuration and database access. */
  sessionManager: Pick<
    SessionManager,
    'getDatabase' | 'getCredentials' | 'session'
  >;
  /** Local view of the space file lists, kept in sync while indexing. */
  spaceFileListManager: Pick<SpaceFileListManager, 'add' | 'remove'>;
  /** Broadcasts file add/remove events to the space. */
  fileEventBroadcaster: Pick<FileEventBroadcaster, 'add'>;
  /** Shared handler cache used for metadata hashing and tree generation. */
  fileCache: Pick<FileHandlerCache, 'acquire' | 'release'>;
  /** Shared local-file bus; the registry subscribes to change and delete. */
  fileWatcher: Pick<
    LocalFileWatcher,
    'start' | 'add' | 'remove' | 'on' | 'off'
  >;
}

/** A space-file event before its signature is attached. */
export interface SpaceFileEventPayload {
  topic: string;
  path: string;
  publicKey: string;
  secretKey: string;
  timestamp: number;
  rootHash: string;
}

/** A space-file event with its signature attached. */
export interface SignedSpaceFileEvent extends SpaceFileEventPayload {
  signature: string;
}

/** Metadata and callbacks for indexing a new local file. */
export interface AddLocalFileParams {
  spaceId: number;
  spacePath: string;
  spaceFilename: string;
  fileSourcePath: string;
  onIndexingStart?: (tracker: ProgressTracker) => void;
  onCompletion?: (registryId: number) => void;
  onError?: (error: unknown) => void;
}

/** Identifies the registry to remove. */
export interface DeleteLocalFileParams {
  registryId: number;
}

export class LocalFileRegistry {
  emitter: Pick<EventEmitter, 'emit'>;
  sessionManager: LocalFileRegistryDependencies['sessionManager'];
  spaceFileListManager: LocalFileRegistryDependencies['spaceFileListManager'];
  fileEventBroadcaster: LocalFileRegistryDependencies['fileEventBroadcaster'];
  fileCache: LocalFileRegistryDependencies['fileCache'];
  fileWatcher: LocalFileRegistryDependencies['fileWatcher'];

  /** Detachable listeners bound to the shared file watcher. */
  onWatcherChange: (filePath: string) => void;
  onWatcherDelete: (filePath: string) => void;

  /** Pending re-indexing timers, keyed by source file path. */
  backoffStates: Map<string, { timeout: NodeJS.Timeout; delay: number }>;
  /** Source files that are currently being indexed. */
  indexingInProgress: Map<string, boolean>;
  /** Source files that changed while their indexing was still running. */
  pendingAfterIndex: Map<string, boolean>;
  /** Active progress trackers, keyed by source file path. */
  progressTrackers: Map<string, ProgressTracker>;
  /** Watcher handlers that started and have not settled yet. */
  pendingWatcherOperations: Set<Promise<void>>;

  constructor(
    emitter: Pick<EventEmitter, 'emit'>,
    {
      sessionManager,
      spaceFileListManager,
      fileEventBroadcaster,
      fileCache,
      fileWatcher,
    }: LocalFileRegistryDependencies,
  ) {
    this.emitter = emitter;
    this.sessionManager = sessionManager;
    this.spaceFileListManager = spaceFileListManager;
    this.fileEventBroadcaster = fileEventBroadcaster;
    this.fileCache = fileCache;
    this.fileWatcher = fileWatcher;

    // stable listeners so they can be detached from the shared watcher
    this.onWatcherChange = (filePath: string) => {
      this.trackWatcherOperation(this.onChangeEvent(filePath), filePath);
    };

    this.onWatcherDelete = (filePath: string) => {
      this.trackWatcherOperation(this.onDeleteEvent(filePath), filePath);
    };

    /**
     * Tracks scheduler re-indexing tasks for each file.
     * @type {Map<string, { timeout: NodeJS.Timeout, delay: number }>}
     */
    this.backoffStates = new Map();

    /**
     * Labels source files that are being actively indexed. (filepath -> state)
     * this helps the local file-change event to wait until current indexing has complete before
     * creating new process, potentially create race collision.
     * @type {Map<string, boolean>}
     */
    this.indexingInProgress = new Map();

    /**
     * Labels source files that received a file-change event while already being indexed,
     * this helps follow-up indexing pass gets scheduled once the current one finishes.
     * @type {Map<string, boolean>}
     */
    this.pendingAfterIndex = new Map();

    /**
     * Active progress trackers for in-progress file indexing, tracked by the source file path.
     * Entries are removed once indexing settles.
     * @type {Map<string, ProgressTracker>}
     */
    this.progressTrackers = new Map();

    /**
     * Handlers already running for watcher events. `stop()` drains them before
     * the session database is closed, and their failures are logged here instead
     * of surfacing as unhandled rejections.
     * @type {Set<Promise<void>>}
     */
    this.pendingWatcherOperations = new Set();
  }

  /**
   * Tracks an async watcher handler until it settles.
   *
   * `EventEmitter.emit` does not await listeners, so a rejection would otherwise
   * become an unhandled rejection. Tracking the promise also lets `stop()` wait
   * for work that started before the listeners were detached.
   *
   * @param operation - Handler promise for one watcher event.
   * @param filePath - Path that triggered the event, used for logging.
   */
  private trackWatcherOperation(
    operation: Promise<void>,
    filePath: string,
  ): void {
    const tracked = operation.catch((error) => {
      logger.warn({ filePath, error }, 'local file watcher handler failed');
    });

    this.pendingWatcherOperations.add(tracked);
    void tracked.finally(() => {
      this.pendingWatcherOperations.delete(tracked);
    });
  }

  get db(): Database {
    return this.sessionManager.getDatabase().db!;
  }

  /**
   * Account credentials required to sign space-file events. Indexing is only
   * reachable while an account is authenticated, so missing credentials are a
   * programming error rather than a recoverable state.
   */
  get credentials(): { publicKey: string; secretKey: string } {
    const { publicKey, secretKey } = this.sessionManager.getCredentials();

    if (!publicKey || !secretKey) {
      throw new Error('Missing credentials for local file registry');
    }

    return { publicKey, secretKey };
  }

  get backoffConfig(): FilesSession['localChangeBackoff'] {
    const config = this.sessionManager.session.get('files.localChangeBackoff');

    if (!config) {
      throw new Error('Missing files.localChangeBackoff configuration');
    }

    return config as FilesSession['localChangeBackoff'];
  }

  /**
   * Get progressTracker instance for active file-indexing process.
   * @param sourceFilePath - the local file path.
   */
  getProgressTracker(sourceFilePath: string) {
    return this.progressTrackers.get(sourceFilePath);
  }

  /**
   * Creates a unique owner token for a cached file handler.
   * @param filePath - the local file path.
   */
  createFileOwner(filePath: string) {
    return `registry:${filePath}:${hex(randomNonce())}`;
  }

  /**
   * Run a callback with a cached read handler for the file.
   * @param filePath - the local file path.
   * @param callback - callback receiving the file handler.
   */
  async withFileHandler<T>(
    filePath: string,
    callback: (handler: FileHandle) => Promise<T>,
  ): Promise<T> {
    const owner = this.createFileOwner(filePath);
    const handler = await this.fileCache.acquire(filePath, owner);

    try {
      return await callback(handler);
    } finally {
      await this.fileCache.release(owner);
    }
  }

  /**
   * Generate a Merkle tree from an already acquired file handler.
   * @param handler - the cached file handler.
   * @param size - file size in bytes.
   * @param [onLeaf] - optional leaf progress callback.
   */
  async generateTreeFromHandler(
    handler: FileHandle,
    size: number,
    onLeaf?: (leafHash: Uint8Array, leafIndex: number) => void,
  ): Promise<MerkleTree> {
    const stream = handler.createReadStream({
      highWaterMark: DEFAULT_CHUNK_SIZE,
      autoClose: false,
      start: 0,
    });

    try {
      return await generateMerkleTree({
        stream,
        size,
        onLeaf,
      });
    } finally {
      if (stream && !stream.destroyed) {
        await stream.destroy();
      }
    }
  }

  /**
   * Creates and adds signature to the event using public and secret keys.
   * @param event - The event object containing the record metadata.
   * @param event.topic - The space topic hash associated with the record.
   * @param event.path - The file path within the space.
   * @param event.publicKey - The public key used for signature.
   * @param event.secretKey - The secret key used for signature.
   * @param event.timestamp - The timestamp when the event was created.
   * @param event.rootHash - The root hash of the space file.
   */
  async createSignedEvent(
    event: SpaceFileEventPayload,
  ): Promise<SignedSpaceFileEvent> {
    const signature = await createSpaceFileRecordSignature(event);
    return { ...event, signature };
  }

  async init() {
    const { publicKey, secretKey } = this.credentials;
    const spaceTopicMap = await getSpaceToTopicMap(this.db);
    const records = await queryFileRegistryRecords(this.db, {});

    // this code groups file regisries by the sourceFilePath
    // which helps to avoid recomputing Merkle tree for identical files.
    const groups = records.reduce((map, rec) => {
      const key = rec.fileSourcePath;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(rec);
      return map;
    }, new Map<string, FileRegistryRecord[]>());

    const sourcePaths: string[] = [];

    for (const [sourcePath, registries] of groups) {
      // delete the registry if the local file does not exists anymore
      const sourceFileExists = await fileExists(sourcePath);
      if (!sourceFileExists) {
        for (const registry of registries) {
          await deleteFileRecord(this.db, registry.id);
        }

        continue;
      }

      const downloadPendingRegistries: FileRegistryRecord[] = [];
      const settledRegistries: FileRegistryRecord[] = [];

      for (const registry of registries) {
        const downloadRecord = await getDownloadRecord(this.db, registry.id);
        if (downloadRecord) {
          downloadPendingRegistries.push(registry);
        } else {
          settledRegistries.push(registry);
        }
      }

      const pendingCount = downloadPendingRegistries.length;
      const settledCount = settledRegistries.length;

      if (pendingCount > 0) {
        if (settledCount > 0) {
          // raise awarness about potential conflict between local registries and pending downloads fight over same file source
          logger.warn(
            {
              sourcePath,
              downloadIds: downloadPendingRegistries.map((r) => r.id),
              registryIds: settledRegistries.map((r) => r.id),
            },
            `Conflict: ${pendingCount} pending downloads and ${settledCount} settled registeries share the same path`,
          );
        }

        if (pendingCount > 1) {
          // raise awareness about potential conflict between multiple pending downloads using same file source
          logger.warn(
            {
              sourcePath,
              downloadIds: downloadPendingRegistries.map((r) => r.id),
            },
            `Conflict: ${pendingCount} pending downloads share same path`,
          );
        }

        continue;
      }

      // checking the current meta hash against the registry
      // ensures that the file hasn't been modified.
      let currentMetaHash: string;
      let tree: MerkleTree | null = null;
      let rootHash: string;

      try {
        const result = await this.withFileHandler(
          sourcePath,
          async (handler) => {
            const metaHash = await getFileMetaHash(handler);
            const batchRequireUpdate = registries.some(
              (reg) => reg.metaHash !== metaHash,
            );

            if (!batchRequireUpdate) {
              return { metaHash, tree: null };
            }

            // calculate the Merkle tree once
            const size = await getFileSize(sourcePath);
            const leafCount = getLeafCount(size, DEFAULT_CHUNK_SIZE);
            const tracker = new ProgressTracker({ total: leafCount });

            this.progressTrackers.set(sourcePath, tracker);

            try {
              const tree = await this.generateTreeFromHandler(
                handler,
                size,
                () => {
                  tracker.record('local');
                },
              );

              return { metaHash, tree };
            } finally {
              this.progressTrackers.delete(sourcePath);
            }
          },
        );

        currentMetaHash = result.metaHash;
        tree = result.tree;
        rootHash = tree ? tree.rootHash : registries[0].rootHash;
      } catch (error) {
        // skip the registry group if reading file has failed.
        logger.warn({ sourcePath, error }, 'generating new tree failed');

        continue;
      }

      if (tree) {
        for (const reg of registries) {
          await updateFileTreeRecord(this.db, {
            registryId: reg.id,
            metaHash: currentMetaHash,
            tree: tree,
          });
        }
      }

      for (const registry of registries) {
        const spaceFilePath = posixPathJoin(
          registry.spacePath,
          registry.spaceFilename,
        );
        const spaceTopicHash = spaceTopicMap.get(registry.spaceId)!;

        const record = await this.createSignedEvent({
          topic: spaceTopicHash,
          path: spaceFilePath,
          publicKey,
          secretKey,
          timestamp: now(),
          rootHash,
        });

        // add the record to the local file list
        this.spaceFileListManager.add(record);
        // advertise the registry to the space
        this.fileEventBroadcaster.add(EVENTS.SpaceFileEventOptions.ADD, record);
      }

      sourcePaths.push(sourcePath);
    }

    await this.fileWatcher.start(sourcePaths);

    // detach first so a repeated init does not register duplicate listeners
    this.fileWatcher.off('change', this.onWatcherChange);
    this.fileWatcher.off('delete', this.onWatcherDelete);
    this.fileWatcher.on('change', this.onWatcherChange);
    this.fileWatcher.on('delete', this.onWatcherDelete);
  }

  /**
   * Add a new file registry for a local file.
   * @param params
   * @param params.spaceId - ID of the space
   * @param params.spacePath - Path within the space (directory)
   * @param params.spaceFilename - Filename within the space
   * @param params.fileSourcePath - Absolute local file path
   * @param params.onIndexingStart - optional callback once the file-indexing has begun.
   * @param params.onCompletion - optional callback once the file indexing has been complete locally.
   * @param params.onError - optional callback once an error has been thrown.
   */
  async add(params: AddLocalFileParams) {
    const {
      spaceId,
      spacePath,
      spaceFilename,
      fileSourcePath,
      onIndexingStart,
      onCompletion,
      onError,
    } = params;

    try {
      const exists = await fileExists(fileSourcePath);
      if (!exists) {
        throw new Error(`File does not exists: ${fileSourcePath}`);
      }

      const existingRecords = await queryFileRegistryRecords(this.db, {
        spaceId: spaceId,
        spacePath: spacePath,
        spaceFilename: spaceFilename,
        fileSourcePath: fileSourcePath,
      });

      if (existingRecords.length > 0) {
        throw new Error(`Registry already exists`);
      }

      const space = await getSpace(this.db, spaceId);
      if (!space) {
        throw new Error(`Space not found with id: ${spaceId}`);
      }

      const size = await getFileSize(fileSourcePath);
      const leafCount = getLeafCount(size, DEFAULT_CHUNK_SIZE);
      const tracker = new ProgressTracker({ total: leafCount });

      this.progressTrackers.set(fileSourcePath, tracker);

      let registryId: number;
      let rootHash: string;
      try {
        onIndexingStart?.(tracker);

        const { metaHash, tree } = await this.withFileHandler(
          fileSourcePath,
          async (handler) => {
            const metaHash = await getFileMetaHash(handler);
            const tree = await this.generateTreeFromHandler(
              handler,
              size,
              () => {
                tracker.record('local');
              },
            );

            return { metaHash, tree };
          },
        );

        const result = await generateFileTreeRecord(this.db, {
          fileSourcePath: fileSourcePath,
          spacePath: spacePath,
          spaceFilename: spaceFilename,
          spaceId: spaceId,
          tree: tree,
          metaHash: metaHash,
        });

        registryId = result.registryId;
        rootHash = result.rootHash;

        this.fileWatcher.add(fileSourcePath);
      } finally {
        this.progressTrackers.delete(fileSourcePath);
      }

      const { publicKey, secretKey } = this.credentials;
      const spaceTopicHash = getSpaceTopicHash(space);
      const spaceFilePath = posixPathJoin(spacePath, spaceFilename);

      const record = await this.createSignedEvent({
        topic: spaceTopicHash,
        path: spaceFilePath,
        publicKey,
        secretKey,
        timestamp: now(),
        rootHash,
      });

      this.spaceFileListManager.add(record);
      this.fileEventBroadcaster.add(EVENTS.SpaceFileEventOptions.ADD, record);

      // trigger completion callback
      onCompletion?.(registryId);

      return registryId;
    } catch (error) {
      onError?.(error);
    }
  }

  /**
   * Delete a registry and remove associated resources.
   * @param params
   * @param params.registryId - ID of the registry to delete
   */
  async delete(params: DeleteLocalFileParams) {
    const { registryId } = params;
    const registry = await getFileRegistryRecord(this.db, registryId);

    if (!registry) {
      throw new Error(`Registry ${registryId} not found`);
    }

    await deleteFileRecord(this.db, registryId);
    // check if there are other registries using the same fileSourcePath
    const remainingRegistries = await queryFileRegistryRecords(this.db, {
      fileSourcePath: registry.fileSourcePath,
    });

    if (remainingRegistries.length === 0) {
      this.fileWatcher.remove(registry.fileSourcePath);
    }

    const { publicKey, secretKey } = this.credentials;
    const space = await getSpace(this.db, registry.spaceId);
    if (!space) return;
    const spaceFilePath = posixPathJoin(
      registry.spacePath,
      registry.spaceFilename,
    );

    const record = await this.createSignedEvent({
      topic: getSpaceTopicHash(space),
      path: spaceFilePath,
      publicKey,
      secretKey,
      timestamp: now(),
      rootHash: registry.rootHash,
    });

    this.spaceFileListManager.remove(record);
    this.fileEventBroadcaster.add(EVENTS.SpaceFileEventOptions.REMOVE, record);
  }

  async stop() {
    // the watcher is shared, so only detach this component's listeners
    this.fileWatcher.off('change', this.onWatcherChange);
    this.fileWatcher.off('delete', this.onWatcherDelete);

    // let handlers that started before detaching finish while the database is open
    while (this.pendingWatcherOperations.size > 0) {
      await Promise.allSettled([...this.pendingWatcherOperations]);
    }

    for (const [filePath, entry] of this.backoffStates.entries()) {
      clearTimeout(entry.timeout);
    }

    this.backoffStates.clear();
    this.pendingAfterIndex.clear();
    this.indexingInProgress.clear();
    this.progressTrackers.clear();
  }

  async onChangeEvent(filePath: string) {
    const exists = await fileExists(filePath);
    if (!exists) return;

    const { publicKey, secretKey } = this.credentials;
    const registeries = await queryFileRegistryRecords(this.db, {
      fileSourcePath: filePath,
    });

    if (registeries.length === 0) return;

    const sourceHashDownloadRecord = await getDownloadRecord(
      this.db,
      registeries[0].id,
    );
    if (sourceHashDownloadRecord) return;

    const currentMetaHash = await this.withFileHandler(
      filePath,
      async (handler) => await getFileMetaHash(handler),
    );
    if (currentMetaHash === registeries[0].metaHash) return;

    this.emitter.emit(EVENTS.LocalFileChange, filePath);
    this.scheduleFileIndexing(filePath);

    for (const registry of registeries) {
      const space = await getSpace(this.db, registry.spaceId);

      if (space) {
        const spaceTopicHash = getSpaceTopicHash(space);
        const spaceFilePath = posixPathJoin(
          registry.spacePath,
          registry.spaceFilename,
        );

        const record = await this.createSignedEvent({
          topic: spaceTopicHash,
          path: spaceFilePath,
          publicKey,
          secretKey,
          timestamp: now(),
          rootHash: registeries[0].rootHash,
        });

        // remove the old record into local file list
        this.spaceFileListManager.remove(record);
        // broadcast the removal to the network
        this.fileEventBroadcaster.add(
          EVENTS.SpaceFileEventOptions.REMOVE,
          record,
        );
      }
    }
  }

  async onDeleteEvent(filePath: string) {
    const schedule = this.backoffStates.get(filePath);
    if (schedule) {
      clearTimeout(schedule.timeout);
      this.backoffStates.delete(filePath);
    }

    const exists = await fileExists(filePath);
    if (exists) return; // avoid deletion if the file still exists; rare condition.

    const { publicKey, secretKey } = this.credentials;

    const registeries = await queryFileRegistryRecords(this.db, {
      fileSourcePath: filePath,
    });

    if (registeries.length === 0) return;

    const sourceHashDownloadRecord = await getDownloadRecord(
      this.db,
      registeries[0].id,
    );
    if (sourceHashDownloadRecord) return;

    this.emitter.emit(EVENTS.LocalFileDetele, filePath);

    for (const registry of registeries) {
      await deleteFileRecord(this.db, registry.id);

      const space = await getSpace(this.db, registry.spaceId);

      if (space) {
        const spaceTopicHash = getSpaceTopicHash(space);
        const spaceFilePath = posixPathJoin(
          registry.spacePath,
          registry.spaceFilename,
        );

        const record = await this.createSignedEvent({
          topic: spaceTopicHash,
          path: spaceFilePath,
          publicKey,
          secretKey,
          timestamp: now(),
          rootHash: registry.rootHash,
        });

        this.spaceFileListManager.remove(record);
        this.fileEventBroadcaster.add(
          EVENTS.SpaceFileEventOptions.REMOVE,
          record,
        );
      }
    }
  }

  /**
   * Schedule and re-schedules the indexing task for a file-change.
   */
  scheduleFileIndexing(filePath: string) {
    const inProcess = this.indexingInProgress.get(filePath);
    if (inProcess) {
      this.pendingAfterIndex.set(filePath, true);
      return;
    }

    const existing = this.backoffStates.get(filePath);
    let scheduleDelay = 0;

    if (existing) {
      clearTimeout(existing.timeout);
      scheduleDelay = existing.delay + this.backoffConfig.backoffIncrement;
    } else {
      scheduleDelay = this.backoffConfig.baseDelay;
    }

    const updatedSchduleDelay = Math.min(
      scheduleDelay,
      this.backoffConfig.maxDelay,
    );

    const timeout = setTimeout(
      () => this.processFileIndex(filePath),
      updatedSchduleDelay,
    );

    this.backoffStates.set(filePath, { timeout, delay: updatedSchduleDelay });
  }

  /**
   * Compute new Merkle tree and update registeries, creates new file-events and broadcasts to the network.
   * @param filePath
   */
  async processFileIndex(filePath: string) {
    const inProcess = this.indexingInProgress.get(filePath);
    if (inProcess) {
      this.pendingAfterIndex.set(filePath, true);
      return;
    }

    this.indexingInProgress.set(filePath, true);
    this.backoffStates.delete(filePath);

    try {
      const exists = await fileExists(filePath);
      if (!exists) return;

      const { publicKey, secretKey } = this.credentials;

      const registeries = await queryFileRegistryRecords(this.db, {
        fileSourcePath: filePath,
      });
      if (registeries.length === 0) return;

      const downloadRecord = await getDownloadRecord(
        this.db,
        registeries[0].id,
      );
      if (downloadRecord) return;

      let currentMetaHash: string;
      let tree: MerkleTree | null;

      try {
        const result = await this.withFileHandler(filePath, async (handler) => {
          const metaHash = await getFileMetaHash(handler);
          if (metaHash === registeries[0].metaHash) {
            return { metaHash, tree: null };
          }

          const size = await getFileSize(filePath);
          const leafCount = getLeafCount(size, DEFAULT_CHUNK_SIZE);
          const tracker = new ProgressTracker({ total: leafCount });

          this.progressTrackers.set(filePath, tracker);

          try {
            const tree = await this.generateTreeFromHandler(
              handler,
              size,
              () => {
                tracker.record('local');
              },
            );

            return { metaHash, tree };
          } finally {
            this.progressTrackers.delete(filePath);
          }
        });

        currentMetaHash = result.metaHash;
        tree = result.tree;
      } catch (error) {
        logger.error(
          { filePath, error },
          'Generating Merkle tree failed during scheduled indexing',
        );
        return;
      }

      if (!tree) return;

      for (const registry of registeries) {
        await updateFileTreeRecord(this.db, {
          registryId: registry.id,
          metaHash: currentMetaHash,
          tree: tree,
        });

        const space = await getSpace(this.db, registry.spaceId);

        if (space) {
          const spaceTopicHash = getSpaceTopicHash(space);
          const spaceFilePath = posixPathJoin(
            registry.spacePath,
            registry.spaceFilename,
          );

          const record = await this.createSignedEvent({
            topic: spaceTopicHash,
            path: spaceFilePath,
            publicKey,
            secretKey,
            timestamp: now(),
            rootHash: tree.rootHash,
          });

          // remove the old record and re-add with new rootHash into local file list
          this.spaceFileListManager.remove(record);
          this.spaceFileListManager.add(record);
          // advertise the updated registry to the space
          // the new timestamp will forcefully remove the old record from other nodes
          this.fileEventBroadcaster.add(
            EVENTS.SpaceFileEventOptions.ADD,
            record,
          );
        }
      }
    } catch (error) {
      logger.error({ filePath, error }, 'Indexing local file registry failed');
    } finally {
      this.indexingInProgress.delete(filePath);

      const pending = this.pendingAfterIndex.get(filePath);
      if (pending) {
        this.pendingAfterIndex.delete(filePath);
        this.scheduleFileIndexing(filePath);
      }
    }
  }
}
