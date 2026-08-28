import { DEFAULT_CHUNK_SIZE } from '../constants/global.constants.js';
import * as EVENTS from '../constants/events.constants.js';
import * as MESSAGES from '../constants/messages.constants.js';
import { createChild } from "../logger.js";
import { hexToUint8 } from '../utils/crypto.utils';
import { getFileChunk } from '../utils/files.utils.js';
import { closeFile, openFile } from '../utils/system.utils.js';
import { FrameTypes } from './multiplexer.manager.js';

const logger = createChild('FileContentDelivery');

export class FileHandlerCache {
    constructor() {
        this.handlers = new Map(); // filePath -> { handle: FileHandle | null, refCount: number }
        this.keyToPath = new Map(); // key -> filePath
    }

    /**
     * Get a file handler for the given path.
     * @param {String} filePath - path to the file
     * @param {String} key - the task key
     */
    async get(filePath, key) {
        const existingPath = this.keyToPath.get(key);
        if (existingPath && existingPath !== filePath) {
            throw new Error(`Key "${key}" is already associated with file "${existingPath}"`);
        }

        let entry = this.handlers.get(filePath);
        if (!entry) {
            entry = { handle: null, refCount: 0, opening: null, error: null };
            this.handlers.set(filePath, entry);
        }

        if (entry.error) {
            throw entry.error;
        }

        // increment the number of tasks assigned to the file handler
        entry.refCount++;
        this.keyToPath.set(key, filePath);

        if (entry.opening) {
            await entry.opening;

            // in case if the promise did catch error
            if (entry.error) throw entry.error;
            return entry.handle;
        }

        entry.opening = openFile(filePath);
        try {
            const handler = await entry.opening;
            entry.handle = handler;
            entry.opening = null;
            return handler;
        } catch (error) {
            entry.error = error;
            entry.opening = null;

            entry.refCount = entry.refCount - 1;
            if (entry.refCount === 0) {
                this.handlers.delete(filePath);
            }

            this.keyToPath.delete(key);
            throw error;
        }
    }

    /**
     * Release the reference from a given key.
     * @param {string} key 
     * @returns {Promise<void>}
     */
    async drop(key) {
        const filePath = this.keyToPath.get(key);
        if (!filePath) return;

        const entry = this.handlers.get(filePath);
        if (!entry) {
            this.keyToPath.delete(key);
            return;
        }

        entry.refCount = entry.refCount - 1;
        if (entry.refCount === 0) {
            if (entry.handle) {
                try {
                    await closeFile(entry.handle);
                } catch (error) {
                    throw new Error(`Error closing file ${filePath}`);
                }

                entry.handle = null;
            }

            this.handlers.delete(filePath);
        }

        this.keyToPath.delete(key);
    }

    /**
     * Force eject a file handle
     * @param {String} filePath 
     */
    async eject(filePath) {
        const entry = this.handlers.get(filePath);
        if (!entry) return;

        if (entry.handle) {
            try {
                await closeFile(entry.handle);
            } catch (error) {
                throw new Error(`Error closing file ${filePath}`);
            }

            entry.handle = null;
        }

        this.handlers.delete(filePath);

        for (const [key, path] of this.keyToPath.entries()) {
            if (path === filePath) {
                this.keyToPath.delete(key);
            }
        }
    }

    async stop() {
        for (const [filePath, entry] of this.handlers) {
            if (entry.handle) {
                try {
                    await closeFile(entry.handle);
                } catch (err) {
                    throw new Error(`Error closing file ${filePath}`);
                }
            }
        }
        this.handlers.clear();
        this.keyToPath.clear();
    }
}

