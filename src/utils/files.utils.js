import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import chokidar from 'chokidar';
import { getSpace } from './space.utils.js';
import { eq, and, asc, isNotNull } from 'drizzle-orm';
import { hex, hash, canonicalStringify } from './crypto.utils.js';
import { DEFAULT_CHUNK_SIZE } from '../constants/global.constants.js';
import { isDefined, isNumber, isString, now } from './general.utils.js';
import { generateMerkleTree, getLeafCount } from './merkletree.utils.js';
import { downloadRecord, fileIndex, fileRegistry } from '../database/schemas/file.schema.js';
import {
    createDirectory,
    createEmptyFile,
    fileExists,
    getFileSize,
    openFile,
    closeFile,
    createFileStream
} from './system.utils.js';
import { accountDriveDir } from './accounts.utils.js';
import { parseFilePath } from './parsers.utils.js';

/**
 * Generates a local temporary directory path for a space file.
 * @param {Object} params - The parameters object.
 * @param {string} params.root - The root directory or mount point for the user's drive.
 * @param {string} params.username - The username of the account.
 * @param {string} params.topic - The topic/subdirectory name under the user's drive.
 * @param {string} params.spaceFilePath - A POSIX-style file path within the space
 *   (e.g., `"docs/report.pdf"`). This will be parsed to extract its directory part.
 * @param {string} params.rootHash - The Merkle tree root hash used to create a
 *   unique subdirectory, preventing conflicts between different file versions.
 *
 * @returns {string} The absolute local directory path where temporary source files
 *   for the given space file should be placed. The structure is:
 *   `<driveDir>/<topic>/<rootHash>/<spaceFileDir>`.
 */
export function getTemporarySourcePathForSpaceFile({root, username, topic, spaceFilePath, rootHash}) {
    if (!root || !username || !topic || !spaceFilePath || !rootHash) {
        throw new Error("Invalid parameters for getLocalPathForSpaceFile()");
    }

    const driveDirectory = accountDriveDir(username, root);
    const spaceDirectory = path.join(driveDirectory, topic);
    const parsed = parseFilePath(spaceFilePath);

    return path.join(spaceDirectory, rootHash, parsed.filename);
}

//mapping chokidar library events
export const WatchTypes = {
    ADD: 'add',
    CHANGE: 'change',
    DELETE: 'unlink'
};

/**
 * Wathes multiple files for change using chokidar.
 * @param {string[]} paths - Array of file paths
 */
export function createWatcher(paths) {
    // convert all paths to absolute
    paths.map(p => path.resolve(p));

    const watcher = chokidar.watch(paths, {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: true
    });

    return watcher;
}

/**
 * Computes deterministic hash from file metadata.
 * @param {fs.FileHandle} handler - The read file handler.
 * @returns {Promise<string>} - Hash as hex string.
 */
export async function getFileMetaHash(handler) {
    const stats = await handler.stat();
    const payload = { size: stats.size, time: stats.mtime };
    return hex(hash(canonicalStringify(payload)));
}

/**
 * Computes deterministic hash from file metadata
 * @param {string} filePath - The file path
 * @returns {Promise<string>} - Hash as hex string.
 */
export async function getFileMetaHashFromSource(filePath) {
    const handler = await openFile(filePath);
    const metaHash = await getFileMetaHash(handler);

    await closeFile(handler);
    return metaHash;
}

/**
 * Create space directory from the file source path.
 * @param {string} source - file source path.
 * @returns {string} returns the generated space path.
 */
export const getSpacePathFromSource = source => {
    const baseDirectory = path.resolve(os.homedir());
    const localFilePath = path.resolve(source);

    const relativePath = path.relative(baseDirectory, localFilePath);
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
        return '.';
    }

    return path.dirname(relativePath.replace(/\\/g, '/'));
};

/**
 * Extracts the filename from file source path and return as space filename
 * @param {string} source - file source path.
 * @returns {string} returns the filename.
 */
export const getSpaceFilenameFromSource = source => {
    return path.basename(source);
};

/**
 * Validates space file path.
 * @param {string} spaceFilePath - The file path within the space.
 * @returns {{isValid: boolean, reason: string}}
 */
