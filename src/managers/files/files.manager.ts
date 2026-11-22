import { createChild } from '../../logger.js';
import { listDownloadRecords } from '../../utils/files.utils.js';
import { parseFilePath } from '../../utils/parsers.utils.js';
import { hex, randomNonce } from '../../utils/crypto.utils.js';
import { FileEventBroadcaster } from './components/events.js';
import { LocalFileRegistry } from './components/registry.js';
import { SpaceDownloadTask } from './components/download.js';
import { FileHandlerCache } from './components/cache.js';
import { FileContentDeliveryManager } from './components/delivery.js';
import { LocalFileWatcher } from './components/watcher.js';

const logger = createChild('FileManager');
const entries = (value: any): Array<[string, any]> => Object.entries(value);

export class SpaceFileListManager {
  [key: string]: any;

  constructor(emitter: any, managers: any) {
    this.sessionManager = managers.sessionManager;

    this.spaceFileMap = {};
  }

  /**
   * Get space's file list using space topic hash
   * @param topic
   */
  get(topic: string): any {
    return this.spaceFileMap[topic] || {};
  }

  clear() {
    this.spaceFileMap = {};
  }

  /**
   * Convert the list structure for into a stack (flat array).
   * @param spaceFiles - Space file list.
   */
  convertListToStack(spaceFiles: any): any[] {
    const stack: any[] = [];

    for (const [filepath, variants] of entries(spaceFiles)) {
      for (const [rootHash, variant] of entries(variants)) {
        const peers = variant.peers || {};
        for (const [publicKey, info] of entries(peers)) {
          const { timestamp, signature } = info;

          stack.push([filepath, publicKey, timestamp, rootHash, signature]);
        }
      }
    }

    return stack;
  }

  /**
   * Convert a stack (flat array) into a list structure for a given topic.
   * @param stack - File entries to convert.
   */
  convertStackToList(stack: any[]): any {
    const fileList: any = {};

    for (const entry of stack) {
      const [filepath, publicKey, timestamp, rootHash, signature] = entry;

      if (!fileList[filepath]) fileList[filepath] = {};
      if (!fileList[filepath][rootHash]) {
        fileList[filepath][rootHash] = { peers: {} };
      }

      const variant = fileList[filepath][rootHash];
      const existing = variant.peers[publicKey];

      if (!existing || timestamp > existing.timestamp) {
        variant.peers[publicKey] = { timestamp, signature };
      }
    }

    return fileList;
  }

  /**
   * Returns a copy of the topic's file list containing only the entries
   * for which `filter` returns `true`. The returned structure matches
   * `get(topic)`.
   *
   * @param topic - Space topic hash.
   * @param filter - Predicate applied to each record.
   */
  query(topic: string, filter: (record: any) => boolean): any {
    const spaceFiles = this.spaceFileMap[topic];
    if (!spaceFiles) return {};

    const result: any = {};

    for (const [path, variants] of entries(spaceFiles)) {
      for (const [rootHash, variant] of entries(variants)) {
        const peers = variant.peers || {};

        for (const [publicKey, info] of entries(peers)) {
          const record = {
            topic,
            path,
            rootHash,
            publicKey,
            timestamp: info.timestamp,
            signature: info.signature,
          };

          if (!filter(record)) continue;

          if (!result[path]) {
            result[path] = {};
          }
          if (!result[path][rootHash]) {
            result[path][rootHash] = { peers: {} };
          }

          result[path][rootHash].peers[publicKey] = {
            timestamp: info.timestamp,
            signature: info.signature,
          };
        }
      }
    }

    return result;
  }

  /**
   * Add a new file registry to the space.
   * @param context
   * @param context.topic - Space topic hash
   * @param context.path - Space file path
   * @param context.rootHash - File's merkle tree root hash
   * @param context.publicKey - Peer publicKey
   * @param context.timestamp - File's action event timestamp
   */
  add(context: any) {
    const { topic, path, rootHash, publicKey, timestamp, signature } = context;

    // get space file list, create object map if not exists
    if (!this.spaceFileMap[topic]) {
      this.spaceFileMap[topic] = {};
    }
    const spaceFiles = this.spaceFileMap[topic];

    // file path does not exists in the map
    // register the path and add the provider
    if (!spaceFiles[path]) {
      spaceFiles[path] = {
        [rootHash]: {
          peers: { [publicKey]: { timestamp, signature } },
        },
      };

      return;
    }

    const variants = spaceFiles[path];

    // remove the peer as provider of other variants of the file path
    for (const [existingRootHash, variant] of entries(variants)) {
      if (existingRootHash !== rootHash && publicKey in variant.peers) {
        // avoid the action if local timestamp is newer
        const currentTimestamp = variant.peers[publicKey].timestamp;
        if (currentTimestamp >= timestamp) return;

        delete variant.peers[publicKey];

        if (Object.keys(variant.peers).length === 0) {
          delete variants[existingRootHash];
        }

        break;
      }
    }

    if (!variants[rootHash]) {
      variants[rootHash] = {
        peers: { [publicKey]: { timestamp, signature } },
      };

      return;
    }

    const variant = variants[rootHash];
    const existingEntry = variant.peers[publicKey];

    if (existingEntry && existingEntry.timestamp >= timestamp) return;

    // update the provider registry timestamp
    variant.peers[publicKey] = { timestamp, signature };
  }

