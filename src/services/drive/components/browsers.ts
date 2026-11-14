import type { SpaceInstance } from '../../space.service.js';
import { queryFileRegistryRecords } from '../../../utils/files.utils.js';
import { parseFilePath } from '../../../utils/parsers.utils.js';
import { posixPathJoin } from '../../../utils/system.utils.js';
import { SpaceFileEntry, LocalFileEntry } from './entries.js';

export class GenericDriveBrowser {
  [key: string]: any;
  _path;
  _spaceInstance;
  _spaceFileListManager;
  _spaceFileManager;
  _sessionManager;
  _filter: ((record: any) => boolean) | null = null;

  /**
   * @param params
   * @param params.path - virtual space file path
   * @param params.spaceInstance - Associated space for the file hierarchy
   * @param params.spaceFileListManager - the file-list manager instance
   * @param params.spaceFileManager - the file manager instance.
   * @param params.sessionManager
   */
  constructor(params: any) {
    this._path = this.normalize(params.path);
    this._spaceInstance = params.spaceInstance;
    this._spaceFileListManager = params.spaceFileListManager;
    this._spaceFileManager = params.spaceFileManager;
    this._sessionManager = params.sessionManager;
  }

  /**
   * set query filter for file list.
   *
   * @param filter - Predicate applied to each record.
   */
  setQueryFilter(filter: ((record: any) => boolean) | null) {
    this._filter = filter;
  }

  /**
   * Standardize path across casual edge-cases.
   */
  normalize(path: string) {
    const base = path === '/' ? '/' : path + '/';
    return base.replace(/\/+/g, '/');
  }

  /** Get currect active path */
  get path() {
    return this._path;
  }

  /**
   * Returns list of all space file paths (with optional filter using `setQueryFilter(function)`).
   * @returns */
  get _spaceFiles() {
    const topic = this._spaceInstance.topicHash;

    if (!this._filter) {
      return this._spaceFileListManager.get(topic);
    }

    return this._spaceFileListManager.query(topic, this._filter);
  }

  /**
   * Get list of available space files under the current directory.
   * @param [params]
   * @param [params.recursive=false] - list all files recusively (include every child sub-directory)
   * @returns */
  files({ recursive = false }: { recursive?: boolean } = {}) {
    const base = this.normalize(this._path);
    const current = Object.keys(this._spaceFiles).filter(
      (p) => p === base || p.startsWith(base),
    );

    if (recursive) return current;

    return current.filter((p) => !p.slice(base.length).includes('/')).sort();
  }

  /**
   * Create file-entry for space file path.
   */
  getFile(spaceFilePath: string): any {
    throw new Error('Method not implemented');
  }

  /**
   * Get list of available directories under the current directory
   * @param [params]
   * @param [params.recursive=false] - list all directories recusively (include every child sub-directory)
   * @returns */
  folders({ recursive = false }: { recursive?: boolean } = {}) {
    const base = this.normalize(this._path);
    const directories = new Set();

    for (const p of Object.keys(this._spaceFiles)) {
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
      } else if (parts.length > 0) {
        directories.add(parts[0]);
      }
    }

    return Array.from(directories).sort();
  }

  async addFile(spaceFilePath: string, localFilePath: string) {
    const base = this.normalize(this._path);
    const virtualPath = posixPathJoin('/', base, spaceFilePath);

    const entry = new LocalFileEntry({
      path: virtualPath,
      fileSourcePath: localFilePath,
      spaceInstance: this._spaceInstance,
      spaceFileListManager: this._spaceFileListManager,
      spaceFileManager: this._spaceFileManager,
      sessionManager: this._sessionManager,
    });

    this._spaceFileManager.addLocalFile(
      this._spaceInstance,
      virtualPath,
      localFilePath,
      {
        // pass the progress event emitter to the entry
        onIndexingStart: (tracker: any) => {
          entry.setIndexingTracker(tracker);
        },
        // settle the entry and then trigger completion callback
        onComplete: (registryId: number) => {
          entry
            .settle(registryId)
            .then(() => {
              entry.triggerCompletion();
            })
            .catch(() => {});
        },
        // pass the error object from indexing to the entry
        onError: (error: Error) => {
          entry.triggerError(error);
        },
      },
    );

    return entry;
  }

  /**
   * Change directory
   * @param subpath
   */
  cd(subpath: string): any {
    throw new Error('Method not implemented');
  }
}