export function validateSpaceFilePath(spaceFilePath) {
    if (!isDefined(spaceFilePath) || !isString(spaceFilePath)) {
        return { isValid: false, reason: 'spaceFilePath is required to be string' };
    }

    const segments = spaceFilePath.split('/').filter(seg => seg !== '');
    if (segments.some(seg => seg === '..' || seg === '.')) {
        return { isValid: false, reason: 'spaceFilePath path traversal (./ or ../) is not allowed' };
    }

    return { isValid: true, reason: 'spaceFilePath is valid' };
}

/**
 * Builds a normalized payload object for inserting or updating a file registry record.
 * @param {Object} params - Input parameters for the file registry payload.
 * @param {string} params.fileSourcePath - Absolute or relative path to the source file on disk.
 * @param {number} params.timestamp - Optional Unix timestamp (ms or custom epoch used by `now()` fallback).
 * @param {number} params.spaceId - ID of the space this file belongs to.
 * @param {string} params.spacePath - Virtual directory path within the space. If omitted, derived from fileSourcePath.
 * @param {string} params.spaceFilename - Virtual filename within the space. If omitted, derived from fileSourcePath.
 * @param {string} params.rootHash - Root hash of the Merkle tree representing the file.
 * @param {string} params.metaHash - The file metadata hash.
 * @param {number} params.leafCount - Total number of leaf nodes in the Merkle tree.
 * @param {number} params.height - Height (depth) of the Merkle tree. 
 * @returns {Object}
 */
export function buildfileRegistryPayload(params) {
    return {
        fileSourcePath: params.fileSourcePath,
        timestamp: params.timestamp || now(),
        spaceId: params.spaceId,
        spacePath: params.spacePath || getSpacePathFromSource(params.fileSourcePath),
        spaceFilename: params.spaceFilename || getSpaceFilenameFromSource(params.fileSourcePath),
        rootHash: params.rootHash,
        metaHash: params.metaHash,
        leafCount: params.leafCount,
        height: params.height
    };
}

/**
 * Creates a new file registery record in the database.
 * @param {Object} db - Database instance.
 * @param {Object} params - Input paylod.
 * @param {string} params.fileSourcePath - File source path.
 * @param {number} params.timestamp - Timestamp of the file registry.
 * @param {number} params.spaceId - Space ID that the file is assigned to.
 * @param {string} params.spacePath - Space virtual path.
 * @param {string} params.spaceFilename - Space virtual filename.
 * @param {string} params.rootHash - Root hash string of the merkle tree.
 * @param {string} params.metaHash - Hash of the local file's metadata.
 * @param {number} params.leafCount - Number of all leaf node hashes within the merkle tree.
 * @param {number} params.height - Depth value of the merkle tree.
 * @returns {Promise<Object>} Resolves when the record has been inserted into the database
 */
export async function createfileRegistryRecord(db, params) {
    const payload = buildfileRegistryPayload(params);
    const result = await db.insert(fileRegistry).values(payload).returning({ registryId: fileRegistry.id });
    return result[0];
}

/**
 * Get a single file regitry record by ID.
 * @param {Object} db - Database instance.
 * @param {number} registryId - ID of the file registry.
 * @returns {Promise<Object>}
 */
export async function getFileRegistryRecord(db, registryId) {
    return await db.select()
        .from(fileRegistry)
        .where(eq(fileRegistry.id, registryId))
        .get();
}

/**
 * Create query filters for file registry records based on the given criteria.
 * @param {Object} filters - Filter criteria object.
 * @param {number} filters.id - Unique registry ID (primary key).
 * @param {string} filters.fileSourcePath - Original file path on the device.
 * @param {number} filters.timestamp - Unix timestamp when the registry was created.
 * @param {number} filters.spaceId - Foreign key referencing the space.
 * @param {string} filters.spacePath - Virtual directory path within the space.
 * @param {string} filters.spaceFilename - Virtual filename within the space.
 * @param {string} filters.rootHash - Root hash of the Merkle tree (optional).
 * @param {string} filters.metaHash - The file metadata hash.
 * @param {number} filters.leafCount - Total number of leaf nodes in the Merkle tree.
 * @param {number} filters.height - Height of the Merkle tree.
 * @returns {Array} An array of Drizzle equality conditions (`eq`) to be used in a `where()` clause.
 */
