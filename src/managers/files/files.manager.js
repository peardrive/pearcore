import { createChild } from '../../logger.js';
import { listDownloadRecords } from "../../utils/files.utils.js";
import { parseFilePath } from '../../utils/parsers.utils.js';
import { hex, randomNonce } from '../../utils/crypto.utils.js';
import { FileEventBroadcaster } from './components/events.js';
import { LocalFileRegistry } from './components/registry.js';
import { SpaceDownloadTask } from './components/downlad.js';
import { ProgressTracker } from './components/progress.js';

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

    /**
     * Get SpaceDownloadTask instance using key.
     * @param {string} key 
     * @returns {SpaceDownloadTask | undefined}
     */
    getDownloadTask(key) {
        return this.downloadTasks.get(key);
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
            this.downloadTasks.set(downloadKey, spaceDownloadTask);
            // load the download record and start the task.
            await spaceDownloadTask.setRecord(task);
            await spaceDownloadTask.start();
        }
    }

    /**
     * Add new file to local file registry.
     * @param {Object} space 
     * @param {Number} space.id
     * @param {String} spaceFilePath 
     * @param {String} fileSourcePath 
     * @param {Object} options
     * @param {(tracker: ProgressTracker) => void} options.onIndexingStart - optional callback to trigger when the indexing starts
     * @returns {number}
     */
    async addLocalFile(space, spaceFilePath, fileSourcePath, options) {
        const parsed = parseFilePath(spaceFilePath);
        
        const registryId = await this.localFileRegistry.add({
            spaceId: space.id,
            spacePath: parsed.dir,
            spaceFilename: parsed.filename,
            fileSourcePath: fileSourcePath,
            onIndexingStart: options.onIndexingStart
        });

        return registryId;
    }

    /**
     * Remove local file registry.
     * @param {Number} registryId - Local file registry ID
     */
    async removeLocalFile(registryId) {
        await this.localFileRegistry.delete(registryId);
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
        return key;
    }

    /**
     * Get progress tracker for local file indexing process.
     * @param {string} filePath 
     * @returns {ProgressTracker|undefined}
     */
    getIndexingProgress(filePath) {
        return this.localFileRegistry.getProgressTracker(filePath);
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
    }
}