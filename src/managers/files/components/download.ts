import * as EVENTS from '../../../constants/events.constants.js';
import { isDefined } from '../../../utils/general.utils.js';
import { getSpace, getSpaceTopicHash } from '../../../utils/space.utils.js';
import { fileExists, posixPathJoin } from '../../../utils/system.utils.js';
import {
  getFileRegistryRecord,
  getFileTreeRecord,
  getTemporarySourcePathForSpaceFile,
  createDownloadRecord,
  setDownloadAsComplete,
} from '../../../utils/files.utils.js';
import { parseFilePath } from '../../../utils/parsers.utils.js';
import { createChild } from '../../../logger.js';
import { hex, hash } from '../../../utils/crypto.utils.js';
import { ProviderList } from './providers.js';
import { SpaceTreePuller } from './trees.js';
import { LeafDeliveryScheduler } from './scheduler.js';
import { SequentialWriter } from './writer.js';
import { ProgressTracker } from './progress.js';

const logger = createChild('SpaceDownloadTask');

export class SpaceDownloadTask {
  [key: string]: any;

  constructor(emitter: any, managers: any) {
    this.emitter = emitter;
    this.sessionManager = managers.sessionManager;
    this.spaceFileListManager = managers.spaceFileListManager;
    this.messageManager = managers.messageManager;
    this.socketManager = managers.socketManager;
    this.connectionManager = managers.connectionManager;
    this.fileCache = managers.fileCache;

    // state
    this.downloadComplete = false;
    this._onCompleteCallback = null;

    // identity
    this.registryId = null;
    this.spaceId = null;
    this.topic = null;
    this.spaceFilePath = null;
    this.rootHash = null;
    this.finalDestination = null;
    this.key = null;

    // file / tree
    this.tempFilePath = null;
    this.tree = null;
    this.leafCount = null;
    this.nextExpectedLeaf = 0;

    this.downloadComplete = false;
    this.heartbeatTimer = null;
    this._heartbeatRunning = false;

    this._onProviderEvent = null;
    this._onTreeResponse = null;
    this._onHashList = null;

    this.providerList = null;
    this.puller = null;
    this.scheduler = null;
    this.writer = null;
  }

  get db() {
    return this.sessionManager.getDatabase().db;
  }

  get session() {
    return this.sessionManager.session;
  }

  get heartbeatIntervalMs() {
    return this.session.get('download.heatbeatInterval');
  }

  /**
   * Set the download key used to route incoming stream chunks to this task.
   * @param key - 24-char hex string.
   */
  setKey(key: string) {
    this.key = key;
  }

  getKey() {
    return this.key;
  }

  get fileOwner() {
    return this.key ? `download:${this.key}` : null;
  }

  /**
   * Acquire the shared write handler for the temporary file.
   */
  async acquireFileHandler() {
    if (!this.fileOwner) {
      throw new Error('Download key is not set');
    }

    return await this.fileCache.acquire(this.tempFilePath, this.fileOwner, {
      mode: 'write',
    });
  }

  /**
   * Release the shared write handler for the temporary file.
   */
  async releaseFileHandler() {
    if (!this.fileOwner) return;

    await this.fileCache.release(this.fileOwner);
  }

  _buildStack() {
    this.providerList = new ProviderList({
      spaceFileListManager: this.spaceFileListManager,
      topic: this.topic,
      spaceFilePath: this.spaceFilePath,
      rootHash: this.rootHash,
      onDrop: (publicKey) => this.scheduler.releaseProvider(publicKey),
    });

    this.puller = new SpaceTreePuller({
      sessionManager: this.sessionManager,
      socketManager: this.socketManager,
      messageManager: this.messageManager,
      connectionManager: this.connectionManager,
      topic: this.topic,
      spaceFilePath: this.spaceFilePath,
      rootHash: this.rootHash,
    });

    this.scheduler = new LeafDeliveryScheduler({
      sessionManager: this.sessionManager,
      socketManager: this.socketManager,
      messageManager: this.messageManager,
      connectionManager: this.connectionManager,
      providerList: this.providerList,
      topic: this.topic,
      spaceFilePath: this.spaceFilePath,
      downloadKey: this.key,
    });

    this.tracker = new ProgressTracker({ total: this.leafCount });
  }

