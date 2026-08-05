import * as EVENTS from '../constants/events.constants.js';
import { DEFAULT_CHUNK_SIZE } from '../constants/global.constants.js';
import { isDefined, now } from "../utils/general.utils.js";
import { getSpace, getSpaceTopicHash, getSpaceToTopicMap } from "../utils/space.utils.js";
import { closeFile, createFileStream, deleteFile, fileExists, getFileSize, openFile, pathJoin } from "../utils/system.utils.js";
import { 
    createSpaceFileEventMessage, 
    createSpaceFileRecordSignature, 
    createSpaceFileTreeRequestMessage, 
    createSpaceFileContentRequestMessage 
} from "../utils/protocol.utils.js";
import {
    deleteFileRecord,
    generateFileTreeRecord,
    getFileMetaHash,
    createWatcher,
    WatchTypes,
    queryFileRegistryRecords,
    getFileMetaHashFromSource,
    updateFileTreeRecord,
    getDownloadRecord,
    getFileRegistryRecord,
    getFileTreeRecord,
    getTemporarySourcePathForSpaceFile,
    createDownloadRecord,
    listDownloadRecords,
    setDownloadAsComplete
} from "../utils/files.utils.js";
import { generateMerkleTree } from '../utils/merkletree.utils.js';
import { parseFilePath } from '../utils/parsers.utils.js';
import { publicKeyIsAllowedToRead } from '../utils/policy.utils.js';
import { createChild } from '../logger.js';
import { hex, randomNonce } from '../utils/crypto.utils.js';

const logger = createChild('FileManager');

export class SpaceFileListManager {
    constructor(emitter, managers) {
        this.sessionManager = managers.sessionManager;

        this.spaceFileMap = {};
    }

    /**
     * Get space's file list using space topic hash
     * @param {string} topic 
     * @returns {Object}
     */
    get(topic) {
        return this.spaceFileMap[topic] || {};
    }

    clear() {
        this.spaceFileMap = {};
    }

    /**
     * Convert the list structure for into a stack (flat array).
     * @param {Object} spaceFiles - Space file list.
     * @returns {Array<Object>} Stack array of { filepath, publickey, timestamp, rootHash, signature }
     */
    convertListToStack(spaceFiles) {
        const stack = [];

        for (const [filepath, variants] of Object.entries(spaceFiles)) {

            for (const [rootHash, variant] of Object.entries(variants)) {

                const peers = variant.peers || {};
                for (const [publicKey, info] of Object.entries(peers)) {
                    const { timestamp, signature } = info;

                    stack.push([filepath, publicKey, timestamp, rootHash, signature]);
                }
            }

        }

        return stack;
    }

