import { DEFAULT_CHUNK_SIZE } from '../../../constants/global.constants.js';
import * as MESSAGES from '../../../constants/messages.constants.js';
import { hexToUint8, hex, randomNonce } from '../../../utils/crypto.utils.js';
import { getFileChunk } from '../../../utils/files.utils.js';
import { FrameTypes, type MuxManager } from '../../multiplexer.manager.js';
import type { SessionManager } from '../../session.manager.js';
import type { FileHandlerCache } from './cache.js';
import type { LocalFileWatcher } from './watcher.js';

type DeliveryTask = { 
  filePath: string, 
  controller: AbortController, 
  publicKey: string 
}; 

export interface FileContentDeliveryDependencies {
  sessionManager: Pick<SessionManager, 'getDatabase'>;
  muxManager: Pick<MuxManager, 'send'>;
  fileCache: Pick<FileHandlerCache, 'acquire' | 'release' | 'eject'>;
  /** Shared local-file bus; changes and deletions abort active streams. */
  fileWatcher: Pick<LocalFileWatcher, 'on' | 'off'>;
}

export class FileContentDeliveryManager {
  [key: string]: any;

  fileTasks: Map<string, Set<AbortController>>;
  deliveryTasksByKey: Map<string, Set<DeliveryTask>>;
  taskPromises: Map<string, Promise<{ succeed: boolean, reason: string }>>;

  constructor(managers: FileContentDeliveryDependencies) {
    this.sessionManager = managers.sessionManager;
    this.muxManager = managers.muxManager;
    this.fileCache = managers.fileCache;
    this.fileWatcher = managers.fileWatcher;

    // stable listeners so they can be detached on stop
    this.onFileChange = (filePath: string) => {
      this.abortTasksForFilePath(filePath);
      this.fileCache.eject(filePath).catch(() => {}); // file may already be gone
    };

    this.onFileDelete = (filePath: string) => {
      this.abortTasksForFilePath(filePath);
      this.fileCache.eject(filePath).catch(() => {}); // file may already be gone
    };

    this.fileTasks = new Map(); // filePath -> Set<AbortController>
    this.deliveryTasksByKey = new Map(); // key -> Set<{ filePath, controller, publicKey }>
    this.taskPromises = new Map(); // key -> Promise<{succeed, reason}>
  }

  get db() {
    return this.sessionManager.getDatabase().db;
  }

  createOwner(key: string) {
    return `delivery:${key}:${hex(randomNonce())}`;
  }

  async sendStreamToSocket(stream: Buffer, socket: any) {
    await this.muxManager.send(socket, stream, FrameTypes.STREAM);
  }

  abortTasksForFilePath(filePath: string) {
    const controllers = this.fileTasks.get(filePath);
    if (controllers) {
      for (const controller of controllers) {
        controller.abort();
      }
    }
  }

  async init() {
    // detach first so a repeated init does not register duplicate listeners
    this.fileWatcher.off('change', this.onFileChange);
    this.fileWatcher.off('delete', this.onFileDelete);
    // assign handlers
    this.fileWatcher.on('change', this.onFileChange);
    this.fileWatcher.on('delete', this.onFileDelete);
  }

  async stop() {
    this.fileWatcher.off('change', this.onFileChange);
    this.fileWatcher.off('delete', this.onFileDelete);

    for (const [filePath, controllers] of this.fileTasks) {
      for (const controller of controllers) {
        controller.abort();
      }
    }

    this.fileTasks.clear();
    this.deliveryTasksByKey.clear();
    this.taskPromises.clear();
  }