function createFileRegistryQueryFilters(filters) {
    const conditions = [];

    if (filters.id !== undefined) {
        conditions.push(eq(fileRegistry.id, filters.id));
    }
    if (filters.fileSourcePath !== undefined) {
        conditions.push(eq(fileRegistry.fileSourcePath, filters.fileSourcePath));
    }
    if (filters.timestamp !== undefined) {
        conditions.push(eq(fileRegistry.timestamp, filters.timestamp));
    }
    if (filters.spaceId !== undefined) {
        conditions.push(eq(fileRegistry.spaceId, filters.spaceId));
    }
    if (filters.spacePath !== undefined) {
        conditions.push(eq(fileRegistry.spacePath, filters.spacePath));
    }
    if (filters.spaceFilename !== undefined) {
        conditions.push(eq(fileRegistry.spaceFilename, filters.spaceFilename));
    }
    if (filters.rootHash !== undefined) {
        conditions.push(eq(fileRegistry.rootHash, filters.rootHash));
    }

    if (filters.metaHash !== undefined) {
        conditions.push(eq(fileRegistry.metaHash, filters.metaHash));
    }

    if (filters.leafCount !== undefined) {
        conditions.push(eq(fileRegistry.leafCount, filters.leafCount));
    }
    if (filters.height !== undefined) {
        conditions.push(eq(fileRegistry.height, filters.height));
    }

    return conditions;
}

/**
 * Query file registry records using filters.
 * @param {Objectc} db - Database instance.
 * @param {Object} filters - Filter criteria object.
 * @param {number} filters.id - Unique registry ID (primary key).
 * @param {string} filters.fileSourcePath - Original file path on the device.
 * @param {number} filters.timestamp - Unix timestamp when the registry was created.
 * @param {number} filters.spaceId - Foreign key referencing the space.
 * @param {string} filters.spacePath - Artificial directory path within the space.
 * @param {string} filters.spaceFilename - Artificial filename within the space.
 * @param {string} filters.rootHash - Root hash of the Merkle tree (optional).
 * @param {string} filters.metaHash - The file metadata hash.
 * @param {number} filters.leafCount - Total number of leaf nodes in the Merkle tree.
 * @param {number} filters.height - Height of the Merkle tree.
 * @returns {Promise<Array>}
 */
export async function queryFileRegistryRecords(db, filters) {
    const conditions = createFileRegistryQueryFilters(filters);
    const query = db.select().from(fileRegistry);

    if (conditions.length > 0) {
        return await query.where(and(...conditions));
    }

    return await query;
}

/**
 * Update a single file registry record by ID.
 * @param {object} db - Database instance.
 * @param {number} registryId - ID of the file registry.
 * @param {Object} params - Input paylod.
 * @param {string} params.fileSourcePath - File source path.
 * @param {number} params.timestamp - Timestamp of the file registry.
 * @param {number} params.spaceId - Space ID that the file is assigned to.
 * @param {string} params.spacePath - Space virtual path.
 * @param {string} params.spaceFilename - Space virtual filename.
 * @param {rootHash} params.rootHash - Root hash string of the merkle tree.
 * @param {string} filters.metaHash - The file metadata hash.
 * @param {number} params.leafCount - Number of all leaf node hashes within the merkle tree.
 * @param {number} params.height - Depth value of the merkle tree.
 * @returns {Promise<void>} - Resolves when the record updated in the database.
 */
export async function updateFileRegistryRecord(db, registryId, params) {
    const payload = buildfileRegistryPayload(params);
    const result = await db.update(fileRegistry)
        .set(payload)
        .where(eq(fileRegistry.id, registryId));

    if (result.rowsAffected === 0) {
        throw new Error(`File registry ${registryId} does not exist`);
    }
}

/**
 * Get referenced space object from registry record.
 * @param {Object} db - Database instace.
 * @param {Object} record - The file registry record.
 * @param {number} record.spaceId - Space ID reference.
 * @returns {Promise<Object>} - Resolves with associated space object.
 */
export async function getSpaceFromRegistryRecord(db, record) {
    if (!record && !record.spaceId) {
        throw new Error('file registry record does not include spaceId paramater');
    }

    const space = await getSpace(db, record.spaceId);
    return space;
}

/**
 * Builds a normalized payload for inserting a Merkle tree node into the file index table.
 * 
 * @param {Object} params - Input parameters for a single Merkle node.
 * @param {number} params.registryId - Foreign key referencing the file registry entry.
 * @param {string} params.rootHash - Root hash of the Merkle tree this node belongs to.
 * @param {number} params.level - Depth level of the node in the Merkle tree (0 = root).
 * @param {string} params.hash - Hash of the current node.
 * @param {string} params.parentHash - Hash of the parent node (if applicable).
 * @param {string} params.leftChildHash - Hash of the left child node (if applicable).
 * @param {string} params.rightChildHash - Hash of the right child node (if applicable).
 * @param {number} params.leafIndex - Index of the leaf node within the leaf level (only defined for leaves).
 * @param {number} params.nodeIndex - Index of the tree-position within the level.
 * 
 * @returns {Object}
 */
