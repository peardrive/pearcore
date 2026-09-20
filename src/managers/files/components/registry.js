import * as EVENTS from '../../../constants/events.constants.js';
import { now } from "../../../utils/general.utils.js";
import { getSpace, getSpaceTopicHash, getSpaceToTopicMap } from "../../../utils/space.utils.js";
import { createFileStream, fileExists, getFileSize, posixPathJoin } from "../../../utils/system.utils.js";
import { createSpaceFileRecordSignature } from "../../../utils/protocol.utils.js";
import {
    deleteFileRecord,
    generateFileTreeRecord,
    createWatcher,
    WatchTypes,
    queryFileRegistryRecords,
    getFileMetaHashFromSource,
    updateFileTreeRecord,
    getDownloadRecord,
    getFileRegistryRecord,
} from "../../../utils/files.utils.js";
import { generateMerkleTree } from '../../../utils/merkletree.utils.js';
import { createChild } from '../../../logger.js';

const logger = createChild('LocalFileRegistry');

export class LocalFileRegistry {
    constructor(emitter, { sessionManager, spaceFileListManager, fileEventBroadcaster }) {
        this.emitter = emitter;
        this.sessionManager = sessionManager;
        this.spaceFileListManager = spaceFileListManager;
        this.fileEventBroadcaster = fileEventBroadcaster;

        this.watcher = null;
        this.backoffStates = new Map(); // filePath -> { timeout, delay }
        this.indexingInProgress = new Map(); // filePath -> boolean
        this.pendingAfterIndex = new Map(); // filePath -> boolean
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    get backoffConfig() {
        return this.sessionManager.session.get('files.localChangeBackoff');
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

                let stream;
                try {
                    // try to generate new Merkle tree
                    stream = createFileStream(sourcePath);
                    tree = await generateMerkleTree({ stream, size });
                    rootHash = tree.rootHash;

                } catch(error) {
                    // skip the registry group if reading file has failed.
                    logger.warn('generating new tree failed', {
                        sourcePath,
                        error
                    });

                    continue;

                } finally {
                    // ensure that the stream is fully closed
                    if (stream && !stream.destroyed) {
                        await stream.destroy();
                    }
                }

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

            for (const registry of registries) {
                const spaceFilePath = posixPathJoin(registry.spacePath, registry.spaceFilename);
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
        this.watcher.on(WatchTypes.CHANGE, this.onChangeEvent);
        this.watcher.on(WatchTypes.DELETE, this.onDeleteEvent);
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

        if (this.watcher) {
            const watchedFiles = this.watcher.getWatched() || {};
            if (!Object.keys(watchedFiles).includes(fileSourcePath)) {
                await this.watcher.add(fileSourcePath);
            }
        }

        const { publicKey, secretKey } = this.sessionManager.getCredentials();
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
        const spaceFilePath = posixPathJoin(registry.spacePath, registry.spaceFilename);

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
        for (const [filePath, entry] in this.backoffStates.entries()) {
            clearTimeout(entry.timeout);
        }

        if (this.watcher) {
            this.watcher.removeAllListeners();
            await this.watcher.close();
            this.watcher = null;
        }
        
        this.backoffStates.clear();
        this.pendingAfterIndex.clear();
        this.indexingInProgress.clear();
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

        this.scheduleFileIndexing(filePath);

        for (const registry of registeries) {
            const space = await getSpace(this.db, registry.spaceId);

            if (space) {
                const spaceTopicHash = getSpaceTopicHash(space);
                const spaceFilePath = posixPathJoin(registry.spacePath, registry.spaceFilename);

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
                    record
                );
            }
        }
    }

    async onDeleteEvent(filePath) {
        const schedule = this.backoffStates.get(filePath);
        if (schedule) {
            clearTimeout(schedule.timeout);
            this.backoffStates.delete(filePath);
        }

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
                const spaceFilePath = posixPathJoin(registry.spacePath, registry.spaceFilename);

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

    /**
     * Schedule and re-schedules the indexing task for a file-change.
     */
    scheduleFileIndexing(filePath) {
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
        }
        else {
            scheduleDelay = this.backoffConfig.baseDelay;
        }

        const updatedSchduleDelay = Math.min(scheduleDelay, this.backoffConfig.maxDelay);

        const timeout = setTimeout(
            () => this.processFileIndex(filePath),
            updatedSchduleDelay
        );

        this.backoffStates.set(filePath, { timeout, delay: updatedSchduleDelay });
    }

    /**
     * Compute new Merkle tree and update registeries, creates new file-events and broadcasts to the network.
     * @param {string} filePath 
     * @returns {Promise<void>} Resolves when the indexing has completed and the new event broadcasts to the network.
     */
    async processFileIndex(filePath) {
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

            const { publicKey, secretKey } = this.sessionManager.getCredentials();

            const registeries = await queryFileRegistryRecords(this.db, { fileSourcePath: filePath });
            if (registeries.length === 0) return;

            const downloadRecord = await getDownloadRecord(this.db, registeries[0].id);
            if (downloadRecord) return;

            const currentMetaHash = await getFileMetaHashFromSource(filePath);
            if (currentMetaHash === registeries[0].metaHash) return;

            let tree;
            try {
                const size = await getFileSize(filePath);
                const stream = await createFileStream(filePath);
                tree = await generateMerkleTree({ stream, size });
            } catch (error) {
                logger.error('Generating Merkle tree failed during scheduled indexing', {
                    filePath,
                    error
                });
                return;
            }

            for (const registry of registeries) {
                await updateFileTreeRecord(this.db, {
                    registryId: registry.id,
                    metaHash: currentMetaHash,
                    tree: tree
                });

                const space = await getSpace(this.db, registry.spaceId);

                if (space) {
                    const spaceTopicHash = getSpaceTopicHash(space);
                    const spaceFilePath = posixPathJoin(registry.spacePath, registry.spaceFilename);

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
        } catch (error) {
            logger.error('Indexing local file registry failed', {
                filePath: filePath,
                error: error
            });
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