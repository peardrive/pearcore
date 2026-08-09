import { DEFAULT_CHUNK_SIZE } from '../constants/global.constants.js';
import * as EVENTS from '../constants/events.constants.js';
import * as MESSAGES from '../constants/messages.constants.js';
import { createChild } from "../logger.js";
import { hexToUint8 } from '../utils/crypto.utils';
import { getFileChunk } from '../utils/files.utils.js';

const logger = createChild('FileContentDelivery');

export class FileHandlerCache {
    constructor() {
        this.handlers = new Map();
    }

    async get(key, filepath) { }
    async clear(key) { }
    async eject() {}
    async stop() { }
}

export class FileContentDeliveryManager {
    constructor(emitter, managers) {
        this.emitter = emitter;
        this.sessionManager = managers.sessionManager;
        this.messageManager = managers.messageManager;
        this.muxManager = managers.muxManager;

        this.fileCache = new FileHandlerCache();
        this.publicKeyRateCounter = new Map(); // publicKey -> counter
        this.fileTasks = new Map(); // filePath -> AbortController
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    get maxConcurrentPerPublicKey() {
        return this.sessionManager.session.get('files.maxConcurrentPerPublicKey');
    }

    async sendStreamToSocket(stream, socket) {
        await this.muxManager.send(socket, stream, FrameTypes.STREAM);
    }

    abortFileTasks(filePath) {
        const controllers = this.fileTasks.get(filePath);
        if (controllers) {
            for (const controller of controllers) {
                controller.abort();
            }

            this.fileTasks.delete(filePath);
        }
    }

    async init() {
        this.emitter.on(EVENTS.LocalFileChange, filePath => {
            this.abortFileTasks(filePath);
            this.fileCache.eject(filePath);
        });

        this.emitter.on(EVENTS.LocalFileDetele, filePath => {
            this.abortFileTasks(filePath);
            this.fileCache.eject(filePath);
        });
    }

    /**
     * Creates new delivery task.
    * @param {Object} params - The parameters object.
    * @param {Socket} params.socket - The WebSocket connection instance.
    * @param {string|Buffer} params.key - The encryption or authentication key.
    * @param {string} params.filePath - The path to the target file.
    * @param {number} params.startLeaf - The starting leaf index (inclusive).
    * @param {number} params.endLeaf - The ending leaf index (inclusive).
    * @param {string|Buffer} params.publicKey - The public key for cryptographic operations.
     * @returns {{ succeed: Boolean, reason: String }}
     */
    async createTask(params) {
        const { socket, key, filePath, startLeaf, endLeaf, publicKey } = params;

        const current = this.publicKeyRateCounter.get(publicKey) || 0;
        if (current >= this.maxConcurrentPerPublicKey) {
            return { succeed: false, reason: MESSAGES.CONTENT_REQUEST_RATE_EXCEEDED };
        }

        const fileHandler = await this.fileCache.get(filePath);
        if (!fileHandler) {
            return { succeed: false, reason: MESSAGES.FILE_NOT_ACCESSIBLE_MESSAGE };
        }

        this.publicKeyRateCounter.set(
            publicKey,
            (this.publicKeyRateCounter.get(publicKey) || 0) + 1
        );

        const controller = new AbortController();
        if (!this.fileTasks.has(filePath)) {
            this.fileTasks.set(filePath, new Set());
        }

        this.fileTasks.get(filePath).add(controller);

        this.stream({
            socket,
            startLeaf,
            endLeaf,
            key,
            fileHandler,
            filePath,
            signal: controller.signal,
        }).catch((error) => {
            logger.error('Streaming file content failed', { error });
        }).finally(() => {
            // clearing the task after the stream
            const tasks = this.fileTasks.get(filePath);
            if (tasks) {
                tasks.delete(controller);

                if (tasks.size === 0) {
                    this.fileTasks.delete(filePath);
                }
            }

            const count = this.publicKeyRateCounter.get(publicKey) || 0;
            if (count > 0) {
                this.publicKeyRateCounter.set(publicKey, count - 1);
            }
        });
    }

    async stream(params) {
        const { socket, startLeaf, endLeaf, key, fileHandle, filePath, signal } = params;
        const keyBuffer = hexToUint8(key);
        // calculate file size in bytes
        const stats = await fileHandler.stat();
        const size = stats.size;

        try {
            for (let leafIndex = startLeaf; leafIndex <= endLeaf; leafIndex++) {
                // stop the stream once the task aborted
                if (signal.aborted) {
                    logger.info('Stream aborted', {
                        filePath: filePath,
                        leafIndex: leafIndex
                    });

                    break;
                }

                const chunk = await getFileChunk(fileHandle, size, leafIndex, DEFAULT_CHUNK_SIZE);

                const leafIndexBuffer = Buffer.alloc(4);
                leafIndexBuffer.writeUInt32BE(leafIndex, 0);

                const framedPayload = Buffer.concat([keyBuffer, leafIndexBuffer, chunk]);
                await this.sendStreamToSocket(framedPayload, socket);
            }
        } catch (error) {
            logger.error('Streaming failed in the middle of the task', {
                key: key,
                error: error
            });
        } finally {
            await this.fileCache.clear(key);
        }
    }

    async stop() {
        await this.fileCache.stop();
        this.publicKeyRateCounter.clear();
    }
}