export function buildFileIndexPayload(params) {
    return {
        registryId: params.registryId,
        rootHash: params.rootHash,
        level: params.level,
        hash: params.hash,
        parentHash: params.parentHash || null,
        leftChildHash: params.leftChildHash || null,
        rightChildHash: params.rightChildHash || null,
        leafIndex: params.leafIndex || null,
        nodeIndex: params.nodeIndex
    };
}

/**
 * Creates index records into database from Merkle Tree.
 * @param {Object} db - Drizzle database instance.
 * @param {number} registryId - The file registry ID.
 * @param {Object} tree - Generated Merkle Tree.
 * @param {string} tree.rootHash - Root hash of the Merkle Tree.
 * @param {Array<Object>} tree.levels - Levels of the tree containing related nodes.
 * @returns {Promise<void>}
 */
export async function createFileIndexRecord(db, registryId, tree) {
    const rootHash = tree.rootHash;

    const rows = [];

    for (const level of tree.levels) {
        if (!level) continue;

        for (const node of level) {
            await db.insert(fileIndex).values({
                registryId,
                rootHash,
                level: node.level,
                nodeIndex: node.nodeIndex,
                hash: node.hash,
                parentHash: node.parentHash ?? null,
                leftChildHash: node.leftChildHash ?? null,
                rightChildHash: node.rightChildHash ?? null,
                leafIndex: node.leafIndex ?? null,
            });
        }
    }
}

/**
 * Deletes file registry with all related indexing records from database.
 * @param {Object} db - Database instace.
 * @param {number} registryId - ID of the file registry record.
 * @returns {Promise<void>}
 */
export async function deleteFileRecord(db, registryId) {
    await db.delete(fileIndex).where(eq(fileIndex.registryId, registryId));
    await db.delete(downloadRecord).where(eq(downloadRecord.registryId, registryId));
    await db.delete(fileRegistry).where(eq(fileRegistry.id, registryId));
}

/**
 * Fetch Merkle Tree leaf nodes for a file registry.
 * @param {Object} db - Drizzle database instace.
 * @param {number} registryId - File registry ID.
 * 
 * @returns {Promise<Array>}
 */
export async function getFileTreeLeafs(db, registryId) {
    if (!isNumber(registryId)) {
        throw new Error('registryId is invalid');
    }

    const conditions = [
        eq(fileIndex.registryId, registryId),
        isNotNull(fileIndex.leafIndex)
    ];

    return await db.select()
        .from(fileIndex)
        .where(and(...conditions))
        .orderBy(asc(fileIndex.leafIndex));
}

/**
 * Creates file handler from registry file source path.
 * @param {Object} db - Drizle database instance.
 * @param {number} registryId - The file registry ID.
 * @returns {Promise<fs.FileHandle>};
 */
export async function openFileFromRegistry(db, registryId) {
    const registry = await getFileRegistryRecord(db, registryId);

    if (!registry) {
        throw new Error(`File registry not found: ${registryId}`);
    }

    const filePath = registry.fileSourcePath;
    const exists = await fileExists(filePath);

    if (!exists) {
        throw new Error(`file source is not available for registry: ${registryId}`);
    }

    const handler = await openFile(filePath);
    return handler;
}


/**
 * Get file content by the leaf index offset.
 * @param {fs.FileHandle} handler - The file handler.
 * @param {number} fileSize - File size in bytes.
 * @param {number} leafIndex - Merkle tree leaf index.
 * @param {number} chunkSize - Merkle tree chunk size.
 * @returns {Promise<Buffer>}
 */
export async function getFileChunk(handler, fileSize, leafIndex, chunkSize = DEFAULT_CHUNK_SIZE) {
    const offset = leafIndex * chunkSize;

    if (offset >= fileSize) {
        throw new Error(`Leaf index ${leafIndex} out of bounds`);
    }

    const readLength = Math.min(chunkSize, fileSize - offset);
    const buffer = Buffer.alloc(readLength);

    const { bytesRead } = await handler.read(buffer, 0, readLength, offset);
    return buffer.subarray(0, bytesRead);
}