  /**
   * Resume a download from a previously persisted download record.
   * @param record
   * @param record.finalDestination - Final destination path for the downloaded file.
   * @param record.lastPushedLeaf - The last pushed leaf into the file.
   * @param record.registryId - The file registry ID
   */
  async setRecord(record: any) {
    const { finalDestination, lastPushedLeaf, registryId } = record;

    const registry = await getFileRegistryRecord(this.db, registryId);
    if (!registry) {
      throw new Error('Registry not found for the download record');
    }

    const space = await getSpace(this.db, registry.spaceId);
    if (!space) {
      throw new Error(
        `Registry ${registry.id} references unknown space ${registry.spaceId}`,
      );
    }

    const exists = await fileExists(registry.fileSourcePath);
    if (!exists) {
      throw new Error(
        `Temporary file missing for download resume: ${registry.fileSourcePath}`,
      );
    }

    this.registryId = registryId;
    this.spaceId = registry.spaceId;
    this.topic = getSpaceTopicHash(space);
    this.spaceFilePath = posixPathJoin(
      registry.spacePath,
      registry.spaceFilename,
    );
    this.rootHash = registry.rootHash;
    this.tempFilePath = registry.fileSourcePath;
    this.finalDestination = finalDestination;
    this.leafCount = registry.leafCount;
    this.nextExpectedLeaf = lastPushedLeaf + 1;

    // reuse the cached tree only if it still matches what the registry expects
    const savedTree = await getFileTreeRecord(this.db, registryId);
    if (isDefined(savedTree) && savedTree.rootHash === registry.rootHash) {
      this.tree = savedTree;
      this.leafCount = savedTree.leafCount;
    }

    const fileHandler = await this.acquireFileHandler();

    this._buildStack();

    this.tracker.seed(this.nextExpectedLeaf);

    this.writer = new SequentialWriter({
      db: this.db,
      registryId: this.registryId,
      fileHandler,
      nextExpectedLeaf: this.nextExpectedLeaf,
      leafCount: this.leafCount,
    });

    if (this.tree) {
      this.scheduler.seed(this.nextExpectedLeaf, this.leafCount - 1);
    }
  }

  /**
   * Start a brand new download.
   * @param params
   * @param params.space - The space record object
   * @param params.spaceFilePath - The virtual file path inside space
   * @param params.rootHash - root hash of the file
   * @param params.finalDestination - Final destination path for the downloaded file
   */
  async setTask({ space, spaceFilePath, rootHash, finalDestination }: any) {
    this.spaceId = space.id;
    this.topic = getSpaceTopicHash(space);
    this.spaceFilePath = spaceFilePath;
    this.rootHash = rootHash;
    this.finalDestination = finalDestination;

    const { directory, username } = this.sessionManager.getAccount();
    this.tempFilePath = getTemporarySourcePathForSpaceFile({
      root: directory,
      username,
      spaceFilePath,
      rootHash,
      topic: this.topic,
    });

    this.nextExpectedLeaf = 0;

    this._buildStack();
    // SequentialWriter cannot be initialized yet
    // due to lack of tree information.
    // the instance will be created once tree data has been received
    this.writer = null;
  }

  async start() {
    if (!this.spaceFilePath || !this.rootHash) {
      throw new Error(
        'Task initialization failed. Call setRecord() or setTask() first.',
      );
    }

    this._onProviderEvent = () => this.providerList.refresh();
    this._onTreeResponse = ({ message }: any) =>
      this.onTreeResponse(message).catch((err: unknown) => logger.warn(err));
    this._onHashList = (context: any) =>
      this.onSpaceHashList(context).catch((err: unknown) => logger.warn(err));

    this.emitter.on(EVENTS.SpaceFileEvent, this._onProviderEvent);
    this.emitter.on(EVENTS.SpaceFileTreeResponse, this._onTreeResponse);
    this.emitter.on(EVENTS.SpaceHashList, this._onHashList);

    this.providerList.refresh();

    await this.heartbeat();
    this.heartbeatTimer = setInterval(
      () => this.heartbeat(),
      this.heartbeatIntervalMs,
    );
  }