  /**
   * Creates new delivery task.
   * @param params - The parameters object.
   * @param params.socket - The socket connection instance.
   * @param params.key - The encryption or authentication key.
   * @param [params.publicKey] - Requester public key; scopes `abortTask` to the requester.
   * @param params.filePath - The path to the target file.
   * @param params.startLeaf - The starting leaf index (inclusive).
   * @param params.endLeaf - The ending leaf index (inclusive).
   * @returns */
  async createTask(params: any) {
    const {
      socket,
      key,
      publicKey = null,
      filePath,
      startLeaf,
      endLeaf,
    } = params;

    const controller = new AbortController();
    if (!this.fileTasks.has(filePath)) {
      this.fileTasks.set(filePath, new Set());
    }

    if (!this.deliveryTasksByKey.has(key)) {
      this.deliveryTasksByKey.set(key, new Set());
    }

    this.deliveryTasksByKey.get(key)!.add({ filePath, controller, publicKey });

    this.fileTasks.get(filePath)!.add(controller);

    let fileHandler;
    let fileOwner = null;
    try {
      fileOwner = this.createOwner(key);
      fileHandler = await this.fileCache.acquire(filePath, fileOwner);
    } catch (error) {
      fileHandler = null;
    }

    // in case of failure to acquire file-read lane, 
    // we should abort all tasks that rely on that file.
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
      fileOwner,
      signal: controller.signal,
    })
      .then(() => ({ succeed: true, reason: 'Stream completed' }))
      .catch((error) => {
        if (error.message && error.message.includes('aborted')) {
          return { succeed: false, reason: 'Stream aborted' };
        }

        return { succeed: false, reason: error.message || 'Stream failed' };
      })
      .finally(() => {
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

        if (this.taskPromises.get(key) === streamPromise) {
          this.taskPromises.delete(key);
        }
      });

    this.taskPromises.set(key, streamPromise);
    return { succeed: true, reason: 'task has been created successfully' };
  }

  async stream(params: any) {
    const { socket, startLeaf, endLeaf, key, fileHandler, fileOwner, signal } =
      params;

    const keyBuffer = hexToUint8(key);
    const stats = await fileHandler.stat();
    const size = stats.size;

    let abortHandler;

    const abortPromise = new Promise((resolve, reject) => {
      if (signal.aborted)
        return reject(new Error(`Stream task aborted for key: ${key}`));

      abortHandler = () => {
        reject(new Error(`Stream task aborted for key: ${key}`));
      };

      signal.addEventListener('abort', abortHandler, { once: true });
    });

    try {
      for (let leafIndex = startLeaf; leafIndex <= endLeaf; leafIndex++) {
        const chunk = (await Promise.race([
          getFileChunk(fileHandler, size, leafIndex, DEFAULT_CHUNK_SIZE),
          abortPromise,
        ])) as Buffer;

        const leafIndexBuffer = Buffer.alloc(4);
        leafIndexBuffer.writeUInt32BE(leafIndex, 0);

        const framedPayload = Buffer.concat([
          keyBuffer,
          leafIndexBuffer,
          chunk,
        ]);
        await this.sendStreamToSocket(framedPayload, socket);
      }
    } catch (error) {
      throw error;
    } finally {
      if (abortHandler) {
        signal.removeEventListener('abort', abortHandler);
      }

      if (fileOwner) {
        await this.fileCache.release(fileOwner);
      }
    }
  }

  /**
   * Wait for a specific task to finish
   * @param key - The task key.
   * @returns */
  async waitForTask(key: string) {
    const promise = this.taskPromises.get(key);
    if (!promise) {
      return { succeed: false, reason: 'No such task' };
    }

    return await promise;
  }

  /**
   * Aborts the delivery tasks of a download key.
   * @param key - Download key of the request.
   * @param [publicKey=null] - When given, only tasks requested by this peer are aborted.
   */
  abortTask(key: string, publicKey: string | null = null) {
    const tasks = this.deliveryTasksByKey.get(key);
    if (!tasks || tasks.size === 0) return;

    for (const task of tasks) {
      // when the requester is known, only its own tasks are aborted
      if (publicKey && task.publicKey && task.publicKey !== publicKey) continue;
      task.controller.abort();
    }
  }
}