    /**
     * Convert a stack (flat array) into a list structure for a given topic.
     * @param {Array<Object>} stack - Stack array of { filepath, publickey, timestamp, rootHash, signature }.
     * @returns {Object} List structure ready to be used with merge() or diff().
     */
    convertStackToList(stack) {
        const fileList = {};

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
     * Add a new file registry to the space.
     * @param {Object} context 
     * @param {string} context.topic - Space topic hash
     * @param {string} context.path - Space file path
     * @param {string} context.rootHash - File's merkle tree root hash
     * @param {string} context.publicKey - Peer publicKey
     * @param {Number} context.timestamp - File's action event timestamp 
     */
    add(context) {
        const { topic, path, rootHash, publicKey, timestamp, signature } = context;

        // get space file list, create object map if not exists
        if (!this.spaceFileMap[topic]) { this.spaceFileMap[topic] = {}; }
        const spaceFiles = this.spaceFileMap[topic];

        // file path does not exists in the map
        // register the path and add the provider
        if (!spaceFiles[path]) {
            spaceFiles[path] = {
                [rootHash]: {
                    peers: { [publicKey]: { timestamp, signature } }
                }
            };

            return;
        }

        const variants = spaceFiles[path];

        // remove the peer as provider of other variants of the file path
        for (const [existingRootHash, variant] of Object.entries(variants)) {
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
                peers: { [publicKey]: { timestamp, signature } }
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
     * @param {Object} context 
     * @param {string} context.topic - Space topic hash
     * @param {string} context.path - Space file path
     * @param {string} context.publicKey - Peer publicKey
     */
    remove(context) {
        const { topic, path, publicKey } = context;
        const spaceFiles = this.spaceFileMap[topic];
        if (!spaceFiles) return;

        const variants = spaceFiles[path];
        if (!variants) return;

        for (const [rootHash, variant] of Object.entries(variants)) {
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
     * @param {Object} context 
     * @param {string} context.topic - Space topic hash.
     * @param {Object} context.fileList - External space file list for merge
     */
    merge(context) {
        const { topic, fileList } = context;
        const { publicKey: localPublicKey } = this.sessionManager.getCredentials();

        for (const [path, variants] of Object.entries(fileList)) {
            for (const [rootHash, variant] of Object.entries(variants)) {
                // skip if the provider list is empty
                if (!variant.peers) continue;

                for (const [publicKey, info] of Object.entries(variant.peers)) {
                    const { timestamp, signature } = info;
                    // add the provider registry only if it's foreign publicKey
                    if (publicKey !== localPublicKey) {
                        this.add({ topic, path, rootHash, publicKey, timestamp, signature });
                    }
                }
            }
        }
    }

    /**
     * Creates new file list that is the substraction of remote and local file list.
     * @param {Object} context 
     * @param {string} context.topic - Space topic hash.
     * @param {Object} context.fileList - External space file list for substraction
     * @returns {Object} Returns substracted file list.
     */
    diff(context) {
        const { topic, fileList, mode = 'add' } = context;
        const { publicKey: localPublicKey } = this.sessionManager.getCredentials();

        const localSpace = this.spaceFileMap[topic] || {};

        const diffResult = {};

        for (const [path, remoteVariants] of Object.entries(fileList)) {
            const localPath = localSpace[path];

            for (const [rootHash, remoteVariant] of Object.entries(remoteVariants)) {
                const localVariant = localPath?.[rootHash];
                const remotePeers = remoteVariant.peers || {};

                const relevantPeers = {};

                for (const [publicKey, remoteInfo] of Object.entries(remotePeers)) {
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
                    if (!diffResult[path]) { diffResult[path] = {}; }
                    diffResult[path][rootHash] = { peers: relevantPeers };
                }
            }
        }

        return diffResult;
    }
}

export class FileEventBroadcaster {
    constructor(emitter, { sessionManager, socketManager, messageManager }) {
        this.sessionManager = sessionManager;
        this.socketManager = socketManager;
        this.messageManager = messageManager;

        // topic -> { add: [event stack], remove: [event stack] }
        this.stack = new Map();
        this.timer = null;
    }

    get broadcastThrottleTime() {
        return this.sessionManager.session.get('files.broadcastThrottleTime') ?? 1000;
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    ensureTopicStack(topic) {
        if (!this.stack.has(topic)) {
            this.stack.set(topic, {
                [EVENTS.SpaceFileEventOptions.ADD]: [],
                [EVENTS.SpaceFileEventOptions.REMOVE]: [],
            });
        }
    }

    /**
     * Add a file event to the pending stack and (re)start the throttle timer.
     *
     * @param {'add'|'remove'} mode – exactly one of EVENTS.SpaceFileEventOptions values
     * @param {Object} params
     * @param {string} params.topic       – space topic hash
     * @param {string} params.path        – space file path
     * @param {string} params.publicKey   – provider publicKey (the local node)
     * @param {number} params.timestamp   – event timestamp
     * @param {string} params.rootHash    – file root hash
     */
    add(mode, params) {
        const { topic, path, publicKey, timestamp, rootHash, signature } = params;

        if (!Object.values(EVENTS.SpaceFileEventOptions).includes(mode)) {
            throw new Error("add mode should be defined in EVENTS.SpaceFileEventOptions");
        }

        this.ensureTopicStack(topic);
        this.stack.get(topic)[mode].push([path, publicKey, timestamp, rootHash, signature]);

        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(async () => await this.broadcast(), this.broadcastThrottleTime);
    }

    async flush() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        await this.broadcast();
    }

    async broadcast() {
        if (this.stack.size === 0) return;

        const { publicKey, secretKey } = this.sessionManager.getCredentials();
        const topicMap = await getSpaceToTopicMap(this.db);

        for (const [spaceId, topicHash] of topicMap.entries()) {
            if (!this.stack.has(topicHash)) continue;

            const eventStack = this.stack.get(topicHash);
            const space = await getSpace(this.db, spaceId);

            if (!space) continue;

            const addonEvents = eventStack[EVENTS.SpaceFileEventOptions.ADD];
            const removalEvents = eventStack[EVENTS.SpaceFileEventOptions.REMOVE];

            const messageEvents = [];

            if (addonEvents.length > 0) {
                messageEvents.push({ action: EVENTS.SpaceFileEventOptions.ADD, files: addonEvents });
            }

            if (removalEvents.length > 0) {
                messageEvents.push({ action: EVENTS.SpaceFileEventOptions.REMOVE, files: removalEvents });
            }

            if (messageEvents.length <= 0) continue;

            const message = await createSpaceFileEventMessage({
                topic: topicHash,
                events: messageEvents,
                publicKey: publicKey,
                secretKey: secretKey
            });

            const peers = this.socketManager.getPeerKeys(
                publicKey => publicKeyIsAllowedToRead(publicKey, space)
            );

            const sockets = this.socketManager.getConnectedSockets({ peers: peers, topics: [topicHash] });
            await this.messageManager.broadcastMessageToSockets(message, sockets);
        }

        this.stack.clear();
    }
}

export class LocalFileRegistry {
    constructor(emitter, { sessionManager, spaceFileListManager, fileEventBroadcaster }) {
        this.emitter = emitter;
        this.sessionManager = sessionManager;
        this.spaceFileListManager = spaceFileListManager;
        this.fileEventBroadcaster = fileEventBroadcaster;

        this.watcher = null;
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    /**
     * Creates and adds signature to the event using public and secret keys.
    * @param {Object} event - The event object containing the record metadata.
    * @param {string} event.topic - The space topic hash associated with the record.
    * @param {string} event.path - The file path within the space.
    * @param {string} event.publicKey - The public key used for signature.
    * @param {string} event.secretKey - The secret key used for signature.
    * @param {number} event.timestamp - The timestamp when the event was created.
    * @param {string} event.rootHash - The root hash of the space file.
    * @returns {Promise<Object>}
     */
    async createSignedEvent(event) {
        const signature = await createSpaceFileRecordSignature(event);
        return { ...event, signature };
    }

    async init() {
        const { publicKey, secretKey } = this.sessionManager.getCredentials();
        const spaceTopicMap = await getSpaceToTopicMap(this.db);
        const records = await queryFileRegistryRecords(this.db, {});

        // this code groups file regisries by the sourceFilePath
        // which helps to avoid recomputing Merkle tree for identical files.
        const groups = records.reduce((map, rec) => {
            const key = rec.fileSourcePath;
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(rec);
            return map;
        }, new Map());


        const sourcePaths = [];

        for (const [sourcePath, registries] of groups) {
            // delete the registry if the local file does not exists anymore
            const sourceFileExists = await fileExists(sourcePath);
            if (!sourceFileExists) {
                for (const registry of registries) {
                    await deleteFileRecord(this.db, registry.id);
                }

                continue;
            }

            const downloadPendingRegistries = [];
            const settledRegistries = [];

            for (const registry of registries) {
                const downloadRecord = await getDownloadRecord(this.db, registry.id);
                if (downloadRecord) {
                    downloadPendingRegistries.push(registry);
                }
                else {
                    settledRegistries.push(registry);
                }
            }

            const pendingCount = downloadPendingRegistries.length;
            const settledCount = settledRegistries.length;

            if (pendingCount > 0) {
                if (settledCount > 0) {
                    // raise awarness about potential conflict between local registries and pending downloads fight over same file source
                    logger.warn(`Conflict: ${pendingCount} pending downloads and ${settledCount} settled registeries share the same path`, {
                        sourcePath,
                        downloadIds: downloadPendingRegistries.map(r => r.id),
                        registryIds: settledRegistries.map(r => r.id)
                    });
                }

                if (pendingCount > 1) {
                    // raise awareness about potential conflict between multiple pending downloads using same file source
                    logger.warn(`Conflict: ${pendingCount} pending downloads share same path`, {
                        sourcePath,
                        downloadIds: downloadPendingRegistries.map(r => r.id),
                    });
                }

                continue;
            }

            // checking the current meta hash against the registry
            // ensures that the file hasn't been modified.
            const currentMetaHash = await getFileMetaHashFromSource(sourcePath);
            const batchRequireUpdate = registries.some(reg => reg.metaHash !== currentMetaHash);

            let tree = null;
            let rootHash = null;

            if (batchRequireUpdate) {
                // calculate the Merkle tree once
                const size = await getFileSize(sourcePath);
                const stream = createFileStream(sourcePath);

                tree = await generateMerkleTree({ stream, size });
                rootHash = tree.rootHash;

                for (const reg of registries) {
                    await updateFileTreeRecord(this.db, {
                        registryId: reg.id,
                        metaHash: currentMetaHash,
                        tree: tree
                    });
                }
            }
            else {
                rootHash = registries[0].rootHash;
            }

            const registryIds = registries.map(reg => reg.id);

            for (const registry of registries) {
                const spaceFilePath = pathJoin(registry.spacePath, registry.spaceFilename);
                const spaceTopicHash = spaceTopicMap.get(registry.spaceId);

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
                this.fileEventBroadcaster.add(
                    EVENTS.SpaceFileEventOptions.ADD,
                    record
                );
            }

            sourcePaths.push(sourcePath);
        }

        this.watcher = await createWatcher(sourcePaths);
        this.watcher.on(WatchTypes.CHANGE, (filePath) => this.onChangeEvent(filePath));
        this.watcher.on(WatchTypes.DELETE, (filePath) => this.onDeleteEvent(filePath));
    }


    /**
     * Add a new file registry for a local file.
     * @param {Object} params
     * @param {number} params.spaceId - ID of the space
     * @param {string} params.spacePath - Path within the space (directory)
     * @param {string} params.spaceFilename - Filename within the space
     * @param {string} params.fileSourcePath - Absolute local file path
     * @returns {Promise<number>} - The newly created registry ID
     */
    async add(params) {
        const { spaceId, spacePath, spaceFilename, fileSourcePath } = params;

        const exists = await fileExists(fileSourcePath);
        if (!exists) {
            throw new Error(`File does not exists: ${fileSourcePath}`);
        }

        const existingRecords = await queryFileRegistryRecords(this.db, {
            spaceId: spaceId,
            spacePath: spacePath,
            spaceFilename: spaceFilename,
            fileSourcePath: fileSourcePath
        });

        if (existingRecords.length > 0) {
            throw new Error(`Registry already exists`);
        }

        const space = await getSpace(this.db, spaceId);
        if (!space) {
            throw new Error(`Space not found with id: ${spaceId}`);
        }

        const { registryId, rootHash } = await generateFileTreeRecord(this.db, {
            fileSourcePath: fileSourcePath,
            spacePath: spacePath,
            spaceFilename: spaceFilename,
            spaceId: spaceId
        });

        if (!this.watcher) return;

        const watchedFiles = this.watcher.getWatched() || {};
        if (!Object.keys(watchedFiles).includes(fileSourcePath)) {
            await this.watcher.add(fileSourcePath);
        }

        const { publicKey, secretKey } = this.sessionManager.getCredentials();
        const spaceTopicHash = getSpaceTopicHash(space);
        const spaceFilePath = pathJoin(spacePath, spaceFilename);

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

        return registryId;
    }

    /**
     * Delete a registry and remove associated resources.
     * @param {Object} params
     * @param {number} params.registryId - ID of the registry to delete
     * @returns {Promise<void>}
     */
    async delete(params) {
        const { registryId } = params;
        const registry = await getFileRegistryRecord(this.db, registryId);

        if (!registry) {
            throw new Error(`Registry ${registryId} not found`);
        }

        await deleteFileRecord(this.db, registryId);
        // check if there are other registries using the same fileSourcePath
        const remainingRegistries = await queryFileRegistryRecords(this.db, {
            fileSourcePath: registry.fileSourcePath
        });

        if (remainingRegistries.length === 0) {
            if (this.watcher) {
                await this.watcher.unwatch(registry.fileSourcePath);
            }
        }

        const { publicKey, secretKey } = this.sessionManager.getCredentials();
        const space = await getSpace(this.db, registry.spaceId);
        const spaceFilePath = pathJoin(registry.spacePath, registry.spaceFilename);

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
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = null;
        }
    }

    async onChangeEvent(filePath) {
        const exists = await fileExists(filePath);
        if (!exists) return;

        const { publicKey, secretKey } = this.sessionManager.getCredentials();
        const registeries = await queryFileRegistryRecords(
            this.db,
            { fileSourcePath: filePath }
        );

        if (registeries.length === 0) return;

        const sourceHashDownloadRecord = await getDownloadRecord(this.db, registeries[0].id);
        if (sourceHashDownloadRecord) return;

        const currentMetaHash = await getFileMetaHashFromSource(filePath);
        if (currentMetaHash === registeries[0].metaHash) return;

        const size = await getFileSize(filePath);
        const stream = await createFileStream(filePath);
        const tree = await generateMerkleTree({ stream, size });

        for (const registry of registeries) {
            await updateFileTreeRecord(this.db, {
                registryId: registry.id,
                metaHash: currentMetaHash,
                tree: tree
            });

            const space = await getSpace(this.db, registry.spaceId);

            if (space) {
                const spaceTopicHash = getSpaceTopicHash(space);
                const spaceFilePath = pathJoin(registry.spacePath, registry.spaceFilename);

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
                    record
                );
            }
        }
    }

    async onDeleteEvent(filePath) {
        const exists = await fileExists(filePath);
        if (exists) return; // avoid deletion if the file still exists; rare condition.

        const { publicKey, secretKey } = this.sessionManager.getCredentials();

        const registeries = await queryFileRegistryRecords(
            this.db,
            { fileSourcePath: filePath }
        );

        if (registeries.length === 0) return;

        const sourceHashDownloadRecord = await getDownloadRecord(this.db, registeries[0].id);
        if (sourceHashDownloadRecord) return;

        for (const registry of registeries) {
            await deleteFileRecord(this.db, registry.id);

            const space = await getSpace(this.db, registry.spaceId);

            if (space) {
                const spaceTopicHash = getSpaceTopicHash(space);
                const spaceFilePath = pathJoin(registry.spacePath, registry.spaceFilename);

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
                    record
                );
            }
        }
    }
}

export class SpaceDownloadTask {
    constructor(emitter, managers) {
        this.emitter = emitter;
        this.sessionManager = managers.sessionManager;
        this.spaceFileListManager = managers.spaceFileListManager;
        this.messageManager = managers.messageManager;
        this.socketManager = managers.socketManager;
        this.connectionManager = managers.connectionManager;
        this.fileEventBroadcaster = managers.fileEventBroadcaster;

        this.registryId = null;
        this.spaceId = null;
        this.topic = null;
        this.spaceFilePath = null;
        this.rootHash = null;
        this.finalDestination = null;
        this.key = null;
        this.keyBuffer = null; // download key as Buffer

        // Merkle tree related parameters
        this.tree = null;
        this.leafCount = null;
        this.fileHandler = null;
        this.tempFilePath = null;

        // Download state
        this.nextExpectedLeaf = 0; // next leaf to write sequentially
        this.buffer = new Map(); // leafIndex -> Buffer (received chunks)
        this.inFlightLeafs = new Set(); // leaf indices currently requested (pending)
        this.pendingRequests = new Map(); // provider -> { startLeaf, endLeaf, timestamp }
        this.completedLeafs = []; // for tracking written leaves (may not be needed)

        // tracking providers
        this.providers = [];
        this.providerLastRequestableLeaf = new Map();
        this.providerPerformance = new Map(); // avg response time (ms)

        // tracking tree requests
        this.treeRequestNonces = [];
        this.pendingTreeRequests = new Map();

        // control download status
        this.downloadStarted = false;
        this.downloadComplete = false;
        this.windowSizeLeaves = 0;

        // internal timers
        this.treeRequestInterval = null;
        this.timeoutTimer = null;

        // timeout for response delays
        this.requestTimeout = 30000;    // 30 seconds
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    get treeRequestIntervalTime() {
        return this.sessionManager.session.get('files.treeRequestInterval') ?? 5000;
    }

    get minLeafCountForAdvertisement() {
        return this.sessionManager.session.get('files.minLeafCountForAdvertisement') ?? 100;
    }

    /**
     * Set download key for stream routing
     * @param {string} key - 12 bytes hex string key
     */
    setKey(key) {
        this.key = key;
        this.keyBuffer = Buffer.from(key, 'hex');
    }


    async setRecord(record) {
        const { finalDestination, lastPushedLeaf, registryId } = record;

        const registry = await getFileRegistryRecord(this.db, registryId);
        if (!registry) {
            throw new Error("Registry not found for the download record");
        }
        
        const space = await getSpace(this.db, registry.spaceId);
        if (!space) {
            throw new Error(`Registry with id:${registry.id} failed setting download task due to unknown spaceId:${registry.spaceId}`);
        }
        
        this.registryId = registryId;
        this.spaceId = registry.spaceId;
        this.topic = getSpaceTopicHash(space);
        this.spaceFilePath = pathJoin(registry.spacePath, registry.spaceFilename);
        this.rootHash = registry.rootHash;
        this.tempFilePath = registry.fileSourcePath;
        this.finalDestination = finalDestination;
        this.leafCount = registry.leafCount;

        // load the merkle tree from file registry record
        const savedTree = await getFileTreeRecord(this.db, registryId);
        if (isDefined(savedTree) && savedTree.rootHash === registry.rootHash) {
            this.tree = savedTree;
            this.leafCount = savedTree.leafCount;
        }

        this.nextExpectedLeaf = lastPushedLeaf + 1;

        const exists = await fileExists(this.tempFilePath);
        if (!exists) {
            throw new Error(`Temporary file missing for download resume: ${this.tempFilePath}`);
        }

        this.fileHandler = await openFile(this.tempFilePath);
        this.downloadStarted = false; // will start after tree is ready
    }

    async setTask({ space, spaceFilePath, rootHash, finalDestination }) {
        this.spaceId = space.id;
        this.topic = getSpaceTopicHash(space);
        this.spaceFilePath = spaceFilePath;
        this.rootHash = rootHash;
        this.finalDestination = finalDestination;

        const { directory, username } = this.sessionManager.getAccount();
        const temporarySourcePath = getTemporarySourcePathForSpaceFile({
            root: directory,
            username: username,
            spaceFilePath: spaceFilePath,
            rootHash: rootHash,
            topic: this.topic
        });

        this.tempFilePath = temporarySourcePath;
        this.nextExpectedLeaf = 0;
        this.downloadStarted = false;
    }

    async start() {
        if (!this.spaceFilePath || !this.rootHash) {
            throw new Error("Task initialization failed. call setRecord() or setTask() first.");
        }

        // listen for provider updates to sync current provider list
        this.emitter.on(EVENTS.SpaceFileEvent, () => this.updateProvideList());

        // listen for file tree responses from providers
        this.emitter.on(EVENTS.SpaceFileTreeResponse, async message => await this.onTreeResponseHandler(message));

        // requesting file tree from foreign providers that just established socket connection
        this.emitter.on(EVENTS.SpaceHashList, async context => await this.onSpaceHashList(context));

        // periodically update provider list and request trees from providers
        await this.providerContextUpdate();
        this.treeRequestInterval = setInterval(
            async () => await this.providerContextUpdate(),
            this.treeRequestIntervalTime
        );

        // set timeout interval for content delivery delays
        this.timeoutTimer = setInterval(() => this.checkTimeouts(), 5000);

        if (this.tree) {
            await this.beginDownloading();
        }
    }

    async stop() {
        if (this.treeRequestInterval) {
            clearInterval(this.treeRequestInterval);
            this.treeRequestInterval = null;
        }
        if (this.timeoutTimer) {
            clearInterval(this.timeoutTimer);
            this.timeoutTimer = null;
        }
        if (this.fileHandler) {
            await closeFile(this.fileHandler);
            this.fileHandler = null;
        }
        this.downloadStarted = false;
    }

    /**
     * Condition which task should avoid requesting file tree from full providers (advertisedLeaf=leafCount - 1)
     * which means updatings their file availability state is no longer required.
     * @param {string} publicKey 
     * @returns {boolean}
     */
    shouldRequestTreeFromProvider(publicKey) {
        const advertisedLeaf = this.providerLastRequestableLeaf.get(publicKey);
        if (advertisedLeaf === undefined) return true;
        return advertisedLeaf < (this.leafCount - 1);
    }

    /**
     * send SpaceFileTreeRequest messages to providers to acumulate information about their file availability
     * @param {string} publicKey 
     * @returns {Promise<void>}
     */
    async requestTreeFromProvider(publicKey) {
        if (!this.shouldRequestTreeFromProvider(publicKey)) return;

        const message = await createSpaceFileTreeRequestMessage({
            topic: this.topic,
            spaceFilePath: this.spaceFilePath,
            rootHash: this.rootHash
        });

        this.treeRequestNonces.push(message.nonce);
        this.pendingTreeRequests.set(publicKey, message.timestamp);

        const sockets = this.socketManager.getConnectedSockets({
            peers: [publicKey],
            topics: [this.topic]
        });

        if (sockets.length !== 0) {
            await this.messageManager.sendMessageToSocket(message, sockets[0]);
        }
    }

    async providerContextUpdate() {
        const subscribedPeers = this.socketManager.topicIndex.get(this.topic);
        if (!subscribedPeers) return;

        this.updateProvideList();

        for (const publicKey of this.providers) {
            if (subscribedPeers.has(publicKey)) {
                await this.requestTreeFromProvider(publicKey);
            } else {
                this.connectionManager.connectWith(publicKey);
            }
        }
    }

    removeAllProviders() {
        for (const [provider, request] of this.pendingRequests) {
            this.reassignSlice(provider, request.startLeaf, request.endLeaf);
        }

        this.pendingRequests.clear();
        this.providers = [];
        this.inFlightLeafs.clear();
    }

    removeProvider(publicKey) {
        if (this.pendingRequests.has(publicKey)) {
            const req = this.pendingRequests.get(publicKey);
            this.reassignSlice(publicKey, req.startLeaf, req.endLeaf);
            this.pendingRequests.delete(publicKey);
        }
    }

    async onTreeResponseHandler(responseMessage) {
        if (responseMessage.topic !== this.topic) return;

        const { tree, lastRequestableLeaf, replyNonce } = responseMessage.payload;
        if (!this.treeRequestNonces.includes(replyNonce)) return;
        if (tree.rootHash !== this.rootHash) return;

        this.providerLastRequestableLeaf.set(responseMessage.publicKey, lastRequestableLeaf);

        if (this.tree) return; // already have tree

        this.tree = tree;

        const height = tree.levels.length - 1;
        this.leafCount = tree.levels[height].length;
        this.completedLeafs = new Array(this.leafCount).fill(false);

        // create the new download record based on the received tree response
        const parsed = parseFilePath(this.spaceFilePath);
        const { registryId } = await createDownloadRecord(this.db, {
            tempFilePath: this.tempFilePath,
            finalDestination: this.finalDestination,
            spaceId: this.spaceId,
            spacePath: parsed.dir,
            spaceFilename: parsed.filename,
            rootHash: this.rootHash,
            leafCount: this.leafCount,
            height: height
        });

        this.registryId = registryId;
        this.fileHandler = await openFile(this.tempFilePath);

        if (!this.downloadStarted) {
            await this.beginDownloading();
        }
    }

    async beginDownloading() {
        if (this.downloadStarted || this.downloadComplete) return;
        if (!this.tree || !this.fileHandler) {
            logger.warn('Cannot begin download: tree or fileHandler missing');
            return;
        }

        this.downloadStarted = true;
        // Set window size: e.g., up to 50 MB
        const maxWindowBytes = 50 * 1024 * 1024; // 50 MB
        const fileSize = await this.fileHandler.stat().then(s => s.size);
        const windowBytes = Math.min(fileSize, maxWindowBytes);
        this.windowSizeLeaves = Math.ceil(windowBytes / DEFAULT_CHUNK_SIZE) + 10;

        await this.scheduleWindow();
    }

    async scheduleWindow() {
        if (this.downloadComplete) return;

        const start = this.nextExpectedLeaf;
        if (start >= this.leafCount) {
            await this.finishDownload();
            return;
        }

        const end = Math.min(start + this.windowSizeLeaves, this.leafCount);

        const availableLeaves = [];
        for (let i = start; i < end; i++) {
            if (!this.buffer.has(i) && !this.inFlightLeafs.has(i)) {
                availableLeaves.push(i);
            }
        }

        if (availableLeaves.length === 0) {
            // All leaves in window are already in flight or buffered; wait for writes to progress
            return;
        }

        // Get list of active providers (those with lastRequestableLeaf >= start)
        const activeProviders = this.providers.filter(p => {
            const maxLeaf = this.providerLastRequestableLeaf.get(p);
            return maxLeaf !== undefined && maxLeaf >= start;
        });

        if (activeProviders.length === 0) {
            // No providers available; wait for provider context update
            return;
        }

        const slices = this.distributeLeaves(availableLeaves, activeProviders);

        for (const [provider, leafIndices] of slices) {
            if (leafIndices.length === 0) continue;
            const startLeaf = leafIndices[0];
            const endLeaf = leafIndices[leafIndices.length - 1];
            await this.requestSlice(provider, startLeaf, endLeaf);
        }
    }

    distributeLeaves(leaves, providers) {
        const totalWeight = providers.reduce((sum, p) => {
            const perf = this.providerPerformance.get(p) || 100; // default 100ms
            const weight = 1 / (perf + 1); // avoid division by zero
            return sum + weight;
        }, 0);

        let idx = 0;
        const slices = new Map();
        let remaining = leaves.length;

        for (const provider of providers) {
            const perf = this.providerPerformance.get(provider) || 100;
            const weight = 1 / (perf + 1);
            const count = Math.floor((weight / totalWeight) * leaves.length);
            const sliceLeaves = leaves.slice(idx, idx + count);
            idx += count;
            remaining -= count;
            if (sliceLeaves.length > 0) {
                slices.set(provider, sliceLeaves);
            }
        }

        // Distribute any remaining leaves to the fastest provider (or round-robin)
        if (remaining > 0 && idx < leaves.length) {
            // Assign remaining to the provider with best performance (lowest avg time)
            let best = providers[0];
            let bestPerf = this.providerPerformance.get(best) || Infinity;
            for (const p of providers) {
                const perf = this.providerPerformance.get(p) || Infinity;
                if (perf < bestPerf) {
                    bestPerf = perf;
                    best = p;
                }
            }
            const extra = leaves.slice(idx);
            if (slices.has(best)) {
                slices.get(best).push(...extra);
            } else {
                slices.set(best, extra);
            }
        }

        return slices;
    }

    async requestSlice(provider, startLeaf, endLeaf) {
        if (this.pendingRequests.has(provider)) {
            return;
        }

        const maxLeaf = this.providerLastRequestableLeaf.get(provider);
        if (maxLeaf !== undefined && endLeaf > maxLeaf) {yeap
            endLeaf = Math.min(endLeaf, maxLeaf);
            if (startLeaf > endLeaf) return;
        }

        for (let i = startLeaf; i <= endLeaf; i++) {
            this.inFlightLeafs.add(i);
        }

        const message = await createSpaceFileContentRequestMessage({
            topic: this.topic,
            spaceFilePath: this.spaceFilePath,
            leafStart: startLeaf,
            leafStop: endLeaf,
            downloadKey: this.key
        });

        this.pendingRequests.set(provider, {
            startLeaf,
            endLeaf,
            timestamp: now()
        });

        const sockets = this.socketManager.getConnectedSockets({
            peers: [provider],
            topics: [this.topic]
        });

        if (sockets.length === 0) {
            this.connectionManager.connectWith(provider);
        } 
        else {
            await this.messageManager.sendMessageToSocket(message, sockets[0]);
        }
    }

    async handleChunk(leafIndex, chunk) {
        if (this.downloadComplete) return;
        if (leafIndex < 0 || leafIndex >= this.leafCount) {
            logger.warn(`Invalid leaf index ${leafIndex}`);
            return;
        }

        if (this.buffer.has(leafIndex)) {
            return;
        }

        this.buffer.set(leafIndex, chunk);
        this.inFlightLeafs.delete(leafIndex);

        await this.tryWrite();
        await this.scheduleWindow();
    }

    async tryWrite() {
        let wrote = 0;
        while (this.buffer.has(this.nextExpectedLeaf)) {
            const chunk = this.buffer.get(this.nextExpectedLeaf);
            const offset = this.nextExpectedLeaf * DEFAULT_CHUNK_SIZE;
            await this.fileHandler.write(chunk, 0, chunk.length, offset);

            await updateDownloadRecord(this.db, {
                registryId: this.registryId,
                leafIndex: this.nextExpectedLeaf,
                leafContent: chunk,
                fileHandler: this.fileHandler
            });

            this.buffer.delete(this.nextExpectedLeaf);
            this.nextExpectedLeaf++;
            wrote++;
        }

        if (wrote > 0) {
            if (this.nextExpectedLeaf >= this.leafCount) {
                await this.finishDownload();
            }
        }
    }

    async finishDownload() {
        if (this.downloadComplete) return;
        this.downloadComplete = true;
        this.downloadStarted = false;

        if (this.fileHandler) {
            await closeFile(this.fileHandler);
            this.fileHandler = null;
        }

        await setDownloadAsComplete(this.db, this.registryId);
        await this.stop();
    }

    checkTimeouts() {
        const now = Date.now();
        for (const [provider, req] of this.pendingRequests.entries()) {
            if (now - req.timestamp > this.requestTimeout) {                
                this.reassignSlice(provider, req.startLeaf, req.endLeaf);

                this.pendingRequests.delete(provider);
                this.updateProviderPerformance(provider, this.requestTimeout * 2);
            }
        }
    }

    reassignSlice(provider, startLeaf, endLeaf) {
        const missing = [];
        for (let i = startLeaf; i <= endLeaf; i++) {
            if (!this.buffer.has(i) && !this.inFlightLeafs.has(i)) {
                missing.push(i);
            }
        }
        if (missing.length === 0) return;

        for (let i = startLeaf; i <= endLeaf; i++) {
            this.inFlightLeafs.delete(i);
        }
        
        this.scheduleWindow();
    }

    updateProviderPerformance(provider, responseTime) {
        // Simple exponential moving average
        const old = this.providerPerformance.get(provider) || 100;
        const alpha = 0.3;
        const newAvg = alpha * responseTime + (1 - alpha) * old;
        this.providerPerformance.set(provider, newAvg);
    }

    async onSpaceHashList(context) {
        const { message, topics } = context;
        if (!this.providers.includes(message.publicKey)) return;
        if (topics.includes(this.topic)) {
            await this.requestTreeFromProvider(message.publicKey);
        }
    }

    updateProvideList() {
        const spaceFiles = this.spaceFileListManager.get(this.topic);
        const fileEntry = spaceFiles?.[this.spaceFilePath];
        if (!fileEntry) {
            this.removeAllProviders();
            return;
        }

        const variants = fileEntry[this.rootHash];
        if (!variants) {
            this.removeAllProviders();
            return;
        }

        const newProviders = Object.keys(variants.peers);
        const oldSet = new Set(this.providers);

        for (const old of oldSet) {
            if (!newProviders.includes(old)) {
                this.removeProvider(old);
            }
        }

        this.providers = newProviders;
    }
}

export class SpaceFileManager {
    constructor(emitter, managers) {
        this.emitter = emitter;
        this.sessionManager = managers.sessionManager;
        this.socketManager = managers.socketManager;
        this.messageManager = managers.messageManager;
        this.connectionManager = managers.connectionManager;
        this.spaceFileListManager = managers.spaceFileListManager;

        this.fileEventBroadcaster = new FileEventBroadcaster(
            this.emitter,
            {
                sessionManager: this.sessionManager,
                socketManager: this.socketManager,
                messageManager: this.messageManager
            }
        );

        this.localFileRegistry = new LocalFileRegistry(
            this.emitter,
            {
                sessionManager: this.sessionManager,
                spaceFileListManager: this.spaceFileListManager,
                fileEventBroadcaster: this.fileEventBroadcaster,
            }
        );

        // key -> download task instance
        this.downloadTasks = new Map();
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    /**
     * Generates random 24-character hex strings as key.
     * @returns {string}
     */
    generateDownloadKey() {
        return hex(randomNonce());
    }

    /**
     * Creates fresh SpaceDownloadTask instance.
     * @returns {SpaceDownloadTask}
     */
    createDownloadTask() {
        const task = new SpaceDownloadTask(this.emitter, {
            sessionManager: this.sessionManager,
            spaceFileListManager: this.spaceFileListManager,
            messageManager: this.messageManager,
            socketManager: this.socketManager,
            connectionManager: this.connectionManager,
            fileEventBroadcaster: this.fileEventBroadcaster
        });

        return task;
    }

    async init() {
        await this.localFileRegistry.init();

        const downloads = await listDownloadRecords(this.db);
        for (const task of downloads) {
            const spaceDownloadTask = this.createDownloadTask();
            // create and assign the download key to the task to be used for requests.
            const downloadKey = this.generateDownloadKey();
            spaceDownloadTask.setKey(downloadKey);
            // assign the instance to key in order to map incomming streams to dedicated task instance
            this.downloadTasks.set(spaceDownloadTask, spaceDownloadTask);
            // load the download record and start the task.
            await spaceDownloadTask.setRecord(task);
            await spaceDownloadTask.start();
        }
    }

    /**
     * Creates new download task.
     * @param {Object} space - Space object instance including ID.
     * @param {String} spaceFilePath - Full space file path.
     * @param {String} rootHash - Root hash of space file's Merkle tree.
     * @param {string} finalDestination - Final local destination path for the downloaded file.
     */
    async download(space, spaceFilePath, rootHash, finalDestination) {
        const spaceDownloadTask = this.createDownloadTask();

        const key = this.generateDownloadKey();
        this.downloadTasks.set(key, spaceDownloadTask);
        spaceDownloadTask.setKey(key);

        await spaceDownloadTask.setTask({ 
            space, 
            spaceFilePath, 
            rootHash, 
            finalDestination
        });

        await spaceDownloadTask.start();
    }

    /**
     * Handles icomming stream data from connections and routes them to download tasks.
     * @param {Object} socket 
     * @param {Buffer} data 
     * @param {Object} info 
     * @returns {Promise<void>}
     */
    async handleIncomingStream(socket, data, info) {
        const keyLength = 12; // 12 bytes
        const keyBuffer = data.slice(0, keyLength);
        const keyHex = hex(keyBuffer);

        const task = this.downloadTasks.get(keyHex);
        if (!task) return;

        const leafIndex = data.readUInt32BE(keyLength);
        const chunk = data.slice(keyLength + 4);
        
        await task.handleChunk(leafIndex, chunk);
    }

    async stop() {
        await this.localFileRegistry.stop();
        await this.fileEventBroadcaster.flush();

        const tasks = this.downloadTasks.values();
        for (const task of tasks) {
            await task.stop();
        }
    }
}