  /**
   * Remove publicKey as a provider for file path
   * @param context
   * @param context.topic - Space topic hash
   * @param context.path - Space file path
   * @param context.publicKey - Peer publicKey
   */
  remove(context: any) {
    const { topic, path, publicKey } = context;
    const spaceFiles = this.spaceFileMap[topic];
    if (!spaceFiles) return;

    const variants = spaceFiles[path];
    if (!variants) return;

    for (const [rootHash, variant] of entries(variants)) {
      if (publicKey in variant.peers) {
        delete variant.peers[publicKey];

        // delete the variant if no provider has left after delettion
        if (Object.keys(variant.peers).length === 0) {
          delete variants[rootHash];
        }

        break;
      }
    }

    // cleanup file path if no variant has been left
    if (Object.keys(variants).length === 0) {
      delete spaceFiles[path];
    }

    // remove topic from the map if left empty
    if (Object.keys(spaceFiles).length === 0) {
      delete this.spaceFileMap[topic];
    }
  }

  /**
   * Merge external space file list with the internal record.
   * @param context
   * @param context.topic - Space topic hash.
   * @param context.fileList - External space file list for merge
   */
  merge(context: any) {
    const { topic, fileList } = context;
    const { publicKey: localPublicKey } = this.sessionManager.getCredentials();

    for (const [path, variants] of entries(fileList)) {
      for (const [rootHash, variant] of entries(variants)) {
        // skip if the provider list is empty
        if (!variant.peers) continue;

        for (const [publicKey, info] of entries(variant.peers)) {
          const { timestamp, signature } = info;
          // add the provider registry only if it's foreign publicKey
          if (publicKey !== localPublicKey) {
            this.add({
              topic,
              path,
              rootHash,
              publicKey,
              timestamp,
              signature,
            });
          }
        }
      }
    }
  }

  diff(context: any): any {
    const { topic, fileList, mode = 'add' } = context;
    const { publicKey: localPublicKey } = this.sessionManager.getCredentials();

    const localSpace = this.spaceFileMap[topic] || {};

    const diffResult: any = {};

    for (const [path, remoteVariants] of entries(fileList)) {
      const localPath = localSpace[path];

      for (const [rootHash, remoteVariant] of entries(remoteVariants)) {
        const localVariant = localPath?.[rootHash];
        const remotePeers = remoteVariant.peers || {};

        const relevantPeers: any = {};

        for (const [publicKey, remoteInfo] of entries(remotePeers)) {
          if (publicKey === localPublicKey) continue;

          const localPeerInfo = localVariant?.peers?.[publicKey];
          const localTimestamp = localPeerInfo?.timestamp ?? null;

          if (mode === 'add') {
            // include only if peer is missing or remote timestamp is newer
            if (!localPeerInfo || remoteInfo.timestamp > localTimestamp) {
              relevantPeers[publicKey] = { ...remoteInfo };
            }
          }

          if (mode === 'remove') {
            if (localPeerInfo && remoteInfo.timestamp > localTimestamp) {
              relevantPeers[publicKey] = { ...remoteInfo };
            }
          }
        }

        if (Object.keys(relevantPeers).length > 0) {
          // create the file path object if not already exists
          if (!diffResult[path]) {
            diffResult[path] = {};
          }
          diffResult[path][rootHash] = { peers: relevantPeers };
        }
      }
    }

    return diffResult;
  }
}

export class SpaceFileManager {
  [key: string]: any;

  constructor(emitter: any, managers: any) {
    this.emitter = emitter;
    this.sessionManager = managers.sessionManager;
    this.socketManager = managers.socketManager;
    this.messageManager = managers.messageManager;
    this.connectionManager = managers.connectionManager;
    this.muxManager = managers.muxManager;
    this.spaceFileListManager = managers.spaceFileListManager;

    this.fileCache = new FileHandlerCache();
    this.fileWatcher = new LocalFileWatcher();

    this.deliveryManager = new FileContentDeliveryManager({
      sessionManager: this.sessionManager,
      muxManager: this.muxManager,
      fileCache: this.fileCache,
      fileWatcher: this.fileWatcher,
    });

    this.fileEventBroadcaster = new FileEventBroadcaster(this.emitter, {
      sessionManager: this.sessionManager,
      socketManager: this.socketManager,
      messageManager: this.messageManager,
    });

    this.localFileRegistry = new LocalFileRegistry(this.emitter, {
      sessionManager: this.sessionManager,
      spaceFileListManager: this.spaceFileListManager,
      fileEventBroadcaster: this.fileEventBroadcaster,
      fileCache: this.fileCache,
      fileWatcher: this.fileWatcher,
    });

    // key -> download task instance
    this.downloadTasks = new Map();
  }

  get db() {
    return this.sessionManager.getDatabase().db;
  }

  /**
   * Generates random 24-character hex strings as key.
   */
  generateDownloadKey() {
    return hex(randomNonce());
  }