/**
 * Create and insert file tree into database.
 * @param {Object} db - Database instace.
 * @param {Object} params 
 * @param {string} params.fileSourcePath - Local file path.
 * @param {string} params.spacePath - Virtual directory path for space.
 * @param {string} params.spaceFilename - Virtual file name for space.
 * @param {number} params.spaceId - ID of space for reference.
 * @returns {Promise<{registryId: number, rootHash: string, leafCount: number}>} Resolves when the file indexing has been complete.
 */
export async function generateFileTreeRecord(db, params) {
    const {
        fileSourcePath,
        spacePath,
        spaceFilename,
        spaceId,
    } = params;

    const source = path.resolve(fileSourcePath);
    const exists = await fileExists(source);

    if (!exists) {
        throw new Error(`${fileSourcePath} does not exists on disk`);
    }

    const stream = createFileStream(source);
    const size = await getFileSize(source);

    const tree = await generateMerkleTree({
        stream,
        size,
        chunkSize: DEFAULT_CHUNK_SIZE,
    });

    const rootHash = tree.rootHash;
    const leafCount = getLeafCount(size, DEFAULT_CHUNK_SIZE);

    const metaHash = await getFileMetaHashFromSource(source);

    const { registryId } = await createfileRegistryRecord(db, {
        fileSourcePath: source,
        spacePath: spacePath || getSpacePathFromSource(source),
        spaceFilename: spaceFilename || getSpaceFilenameFromSource(source),
        spaceId,
        leafCount: getLeafCount(size, DEFAULT_CHUNK_SIZE),
        height: tree.levels.length - 1,
        rootHash,
        metaHash
    });

    await createFileIndexRecord(db, registryId, tree);

    return {
        registryId,
        rootHash,
        leafCount
    };
}

/**
 * Updates an existing file registry record with a new Merkle tree and metadata hash.
 * @param {Object} db - Drizzle database instance.
 * @param {Object} params - Update parameters.
 * @param {number} params.registryId - The unique identifier of the file registry record to update.
 * @param {string} params.metaHash - The new metadata hash (e.g., from the updated file).
 * @param {Object} params.tree - The new Merkle tree object.
 * @returns {Promise<void>}
 */
export async function updateFileTreeRecord(db, params) {
    const { registryId, metaHash, tree } = params;

    const registry = await getFileRegistryRecord(db, registryId);
    if (!registry) {
        throw new Error("Registry record does not exists");
    }

    await db.delete(fileIndex).where(eq(fileIndex.registryId, registryId));
    await db.delete(downloadRecord).where(eq(downloadRecord.registryId, registryId));

    const height = tree.levels.length - 1;
    await updateFileRegistryRecord(db, registryId, {
        ...registry,
        metaHash: metaHash,
        rootHash: tree.rootHash,
        height: height,
        leafCount: tree.levels[height].length 
    });

    await createFileIndexRecord(db, registryId, tree);
}

/**
 * Get the Merkle Tree from the local file index records.
 * @param {Object} db - Drizzle database instance.
 * @param {number} registryId - The file registry ID.
 * @returns {Promise<{
 *   levels: Array,
 *   height: number,
 *   leafCount: number,
 *   rootHash: Buffer
 * }>}
 */
export async function getFileTreeRecord(db, registryId) {
    const rows = await db.select().from(fileIndex)
        .where(eq(fileIndex.registryId, registryId));

    if (rows.length === 0) return null;

    const rootHash = rows[0].rootHash;
    const levelsMap = new Map();

    for (const row of rows) {
        const level = row.level;
        // create the level if not already exists
        if (!levelsMap.has(level)) {
            levelsMap.set(level, []);
        }

        const node = {
            level: row.level,
            nodeIndex: row.nodeIndex,
            hash: row.hash,
            parentHash: row.parentHash,
            leftChildHash: row.leftChildHash,
            rightChildHash: row.rightChildHash,
            leafIndex: row.leafIndex,
        };

        levelsMap.get(level).push(node);
    }

    // sort nodes by the nodeIndex
    const levels = Array.from(levelsMap.entries())
        .sort(([levelA, nodesA], [levelB, nodesB]) => levelA - levelB)
        .map(([level, nodes]) => {
            nodes.sort((a, b) => a.nodeIndex - b.nodeIndex);
            return nodes;
        });

    const leafCount = levels[levels.length - 1].length ?? 0;

    return {
        rootHash,
        levels,
        height: levels.length - 1,
        leafCount: leafCount,
    };
}

