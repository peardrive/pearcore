import path from "path";
import { SessionManager } from "../managers/session.manager.js";
import { SpaceDownloadTask } from "../managers/files/components/downlad.js";
import { SpaceInstance } from "./space.service.js";
import { posixPathJoin } from "../utils/system.utils.js";
import { getFileRegistryRecord } from "../utils/files.utils.js";
import { ProgressTracker } from "../managers/files/components/progress.js";

export class GenericFileEntry {
    _path;
    _spaceInstance;
    _spaceFileListManager;
    _spaceFileManager;
    _sessionManager;

    /**
     * @param {Object} params 
     * @param {topic} params.path - virtual space file path
     * @param {SpaceInstance} params.spaceInstance - Associated space for the file hierarchy
     * @param {SpaceFileListManager} params.spaceFileListManager - the file-list manager instance
     * @param {SpaceFileManager} params.spaceFileManager - the file manager instance.
     * @param {SessionManager}
     */
    constructor(params) {
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
     * @returns {Array<string>} - list of hex hash strings.
     */
    get variants() {
        const topic = this._spaceInstance.topicHash;
        const records = this._spaceFileListManager.get(topic)[this._path] || {};
        return Object.keys(records);
    }

    /**
     * Get current list of providers for a given space file variant.
     * @param {string} rootHash 
     * @returns {Array<string>} - list of provider publicKeys.
     */
    getProvidersForVariant(rootHash) {
        const topic = this._spaceInstance.topicHash;
        const records = this._spaceFileListManager.get(topic)[this._path] || {};
        const providersInfo = records[rootHash].peers || {};
        return Object.keys(providersInfo);
    }
}

/**
 * Virtual space file entry (files that are sourced from space).
 */
export class SpaceFileEntry extends GenericFileEntry {
    /**
     * Create and initiate download task for specific variant of space file.
     * @param {string} rootHash - root hash of the file variant.
     * @param {string} destination - local path destination to place the file.
     * @returns {Promise<SpaceDownloadTask>}
     */
    async download(rootHash, destination) {
        if (this.exists) {
            const key = await this._spaceFileManager.download(
                this._spaceInstance,
                this._path,
                rootHash,
                destination
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
    #fileSourcePath;
    #registryId;
    #rootHash = null;
    #settled = false;
    #tracker = null;
    #error = null;
    #onIndexingCallback;
    #onCompletionCallback;
    #onErrorCallback;

    /**
     * @param {Object} params
     * @param {string} params.path - virtual space file path
     * @param {number|undefined} [params.registryId] - Local file registry ID.
     * @param {SpaceInstance} params.spaceInstance - Associated space for the file hierarchy
     * @param {SpaceFileListManager} params.spaceFileListManager - the file-list manager instance
     * @param {SpaceFileManager} params.spaceFileManager - the file manager instance
     * @param {SessionManager} params.sessionManager
     * @param {string} params.fileSourcePath - absolute local file path backing this entry
     * @param {string} params.rootHash - The root hash of the local file registry.
     */
    constructor(params) {
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
     * @returns {{
     *  id: number,
     *  fileSourcePath: string,
     *  timestamp: number,
     *  spaceId: number,
     *  spacePath: string,
     *  spaceFilename: string,
     *  rootHash: string, 
     *  metaHash: string,
     *  leafCount: number,
     *  height: number
     * }}
     */
    async getRegistry() {
        const { db } = this._sessionManager.getDatabase();
        const registry = await getFileRegistryRecord(db, this.#registryId);
        return registry;
    }

    async settle(registryId) {
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
     * Whether this node currently has its own registry broadcasted to space.
     * @returns {boolean}
     */
    get exists() {
        if (!this.#rootHash) {
            return false;
        }

        const { publicKey } = this._sessionManager.getCredentials();
        const providers = this.getProvidersForVariant(this.#rootHash);

        return Boolean(providers[publicKey]);
    }

    /**
     * Remove local file registry drive.
     * @returns {Promise<void>}
     */
    async remove() {
        if (!this.#registryId) {
            throw new Error(
                `Cannot remove file entry for ${this._path}. registry ID is unkown`
            );
        }

        await this._spaceFileManager.removeLocalFile(this.#registryId);
        this.#registryId = null;
        this.#rootHash = null;
        this.#settled = false;
    }

    /**
     * Get current indexing progress snapshot.
     * @returns {{percent:number|null, contributions:Array}|null}
     */
    get indexingProgress() {
        return this.#tracker?.snapshot();
    }

    /**
     * Set indexing event emitter for the entry.
     * @param {ProgressTracker} tracker 
     */
    setIndexingTracker(tracker) {
        this.#tracker = tracker;
        if (this.#onIndexingCallback) {
            tracker.on('progress', this.#onIndexingCallback);
        }
    }

    /**
     * Listen to local file indexing event.
     * @param {(result: { filePath: string, registryId: number, rootHash: string }) => void} callback 
     */
    onIndexing(callback) {
        this.#onIndexingCallback = callback;
        this.#tracker?.on('progress', callback);
    }

    offIndexingCallback() {
        if (this.#tracker) {
            this.#tracker.off('progress', this.#onIndexingCallback);
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
     * @param {(result: {filePath:string, registryId:number, rootHash:string}) => void} callback
     */
    onComplete(callback) {
        if (this.#settled) {
            callback();
            return;
        }
        
        this.#onCompletionCallback = callback;
    }

    /**
     * 
     * @param {Error} error 
     */
    triggerError(error) {
        this.#onErrorCallback?.(error);
        this.#error = error;
    }

    /**
     * Listen to this entry's indexing failure. Fires immediately if it already failed.
     * @param {(result: {filePath:string, error:Error}) => void} callback
     */
    onError(callback) {
        if (this.#error) {
            callback(this.#error);
        }

        this.#onErrorCallback = callback;
    }
}

/**
 * Lazy proxy interface for file hierarchy navigation
 */
export class SpaceDriveBrowser {
    #path;
    #spaceInstance;
    #spaceFileListManager;
    #spaceFileManager;
    #sessionManager;

    /**
     * @param {Object} params 
     * @param {string} params.path - virtual space file path
     * @param {SpaceInstance} params.spaceInstance - Associated space for the file hierarchy
     * @param {SpaceFileListManager} params.spaceFileListManager - the file-list manager instance
     * @param {SpaceFileManager} params.spaceFileManager - the file manager instance.
     * @param {SessionManager} params.sessionManager
     */
    constructor(params) {
        this.#path = this.normalize(params.path);
        this.#spaceInstance = params.spaceInstance;
        this.#spaceFileListManager = params.spaceFileListManager;
        this.#spaceFileManager = params.spaceFileManager;
        this.#sessionManager = params.sessionManager;
    }

    /**
     * Standardize path across casual edge-cases.
     */
    normalize(path) {
        const base = path === '/' ? '/' : path + '/';
        return base.replace(/\/+/g, '/');
    }

    /** Get currect active path */
    get path() {
        return this.#path;
    }

    /**
     * Returns list of all space file paths.
     * @returns {Object<string, Object>}
     */
    get #spaceFiles() {
        const topic = this.#spaceInstance.topicHash;
        return this.#spaceFileListManager.get(topic);
    }

    /**
     * Get list of available space files under the current directory
     * @param {Object} [params]
     * @param {boolean} [params.recursive=false] - list all files recusively (include every child sub-directory)
     * @returns {Array<string>}
     */
    files({ recursive = false } = {}) {
        const base = this.normalize(this.#path);
        const current = Object.keys(this.#spaceFiles)
            .filter(p =>
                p === base ||
                p.startsWith(base)
            );

        if (recursive) return current;

        return current.filter(p => !p.slice(base.length).includes('/')).sort();
    }

    /**
     * Create file-entry for space file path.
     * @param {string} spaceFilePath - Full path to space file.
     * @returns {SpaceFileEntry}
     */
    getFile(spaceFilePath) {
        const base = this.normalize(this.#path);

        const entry = new SpaceFileEntry({
            path: posixPathJoin('/', base, spaceFilePath),
            spaceInstance: this.#spaceInstance,
            spaceFileListManager: this.#spaceFileListManager,
            spaceFileManager: this.#spaceFileManager,
            sessionManager: this.#sessionManager
        });

        return entry;
    }

    async addFile(spaceFilePath, localFilePath) {
        const base = this.normalize(this.#path);
        const virtualPath = posixPathJoin('/', base, spaceFilePath);

        const entry = new LocalFileEntry({
            path: virtualPath,
            fileSourcePath: localFilePath,
            spaceInstance: this.#spaceInstance,
            spaceFileListManager: this.#spaceFileListManager,
            spaceFileManager: this.#spaceFileManager,
            sessionManager: this.#sessionManager,
        });

        this.#spaceFileManager.addLocalFile(
            this.#spaceInstance,
            virtualPath,
            localFilePath,
            {
                // pass the progress event emitter to the entry
                onIndexingStart: (tracker) => {
                    entry.setIndexingTracker(tracker);
                },
                // settle the entry and then trigger completion callback
                onComplete: (registryId) => {
                    entry.settle(registryId)
                        .then(() => { entry.triggerCompletion(); })
                        .catch(() => {});
                },
                // pass the error object from indexing to the entry
                onError: (error) => {
                    entry.triggerError(error);
                }
            }
        );

        return entry;
    }

    /**
     * Get list of available directories under the current directory
     * @param {Object} [params]
     * @param {boolean} [params.recursive=false] - list all directories recusively (include every child sub-directory)
     * @returns {Array<string>}
     */
    folders({ recursive = false } = {}) {
        const base = this.normalize(this.#path);
        const directories = new Set();

        for (const p of Object.keys(this.#spaceFiles)) {
            if (!p.startsWith(base)) continue;

            // drop the filename from each path
            const parts = p.slice(base.length).split('/');
            parts.pop();

            if (recursive) {
                let accumulate = '';
                for (const part of parts) {
                    accumulate = accumulate ? `${accumulate}/${part}` : part;
                    directories.add(accumulate);
                }
            }
            else if (parts.length > 0) {
                directories.add(parts[0]);
            }
        }

        return Array.from(directories).sort();
    }

    /**
     * Change directory to new sub-directory.
     * @param {string} subpath
     * @returns {SpaceDriveBrowser}
     */
    cd(subpath) {
        const base = this.normalize(this.#path);
        const joined = posixPathJoin('/', base, subpath ?? '/');

        return new SpaceDriveBrowser({
            spaceInstance: this.#spaceInstance,
            path: joined,
            spaceFileListManager: this.#spaceFileListManager,
            spaceFileManager: this.#spaceFileManager,
            sessionManager: this.#sessionManager
        });
    }
}

export class SpaceDriveService {
    constructor(emitter, { managers }) {
        this.sessionManager = managers.sessionManager;
        this.spacefileListManager = managers.spaceFileList;
        this.spaceFileManagaer = managers.spaceFiles;
    }

    /**
     * Get file browser for a given space.
     * @param {SpaceInstance} space - the space record.
     * @returns {SpaceDriveBrowser}
     */
    get(space) {
        const browser = new SpaceDriveBrowser({
            path: '/',
            spaceInstance: space,
            spaceFileListManager: this.spacefileListManager,
            spaceFileManager: this.spaceFileManagaer,
            sessionManager: this.sessionManager
        });

        return browser;
    }
}