  async stop() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this._onProviderEvent) {
      this.emitter.off(EVENTS.SpaceFileEvent, this._onProviderEvent);
      this.emitter.off(EVENTS.SpaceFileTreeResponse, this._onTreeResponse);
      this.emitter.off(EVENTS.SpaceHashList, this._onHashList);
      this._onProviderEvent = null;
      this._onTreeResponse = null;
      this._onHashList = null;
    }

    await this.writer?.close();
    await this.releaseFileHandler();
  }

  /**
   * Event handlers for SpaceHashList messages received from providers.
   * @param params
   * @param params.message - Received SpaceHashList message
   * @param params.topics - Provider's subscribed topics
   */
  async onSpaceHashList({ message, topics }: any) {
    if (!this.providerList.has(message.publicKey)) return;
    if (!topics.includes(this.topic)) return;

    const info = this.providerList.get(message.publicKey);
    if (this.puller.shouldRequest(message.publicKey, info, this.leafCount)) {
      await this.puller.request(message.publicKey);
    }
  }

  /**
   * Event handler for SpaceFileTreeResponse message received from providers/
   * @param message - Received SpaceFileTreeResponse message
   */
  async onTreeResponse(message: any) {
    const result = this.puller.verify(message);
    if (!result.succeed) return;

    const { publicKey, tree, lastRequestableLeaf } = result;
    this.providerList.setAdvertisedLeaf(publicKey, lastRequestableLeaf);

    if (!this.tree) {
      await this.adoptTree(tree);
    }

    this.scheduler.assign();
  }

  /**
   * Creates the internal download record and seed the download task.
   * @param tree - Merkle tree received from SpaceFileTreeRequest response.
   */
  async adoptTree(tree: any) {
    this.tree = tree;
    const height = tree.levels.length - 1;
    this.leafCount = tree.levels[height].length;

    this.tracker.setTotal(this.leafCount);
    this.tracker.seed(this.nextExpectedLeaf);

    if (!this.registryId) {
      const parsed = parseFilePath(this.spaceFilePath);
      const { registryId } = await createDownloadRecord(this.db, {
        tempFilePath: this.tempFilePath,
        finalDestination: this.finalDestination,
        spaceId: this.spaceId,
        spacePath: parsed.dir,
        spaceFilename: parsed.filename,
        rootHash: this.rootHash,
        leafCount: this.leafCount,
        height,
      });

      this.registryId = registryId;
    }

    const fileHandler =
      this.writer?.fileHandler ?? (await this.acquireFileHandler());

    if (!this.writer) {
      this.writer = new SequentialWriter({
        db: this.db,
        registryId: this.registryId,
        fileHandler,
        nextExpectedLeaf: this.nextExpectedLeaf,
        leafCount: this.leafCount,
      });
    }

    this.writer.open({
      registryId: this.registryId,
      fileHandler,
      leafCount: this.leafCount,
    });
    this.scheduler.seed(this.nextExpectedLeaf, this.leafCount - 1);
  }

  /**
   * Set the download task as finished and move the downloaded file into final destination.
   */
  async finish() {
    if (this.downloadComplete) return;
    this.downloadComplete = true;

    // release the write handler before moving the file to its final destination
    await this.writer?.close();
    await this.releaseFileHandler();

    await setDownloadAsComplete(this.db, this.registryId);
    await this.stop();

    try {
      this._onCompleteCallback?.();
    } catch (error) {} // fire and forget
  }

  /**
   * Callback for receiving incoming chunks
   * @param leafIndex
   * @param chunk
   * @param publicKey
   */
  async handleChunk(leafIndex: number, chunk: Buffer, publicKey: string) {
    if (this.downloadComplete) return;

    const height = this.tree.levels.length - 1;
    const leafHashes = this.tree.levels[height];
    const chunkHash = hex(hash(chunk));

    if (chunkHash !== leafHashes[leafIndex].hash) return;

    const staged = this.writer.stage(leafIndex, chunk);
    // if stage=false, then the count will increase contribution pecentage
    // but not the total completion percentage.
    this.tracker.record(publicKey, staged);

    if (!staged) return;

    this.scheduler.markDelivered(leafIndex);

    const { status } = await this.writer.flush();
    if (status === 'complete') {
      await this.finish();
      return;
    }

    this.scheduler.assign();
  }

  /**
   * Internal scheduled callback to process tree adoption and delivery scheduling.
   */
  async heartbeat() {
    if (this._heartbeatRunning || this.downloadComplete) return;
    this._heartbeatRunning = true;

    try {
      this.providerList.refresh();

      for (const [publicKey, info] of this.providerList.entries()) {
        if (this.puller.shouldRequest(publicKey, info, this.leafCount)) {
          await this.puller.request(publicKey);
        }
      }

      await this.scheduler.reclaimStalled();
      this.scheduler.assign();
    } catch (error) {
      console.log(error);
      logger.warn(error);
    } finally {
      this._heartbeatRunning = false;
    }
  }

  /**
   * Get snapshot of progress of the download
   *  percent: Number|null,
   *  contributions: Array<{ source: string, percent: Number }>
   * }}
   */
  getProgress() {
    return this.tracker.snapshot();
  }

  /**
   * Attach callback function to track the progress of the download
   * @param callback
   */
  onProgress(callback: (snapshot: any) => void) {
    this.tracker.on('progress', callback);
  }

  /**
   * Detach callback from tracker event emitter
   * @param callback
   */
  offProgress(callback: (snapshot: any) => void) {
    this.tracker.off('progress', callback);
  }

  /**
   * Attach callback function to track when the download completes.
   * @param callback
   */
  onComplete(callback: () => void) {
    if (this.downloadComplete) {
      callback();
      return;
    }

    this._onCompleteCallback = callback;
  }
}