/**
 * Creates a partial download record in database.
 * @param {Object} db - Drizzle database instance.
 * @param {Object} params 
 * @param {string} params.tempFilePath   - Path inside the temporary drive directory.
 * @param {string} params.finalDestination - Real final path for the complete file.
 * @param {number} params.spaceId - Space ID within database.
 * @param {string} params.spacePath - Virtual file path within the space.
 * @param {string} params.spaceFilename - Virtual file name within the space.
 * @param {string} params.rootHash - The root hash of the remote Merkle tree.
 * @param {number} params.leafCount - Total leaves in the tree.
 * @param {number} params.height - Tree height.
 * @returns {Promise<{registryId: number}>}
 */
export async function createDownloadRecord(db, params) {
    const {
        tempFilePath,
        finalDestination,
        spaceId,
        spacePath,
        spaceFilename,
        rootHash,
        leafCount,
        height
    } = params;

    // initiate the local file internally
    await createDirectory(path.dirname(tempFilePath));
    await createEmptyFile(tempFilePath);

    const metaHash = await getFileMetaHashFromSource(tempFilePath);

    const { registryId } = await createfileRegistryRecord(db, {
        fileSourcePath: tempFilePath,
        spaceId,
        spacePath,
        spaceFilename,
        rootHash,
        metaHash,
        leafCount,
        height
    });

    await db.insert(downloadRecord).values({
        registryId,
        lastPushedLeaf: -1,
        finalDestination
    });

    return { registryId };
}

/**
 * Retrieves download record for a given file registry.
 * @param {Object} db - Drizzle database instance. 
 * @param {number} registryId - The file registry ID.
 * @returns {Promise<Object|undefined>} Resolves with the download record instance is exists.
 */
export async function getDownloadRecord(db, registryId) {
    const result = await db
        .select()
        .from(downloadRecord)
        .where(eq(downloadRecord.registryId, registryId))
        .get();

    return result;
}

/**
 * Finishes a completed download by moving the file to its final destination.
 * @param {Object} db - Drizzle database instance.
 * @param {number} registryId - The file registry ID.
 * @returns {Promise<void>}
 */
export async function setDownloadAsComplete(db, registryId) {
    const registry = await getFileRegistryRecord(db, registryId);
    const download = await db.select().from(downloadRecord)
        .where(eq(downloadRecord.registryId, registryId))
        .get();

    if (!download) throw new Error(`No download record for registry ${registryId}`);

    const tempFilePath = registry.fileSourcePath;
    const finalFilePath = download.finalDestination;


    await createDirectory(path.dirname(finalFilePath));
    await fs.rename(tempFilePath, finalFilePath);

    const metaHash = await getFileMetaHashFromSource(finalFilePath);

    await db.update(fileRegistry)
        .set({ fileSourcePath: finalFilePath, metaHash: metaHash })
        .where(eq(fileRegistry.id, registryId));

    await db.delete(downloadRecord)
        .where(eq(downloadRecord.registryId, registryId));
}

/**
 * Write a single leaf of chunk of file to the correct offset.
 * @param {Object} db - Drizzle database instance.
 * @param {Object} params
 * @param {number} params.registryId - The file registry ID.
 * @param {number} params.leafIndex - The downloaded leaf index from the Merkle Tree.
 * @param {Buffer|Uint8Array} params.leafContent - The raw bytes of the leaf to write.
 * @param {fs.FileHandle} params.fileHandler - The write file handler.
 */
export async function updateDownloadRecord(db, params) {
    const {
        registryId,
        leafIndex,
        leafContent,
        fileHandler
    } = params

    const offset = leafIndex * DEFAULT_CHUNK_SIZE;

    await fileHandler.write(leafContent, 0, leafContent.length, offset);

    await db.update(downloadRecord)
        .set({ lastPushedLeaf: leafIndex })
        .where(eq(downloadRecord.registryId, registryId));

    const metaHash = await getFileMetaHash(fileHandler);

    await db.update(fileRegistry)
        .set({ metaHash: metaHash })
        .where(eq(fileRegistry.id, registryId));
}

/**
 * Lists all download records from database.
 * @param {Object} db - Drizzle database instance.
 * @returns {Promise<Array<Object>>}
 */
export async function listDownloadRecords(db) {
    const query = await db.select().from(downloadRecord);
    return query;
}