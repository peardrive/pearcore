import path from "path";
import { SpaceDownloadTask } from "../managers/file.manager.js";
import { SpaceInstance } from "./space.service.js";
import { posixPathJoin } from "../utils/system.utils.js";


/**
 * Lazy proxy interface to inreface single file in space
 */
export class SpaceFileEntry {
    #path;
    #spaceInstance;
    #spaceFileListManager;
    #spaceFileManager;

    /**
     * @param {Object} params 
     * @param {topic} params.path - virtual space file path
     * @param {SpaceInstance} params.spaceInstance - Associated space for the file hierarchy
     * @param {SpaceFileListManager} params.spaceFileListManager - the file-list manager instance
     * @param {SpaceFileManager} params.spaceFileManager - the file manager instance.
     */
    constructor(params) {
        this.#path = params.path;
        this.#spaceInstance = params.spaceInstance;
        this.#spaceFileListManager = params.spaceFileListManager;
        this.#spaceFileManager = params.spaceFileManager;
    }

    /**
     * Get current filename of the the space file.
     */
    get name() {
        return path.basename(this.#path);
    }

    get path() {
        return this.#path;
    }

    /**
     * Lists all the variants (rootHash) of the space file.
     */
    get variants() {
        const topic = this.#spaceInstance.topicHash;
        return this.#spaceFileListManager.get(topic)[this.#path] || {};
    }

    /**
     * Checks if there is any provider currently available to source the file 
     * (including all variants).
     */
    get exists() {
        return Object.keys(this.variants).length > 0;
    }

    /**
     * Create and initiate download task for specific variant of space file.
     * @param {string} rootHash - root hash of the file variant.
     * @param {string} destination - local path destination to place the file.
     * @returns {Promise<SpaceDownloadTask>}
     */
    async download(rootHash, destination) {
        if (this.exists) {
            const key = await this.#spaceFileManager.download(
                this.#spaceInstance,
                this.#path,
                rootHash,
                destination
            );

            const task = this.#spaceFileManager.getDownloadTask(key);
            return task;
        }
    }
}

/**
 * Lazy proxy interface for file hierarchy navigation
 */
export class SpaceFileBrowser {
    #path;
    #spaceInstance;
    #spaceFileListManager;
    #spaceFileManager;

    /**
     * @param {Object} params 
     * @param {string} params.path - virtual space file path
     * @param {SpaceInstance} params.spaceInstance - Associated space for the file hierarchy
     * @param {SpaceFileListManager} params.spaceFileListManager - the file-list manager instance
     * @param {SpaceFileManager} params.spaceFileManager - the file manager instance.
     */
    constructor(params) {
        this.#path = this.normalize(params.path);
        this.#spaceInstance = params.spaceInstance;
        this.#spaceFileListManager = params.spaceFileListManager;
        this.#spaceFileManager = params.spaceFileManager;
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

        return current.filter(p => !p.slice(base.length).includes('/'));
    }

    /**
     * Create file-entry for space file path.
     * @param {string} filePath - Full path to space file.
     * @returns {SpaceFileEntry}
     */
    getFile(filePath) {
        const base = this.normalize(this.#path);

        const instance = new SpaceFileEntry({
            path: posixPathJoin('/', base, filePath),
            spaceInstance: this.#spaceInstance,
            spaceFileListManager: this.#spaceFileListManager,
            spaceFileManager: this.#spaceFileManager
        });

        return instance;
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
                let acc = '';
                for (const part of parts) {
                    acc = acc ? `${acc}/${part}` : part;
                    directories.add(acc);
                }
            }
            else if (parts.length > 0) {
                directories.add(parts[0]);
            }
        }

        return Array.from(directories);
    }

    /**
     * Change directory to new sub-directory.
     * @param {string} subpath
     * @returns {SpaceFileBrowser}
     */
    cd(subpath) {
        const base = this.normalize(this.#path);
        const joined = posixPathJoin('/', base, subpath ?? '/');

        return new SpaceFileBrowser({
            spaceInstance: this.#spaceInstance,
            path: joined,
            spaceFileListManager: this.#spaceFileListManager,
            spaceFileManager: this.#spaceFileManager,
        });
    }
}

export class SpaceDriveService {
    constructor(emitter, { managers }) {
        this.spacefileListManager = managers.spaceFileList;
        this.spaceFileManagaer = managers.spaceFiles;
    }

    /**
     * Get file browser for a given space.
     * @param {SpaceInstance} space - the space record.
     * @returns {SpaceFileBrowser}
     */
    get(space) {
        const browser = new SpaceFileBrowser({
            path: '/',
            spaceInstance: space,
            spaceFileListManager: this.spacefileListManager,
            spaceFileManager: this.spaceFileManagaer
        });

        return browser;
    }
}