export class FileContentDeliveryManager {
    constructor(emitter, managers) {
        this.emitter = emitter;
        this.sessionManager = managers.sessionManager;
        this.messageManager = managers.messageManager;
        this.muxManager = managers.muxManager;

        this.fileCache = new FileHandlerCache();
        this.fileTasks = new Map(); // filePath -> Set<AbortController>
        this.deliveryTasksByKey = new Map(); // key -> Set<{ filePath, controller }>
        this.taskPromises = new Map(); // key -> Promise<{succeed, reason}>
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    async sendStreamToSocket(stream, socket) {
        await this.muxManager.send(socket, stream, FrameTypes.STREAM);
    }

    abortTasksForFilePath(filePath) {
        const controllers = this.fileTasks.get(filePath);
        if (controllers) {
            for (const controller of controllers) {
                controller.abort();
            }
        }
    }

    async init() {
        this.emitter.on(EVENTS.LocalFileChange, filePath => {
            this.abortTasksForFilePath(filePath);
            this.fileCache.eject(filePath);
        });

        this.emitter.on(EVENTS.LocalFileDetele, filePath => {
            this.abortTasksForFilePath(filePath);
            this.fileCache.eject(filePath);
        });
    }

    async stop() {
        for (const [filePath, controllers] of this.fileTasks) {
            for (const controller of controllers) {
                controller.abort();
            }
        }

        this.fileTasks.clear();
        this.deliveryTasksByKey.clear();
        await this.fileCache.stop();
    }

    /**
     * Creates new delivery task.
    * @param {Object} params - The parameters object.
    * @param {Socket} params.socket - The socket connection instance.
    * @param {String} params.key - The encryption or authentication key.
    * @param {string} params.filePath - The path to the target file.
    * @param {number} params.startLeaf - The starting leaf index (inclusive).
    * @param {number} params.endLeaf - The ending leaf index (inclusive).
     * @returns {{ succeed: Boolean, reason: String }}
     */
    async createTask(params) {
        const { socket, key, filePath, startLeaf, endLeaf } = params;

        const controller = new AbortController();
        if (!this.fileTasks.has(filePath)) {
            this.fileTasks.set(filePath, new Set());
        }

        if (!this.deliveryTasksByKey.has(key)) {
            this.deliveryTasksByKey.set(key, new Set());
        }

        this.deliveryTasksByKey.get(key).add({ filePath, controller });

        this.fileTasks.get(filePath).add(controller);

        let fileHandler;
        try {
            fileHandler = await this.fileCache.get(filePath, key);
        } catch (error) {
            fileHandler = null;
        }

        if (!fileHandler) {
            const fileTaskSet = this.fileTasks.get(filePath);
            if (fileTaskSet) {
                fileTaskSet.delete(controller);

                if (fileTaskSet.size === 0) {
                    this.fileTasks.delete(filePath);
                }
            }

            const keyTaskSet = this.deliveryTasksByKey.get(key);
            if (keyTaskSet) {
                // Find and delete the specific task meta object
                for (const item of keyTaskSet) {
                    if (item.controller === controller) {
                        keyTaskSet.delete(item);
                        break;
                    }
                }

                if (keyTaskSet.size === 0) {
                    this.deliveryTasksByKey.delete(key);
                }
            }

            return { succeed: false, reason: MESSAGES.FILE_NOT_ACCESSIBLE_MESSAGE };
        }

        const streamPromise = this.stream({
            socket,
            startLeaf,
            endLeaf,
            key,
            fileHandler,
            signal: controller.signal,
        })
            .then(() => ({ succeed: true, reason: 'Stream completed' }))
            .catch((error) => {

                if (error.message && error.message.includes('aborted')) {
                    return { succeed: false, reason: 'Stream aborted' };
                }

                return { succeed: false, reason: error.message || 'Stream failed' };
            }).finally(() => {
                const fileTaskSet = this.fileTasks.get(filePath);

                if (fileTaskSet) {
                    fileTaskSet.delete(controller);

                    if (fileTaskSet.size === 0) {
                        this.fileTasks.delete(filePath);
                    }
                }

                const keyTaskSet = this.deliveryTasksByKey.get(key);

                if (keyTaskSet) {
                    for (const item of keyTaskSet) {
                        if (item.controller === controller) {
                            keyTaskSet.delete(item);
                            break;
                        }
                    }

                    if (keyTaskSet.size === 0) {
                        this.deliveryTasksByKey.delete(key);
                    }
                }

                this.taskPromises.delete(key);
            });

        this.taskPromises.set(key, streamPromise);
        return { succeed: true, reason: 'task has been created successfully' };

    }

    async stream(params) {
        const { socket, startLeaf, endLeaf, key, fileHandler, signal } = params;

        const keyBuffer = hexToUint8(key);
        const stats = await fileHandler.stat();
        const size = stats.size;

        let abortHandler;

        const abortPromise = new Promise((resolve, reject) => {
            if (signal.aborted) return reject(new Error(`Stream task aborted for key: ${key}`));;

            abortHandler = () => {
                reject(new Error(`Stream task aborted for key: ${key}`));
            }

            signal.addEventListener('abort', abortHandler, { once: true });
        });

        try {
            for (let leafIndex = startLeaf; leafIndex <= endLeaf; leafIndex++) {
                const chunk = await Promise.race([
                    getFileChunk(fileHandler, size, leafIndex, DEFAULT_CHUNK_SIZE),
                    abortPromise
                ]);

                const leafIndexBuffer = Buffer.alloc(4);
                leafIndexBuffer.writeUInt32BE(leafIndex, 0);

                const framedPayload = Buffer.concat([keyBuffer, leafIndexBuffer, chunk]);
                await this.sendStreamToSocket(framedPayload, socket);
            }
        } catch (error) {
            throw error;
        } finally {
            if (abortHandler) {
                signal.removeEventListener('abort', abortHandler);
            }

            await this.fileCache.drop(key);
        }
    }

    /**
     * Wait for a specific task to finish
     * @param {String} key - The task key.
     * @returns {Promise<{ succeed: boolean, reason: string }}
     */
    async waitForTask(key) {
        const promise = this.taskPromises.get(key);
        if (!promise) {
            return { succeed: false, reason: 'No such task' };
        }

        return await promise;
    }

    abortTask(key) {
        const tasks = this.deliveryTasksByKey.get(key);
        if (!tasks || tasks.size === 0) return;

        for (const task of tasks) {
            task.controller.abort();
        }
    }
}