/**
 * Lazy proxy interface for local file hierarchy navigation
 */
export class LocalDriveBrowser extends GenericDriveBrowser {
  /**
   * @param params
   * @param params.path - virtual space file path
   * @param params.spaceInstance - Associated space for the file hierarchy
   * @param params.spaceFileListManager - the file-list manager instance
   * @param params.spaceFileManager - the file manager instance.
   * @param params.sessionManager
   */
  constructor(params: any) {
    super(params);

    const { publicKey } = this._sessionManager.getCredentials();
    // setting query filter to ensure the file list only contains local files.
    this.setQueryFilter((record) => record.publicKey === publicKey);
  }

  /**
   * Get local file entry for space file path
   * @param localFilePath
   */
  override async getFile(spaceFilePath: string) {
    const { publicKey } = this._sessionManager.getCredentials();
    const { db } = this._sessionManager.getDatabase();
    const variants = this._spaceFiles[spaceFilePath];

    if (!variants) return;

    for (const [variant, info] of Object.entries(variants) as [string, any][]) {
      for (const provider of Object.keys(info.peers)) {
        if (publicKey === provider) {
          const parsed = parseFilePath(spaceFilePath);
          const query = await queryFileRegistryRecords(db, {
            spaceFilename: parsed.filename,
            spacePath: parsed.dir,
            rootHash: variant,
            spaceId: this._spaceInstance.id,
          });

          if (query.length === 0) return;
          const registry = query[0];

          const base = this.normalize(this._path);
          const virtualPath = posixPathJoin('/', base, spaceFilePath);

          const entry = new LocalFileEntry({
            path: virtualPath,
            fileSourcePath: registry.fileSourcePath,
            spaceInstance: this._spaceInstance,
            spaceFileListManager: this._spaceFileListManager,
            spaceFileManager: this._spaceFileManager,
            sessionManager: this._sessionManager,
          });

          await entry.settle(registry.id);

          return entry;
        }
      }
    }
  }

  /**
   * Change directory to new sub-directory.
   * @param subpath
   * @returns */
  override cd(subpath: string) {
    const base = this.normalize(this._path);
    const joined = posixPathJoin('/', base, subpath ?? '/');

    return new LocalDriveBrowser({
      spaceInstance: this._spaceInstance,
      path: joined,
      spaceFileListManager: this._spaceFileListManager,
      spaceFileManager: this._spaceFileManager,
      sessionManager: this._sessionManager,
    });
  }
}

/**
 * Lazy proxy interface for space file hierarchy navigation
 */
export class SpaceDriveBrowser extends GenericDriveBrowser {
  /**
   * @param params
   * @param params.path - virtual space file path
   * @param params.spaceInstance - Associated space for the file hierarchy
   * @param params.spaceFileListManager - the file-list manager instance
   * @param params.spaceFileManager - the file manager instance.
   * @param params.sessionManager
   */
  constructor(params: any) {
    super(params);

    this.setQueryFilter(null); // no filter should be applied
  }

  /**
   * Create file-entry for space file path.
   *
   * Note: this method belongs to a family of interfaces where the caller
   * expects uniform async for `getFile()`.
   *
   * @param spaceFilePath - Full path to space file.
   * @returns */
  override async getFile(spaceFilePath: string) {
    const base = this.normalize(this._path);

    const entry = new SpaceFileEntry({
      path: posixPathJoin('/', base, spaceFilePath),
      spaceInstance: this._spaceInstance,
      spaceFileListManager: this._spaceFileListManager,
      spaceFileManager: this._spaceFileManager,
      sessionManager: this._sessionManager,
    });

    return entry;
  }

  /**
   * Change directory to new sub-directory.
   * @param subpath
   * @returns */
  override cd(subpath: string) {
    const base = this.normalize(this._path);
    const joined = posixPathJoin('/', base, subpath ?? '/');

    return new SpaceDriveBrowser({
      spaceInstance: this._spaceInstance,
      path: joined,
      spaceFileListManager: this._spaceFileListManager,
      spaceFileManager: this._spaceFileManager,
      sessionManager: this._sessionManager,
    });
  }

  /**
   * Return local file browser for current directory.
   * @returns */
  local() {
    return new LocalDriveBrowser({
      spaceInstance: this._spaceInstance,
      path: this._path,
      spaceFileListManager: this._spaceFileListManager,
      spaceFileManager: this._spaceFileManager,
      sessionManager: this._sessionManager,
    });
  }
}