  /**
   * Creates fresh SpaceDownloadTask instance.
   */
  createDownloadTask() {
    const task = new SpaceDownloadTask(this.emitter, {
      sessionManager: this.sessionManager,
      spaceFileListManager: this.spaceFileListManager,
      messageManager: this.messageManager,
      socketManager: this.socketManager,
      connectionManager: this.connectionManager,
      fileEventBroadcaster: this.fileEventBroadcaster,
      fileCache: this.fileCache,
    });

    return task;
  }

  /**
   * Get SpaceDownloadTask instance using key.
   * @param key
   */
  getDownloadTask(key: string) {
    return this.downloadTasks.get(key);
  }

  /**
   * Creates a new file-content delivery task.
   * @param params - Delivery task parameters.
   */
  async createDeliveryTask(params: any) {
    return await this.deliveryManager.createTask(params);
  }

  /**
   * Wait for a file-content delivery task to finish.
   * @param key - Delivery task key.
   */
  async waitForDeliveryTask(key: string) {
    return await this.deliveryManager.waitForTask(key);
  }

  /**
   * Abort file-content delivery tasks for a key.
   * @param key - Delivery task key.
   * @param [publicKey=null] - When given, only tasks requested by this peer are aborted.
   */
  abortDeliveryTask(key: string, publicKey: string | null = null) {
    this.deliveryManager.abortTask(key, publicKey);
  }

  async init() {
    await this.deliveryManager.init();
    await this.localFileRegistry.init();

    const downloads = await listDownloadRecords(this.db);
    for (const task of downloads) {
      const spaceDownloadTask = this.createDownloadTask();
      // create and assign the download key to the task to be used for requests.
      const downloadKey = this.generateDownloadKey();
      spaceDownloadTask.setKey(downloadKey);
      // assign the instance to key in order to map incomming streams to dedicated task instance
      this.downloadTasks.set(downloadKey, spaceDownloadTask);
      // load the download record and start the task.
      await spaceDownloadTask.setRecord(task);
      await spaceDownloadTask.start();
    }
  }

  /**
   * Add new file to local file registry.
   * @param space
   * @param space.id
   * @param spaceFilePath
   * @param fileSourcePath
   * @param options
   * @param options.onIndexingStart - optional callback to trigger when the indexing starts
   * @param options.onComplete - optional callback to trigger when the indexing completed locally.
   */
  async addLocalFile(
    space: any,
    spaceFilePath: string,
    fileSourcePath: string,
    options: any,
  ) {
    const parsed = parseFilePath(spaceFilePath);

    const registryId = await this.localFileRegistry.add({
      spaceId: space.id,
      spacePath: parsed.dir,
      spaceFilename: parsed.filename,
      fileSourcePath: fileSourcePath,
      onIndexingStart: options.onIndexingStart,
      onCompletion: options.onComplete,
      onError: options.onError,
    });

    return registryId;
  }

  /**
   * Remove local file registry.
   * @param registryId - Local file registry ID
   */
  async removeLocalFile(registryId: number) {
    await this.localFileRegistry.delete({ registryId });
  }

  /**
   * Creates new download task.
   * @param space - Space object instance including ID.
   * @param spaceFilePath - Full space file path.
   * @param rootHash - Root hash of space file's Merkle tree.
   * @param finalDestination - Final local destination path for the downloaded file.
   */
  async download(
    space: any,
    spaceFilePath: string,
    rootHash: string,
    finalDestination: string,
  ) {
    const spaceDownloadTask = this.createDownloadTask();

    const key = this.generateDownloadKey();
    this.downloadTasks.set(key, spaceDownloadTask);
    spaceDownloadTask.setKey(key);

    await spaceDownloadTask.setTask({
      space,
      spaceFilePath,
      rootHash,
      finalDestination,
    });

    await spaceDownloadTask.start();
    return key;
  }

  /**
   * Get progress tracker for local file indexing process.
   * @param filePath
   */
  getIndexingProgress(filePath: string) {
    return this.localFileRegistry.getProgressTracker(filePath);
  }

  /**
   * Handles icomming stream data from connections and routes them to download tasks.
   * @param socket
   * @param data
   * @param info
   */
  async handleIncomingStream(socket: any, data: Buffer, info: any) {
    const keyLength = 12; // 12 bytes
    const keyBuffer = data.subarray(0, keyLength);
    const keyHex = hex(keyBuffer);

    const task = this.downloadTasks.get(keyHex);
    if (!task) return;

    const leafIndex = data.readUInt32BE(keyLength);
    const chunk = data.subarray(keyLength + 4);

    const publicKey = hex(info.publicKey);
    await task.handleChunk(leafIndex, chunk, publicKey);
  }

  async stop() {
    await this.localFileRegistry.stop();
    await this.fileEventBroadcaster.flush();

    const tasks = this.downloadTasks.values();
    for (const task of tasks) {
      await task.stop();
    }

    this.downloadTasks.clear();

    await this.deliveryManager.stop();
    await this.fileWatcher.close();
    await this.fileCache.stop();
  }
}
