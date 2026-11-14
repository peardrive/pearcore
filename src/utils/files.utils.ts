import os from 'os';
import path from 'path';
import fs from 'fs/promises';
import chokidar from 'chokidar';
import { getSpace } from './space.utils.js';
import { eq, and, asc, isNotNull, isNull } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { hex, hash, canonicalStringify } from './crypto.utils.js';
import { DEFAULT_CHUNK_SIZE } from '../constants/global.constants.js';
import { isDefined, isNumber, isString, now } from './general.utils.js';
import { generateMerkleTree, getLeafCount } from './merkletree.utils.js';
import {
  downloadRecord,
  fileIndex,
  fileRegistry,
} from '../database/schemas/file.schema.js';
import {
  createDirectory,
  createEmptyFile,
  fileExists,
  getFileSize,
  openFile,
  readFile,
  closeFile,
  createFileStream,
} from './system.utils.js';
import { accountDriveDir } from './accounts.utils.js';
import { parseFilePath } from './parsers.utils.js';
import type { MerkleNode, MerkleTree } from './merkletree.utils.js';
import type { Database } from '../types/database.js';
import type { SpaceWithWhitelists } from './space.utils.js';

export type FileRegistryRecord = typeof fileRegistry.$inferSelect;
export type FileIndexRecord = typeof fileIndex.$inferSelect;
export type DownloadRecord = typeof downloadRecord.$inferSelect;

export interface FileRegistryInput {
  fileSourcePath: string;
  timestamp?: number;
  spaceId: number;
  spacePath?: string;
  spaceFilename?: string;
  rootHash?: string | null;
  metaHash: string;
  leafCount: number;
  height: number;
}

export interface FileIndexInput {
  registryId: number;
  rootHash: string;
  level: number;
  hash: string;
  parentHash?: string | null;
  leftChildHash?: string | null;
  rightChildHash?: string | null;
  leafIndex?: number | null;
  nodeIndex: number;
}

export type FileRegistryFilters = Partial<FileRegistryRecord>;

export interface GenerateFileTreeRecordInput {
  fileSourcePath: string;
  spacePath?: string;
  spaceFilename?: string;
  spaceId: number;
  onLeaf?: (leafHash: Uint8Array, leafIndex: number) => void;
  tree?: MerkleTree;
}

export interface FileTreeRecord {
  rootHash: string;
  levels: MerkleNode[][];
  height: number;
  leafCount: number;
}

export interface CreateDownloadRecordInput {
  tempFilePath: string;
  finalDestination: string;
  spaceId: number;
  spacePath: string;
  spaceFilename: string;
  rootHash: string;
  leafCount: number;
  height: number;
}

export interface UpdateDownloadRecordInput {
  registryId: number;
  leafIndex: number;
  leafContent: Buffer | Uint8Array;
  fileHandler: fs.FileHandle;
}

interface TemporarySpaceFilePathInput {
  root: string;
  username: string;
  topic: string;
  spaceFilePath: string;
  rootHash: string;
}

export interface FileValidationResult {
  isValid: boolean;
  reason: string;
}

/**
 * Generates a local temporary directory path for a space file.
 * @param params - The parameters object.
 * @param params.root - The root directory or mount point for the user's drive.
 * @param params.username - The username of the account.
 * @param params.topic - The topic/subdirectory name under the user's drive.
 * @param params.spaceFilePath - A POSIX-style file path within the space
 *   (e.g., `"docs/report.pdf"`). This will be parsed to extract its directory part.
 * @param params.rootHash - The Merkle tree root hash used to create a
 *   unique subdirectory, preventing conflicts between different file versions.
 *
 * @returns The absolute local directory path where temporary source files
 *   for the given space file should be placed. The structure is:
 *   `<driveDir>/<topic>/<rootHash>/<spaceFileDir>`.
 */
export function getTemporarySourcePathForSpaceFile({
  root,
  username,
  topic,
  spaceFilePath,
  rootHash,
}: TemporarySpaceFilePathInput): string {
  if (!root || !username || !topic || !spaceFilePath || !rootHash) {
    throw new Error('Invalid parameters for getLocalPathForSpaceFile()');
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
  DELETE: 'unlink',
};

/**
 * Wathes multiple files for change using chokidar.
 * @param paths - Array of file paths
 */
export function createWatcher(
  paths: string[],
): ReturnType<typeof chokidar.watch> {
  // convert all paths to absolute
  paths.map((p) => path.resolve(p));

  const watcher = chokidar.watch(paths, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: true,
  });

  return watcher;
}

/**
 * Computes deterministic hash from file metadata.
 * @param handler - The read file handler.
 * @returns Hash as hex string.
 */
export async function getFileMetaHash(handler: fs.FileHandle): Promise<string> {
  const stats = await handler.stat();
  const payload = { size: stats.size, time: stats.mtime };
  return hex(hash(canonicalStringify(payload)));
}

/**
 * Computes deterministic hash from file metadata
 * @param filePath - The file path
 * @returns Hash as hex string.
 */
export async function getFileMetaHashFromSource(
  filePath: string,
): Promise<string> {
  const handler = await readFile(filePath);
  const metaHash = await getFileMetaHash(handler);

  await closeFile(handler);
  return metaHash;
}

/**
 * Create space directory from the file source path.
 * @param source - file source path.
 * @returns returns the generated space path.
 */
export const getSpacePathFromSource = (source: string): string => {
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
 * @param source - file source path.
 * @returns returns the filename.
 */
export const getSpaceFilenameFromSource = (source: string): string => {
  return path.basename(source);
};

/**
 * Validates space file path.
 * @param spaceFilePath - The file path within the space.
 */
export function validateSpaceFilePath(
  spaceFilePath: unknown,
): FileValidationResult {
  if (!isDefined(spaceFilePath) || !isString(spaceFilePath)) {
    return { isValid: false, reason: 'spaceFilePath is required to be string' };
  }

  const segments = spaceFilePath.split('/').filter((segment) => segment !== '');
  if (segments.some((segment) => segment === '..' || segment === '.')) {
    return {
      isValid: false,
      reason: 'spaceFilePath path traversal (./ or ../) is not allowed',
    };
  }

  return { isValid: true, reason: 'spaceFilePath is valid' };
}

export function buildfileRegistryPayload(
  params: FileRegistryInput,
): typeof fileRegistry.$inferInsert {
  return {
    fileSourcePath: params.fileSourcePath,
    timestamp: params.timestamp || now(),
    spaceId: params.spaceId,
    spacePath:
      params.spacePath || getSpacePathFromSource(params.fileSourcePath),
    spaceFilename:
      params.spaceFilename || getSpaceFilenameFromSource(params.fileSourcePath),
    rootHash: params.rootHash,
    metaHash: params.metaHash,
    leafCount: params.leafCount,
    height: params.height,
  };
}

/**
 * Creates a new file registery record in the database.
 * @param db - Database instance.
 * @param params - Input paylod.
 * @param params.fileSourcePath - File source path.
 * @param params.timestamp - Timestamp of the file registry.
 * @param params.spaceId - Space ID that the file is assigned to.
 * @param params.spacePath - Space virtual path.
 * @param params.spaceFilename - Space virtual filename.
 * @param params.rootHash - Root hash string of the merkle tree.
 * @param params.metaHash - Hash of the local file's metadata.
 * @param params.leafCount - Number of all leaf node hashes within the merkle tree.
 * @param params.height - Depth value of the merkle tree.
 * @returns Resolves when the record has been inserted into the database
 */
export async function createfileRegistryRecord(
  db: Database,
  params: FileRegistryInput,
): Promise<{ registryId: number }> {
  const payload = buildfileRegistryPayload(params);
  const result = await db
    .insert(fileRegistry)
    .values(payload)
    .returning({ registryId: fileRegistry.id });
  return result[0];
}

/**
 * Get a single file regitry record by ID.
 * @param db - Database instance.
 * @param registryId - ID of the file registry.
 */
export async function getFileRegistryRecord(
  db: Database,
  registryId: number,
): Promise<FileRegistryRecord | undefined> {
  return await db
    .select()
    .from(fileRegistry)
    .where(eq(fileRegistry.id, registryId))
    .get();
}

/**
 * Create query filters for file registry records based on the given criteria.
 * @param filters - Filter criteria object.
 * @param filters.id - Unique registry ID (primary key).
 * @param filters.fileSourcePath - Original file path on the device.
 * @param filters.timestamp - Unix timestamp when the registry was created.
 * @param filters.spaceId - Foreign key referencing the space.
 * @param filters.spacePath - Virtual directory path within the space.
 * @param filters.spaceFilename - Virtual filename within the space.
 * @param filters.rootHash - Root hash of the Merkle tree (optional).
 * @param filters.metaHash - The file metadata hash.
 * @param filters.leafCount - Total number of leaf nodes in the Merkle tree.
 * @param filters.height - Height of the Merkle tree.
 * @returns An array of Drizzle equality conditions (`eq`) to be used in a `where()` clause.
 */
function createFileRegistryQueryFilters(filters: FileRegistryFilters): SQL[] {
  const conditions: SQL[] = [];

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
  if (filters.rootHash === null) {
    conditions.push(isNull(fileRegistry.rootHash));
  } else if (filters.rootHash !== undefined) {
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
 * @param db - Database instance.
 * @param filters - Filter criteria object.
 * @param filters.id - Unique registry ID (primary key).
 * @param filters.fileSourcePath - Original file path on the device.
 * @param filters.timestamp - Unix timestamp when the registry was created.
 * @param filters.spaceId - Foreign key referencing the space.
 * @param filters.spacePath - Artificial directory path within the space.
 * @param filters.spaceFilename - Artificial filename within the space.
 * @param filters.rootHash - Root hash of the Merkle tree (optional).
 * @param filters.metaHash - The file metadata hash.
 * @param filters.leafCount - Total number of leaf nodes in the Merkle tree.
 * @param filters.height - Height of the Merkle tree.
 */
export async function queryFileRegistryRecords(
  db: Database,
  filters: FileRegistryFilters = {},
): Promise<FileRegistryRecord[]> {
  const conditions = createFileRegistryQueryFilters(filters);
  const query = db.select().from(fileRegistry);

  if (conditions.length > 0) {
    return await query.where(and(...conditions));
  }

  return await query;
}

/**
 * Update a single file registry record by ID.
 * @param db - Database instance.
 * @param registryId - ID of the file registry.
 * @param params - Input paylod.
 * @param params.fileSourcePath - File source path.
 * @param params.timestamp - Timestamp of the file registry.
 * @param params.spaceId - Space ID that the file is assigned to.
 * @param params.spacePath - Space virtual path.
 * @param params.spaceFilename - Space virtual filename.
 * @param params.rootHash - Root hash string of the merkle tree.
 * @param filters.metaHash - The file metadata hash.
 * @param params.leafCount - Number of all leaf node hashes within the merkle tree.
 * @param params.height - Depth value of the merkle tree.
 * @returns Resolves when the record updated in the database.
 */
export async function updateFileRegistryRecord(
  db: Database,
  registryId: number,
  params: FileRegistryInput,
): Promise<void> {
  const payload = buildfileRegistryPayload(params);
  const result = await db
    .update(fileRegistry)
    .set(payload)
    .where(eq(fileRegistry.id, registryId));

  if (result.changes === 0) {
    throw new Error(`File registry ${registryId} does not exist`);
  }
}

/**
 * Get referenced space object from registry record.
 * @param db - Database instace.
 * @param record - The file registry record.
 * @param record.spaceId - Space ID reference.
 * @returns Resolves with associated space object.
 */
export async function getSpaceFromRegistryRecord(
  db: Database,
  record: Pick<FileRegistryRecord, 'spaceId'>,
): Promise<SpaceWithWhitelists | null> {
  if (!record || !record.spaceId) {
    throw new Error('file registry record does not include spaceId paramater');
  }

  const space = await getSpace(db, record.spaceId);
  return space;
}

/**
 * Builds a normalized payload for inserting a Merkle tree node into the file index table.
 *
 * @param params - Input parameters for a single Merkle node.
 * @param params.registryId - Foreign key referencing the file registry entry.
 * @param params.rootHash - Root hash of the Merkle tree this node belongs to.
 * @param params.level - Depth level of the node in the Merkle tree (0 = root).
 * @param params.hash - Hash of the current node.
 * @param params.parentHash - Hash of the parent node (if applicable).
 * @param params.leftChildHash - Hash of the left child node (if applicable).
 * @param params.rightChildHash - Hash of the right child node (if applicable).
 * @param params.leafIndex - Index of the leaf node within the leaf level (only defined for leaves).
 * @param params.nodeIndex - Index of the tree-position within the level.
 *
 */
export function buildFileIndexPayload(
  params: FileIndexInput,
): typeof fileIndex.$inferInsert {
  return {
    registryId: params.registryId,
    rootHash: params.rootHash,
    level: params.level,
    hash: params.hash,
    parentHash: params.parentHash || null,
    leftChildHash: params.leftChildHash || null,
    rightChildHash: params.rightChildHash || null,
    leafIndex: params.leafIndex || null,
    nodeIndex: params.nodeIndex,
  };
}

/**
 * Creates index records into database from Merkle Tree.
 * @param db - Drizzle database instance.
 * @param registryId - The file registry ID.
 * @param tree - Generated Merkle Tree.
 * @param tree.rootHash - Root hash of the Merkle Tree.
 * @param tree.levels - Levels of the tree containing related nodes.
 */
export async function createFileIndexRecord(
  db: Database,
  registryId: number,
  tree: MerkleTree,
): Promise<void> {
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
 * @param db - Database instace.
 * @param registryId - ID of the file registry record.
 */
export async function deleteFileRecord(
  db: Database,
  registryId: number,
): Promise<void> {
  await db.delete(fileIndex).where(eq(fileIndex.registryId, registryId));
  await db
    .delete(downloadRecord)
    .where(eq(downloadRecord.registryId, registryId));
  await db.delete(fileRegistry).where(eq(fileRegistry.id, registryId));
}

/**
 * Fetch Merkle Tree leaf nodes for a file registry.
 * @param db - Drizzle database instace.
 * @param registryId - File registry ID.
 *
 */
export async function getFileTreeLeafs(
  db: Database,
  registryId: number,
): Promise<FileIndexRecord[]> {
  if (!isNumber(registryId)) {
    throw new Error('registryId is invalid');
  }

  const conditions = [
    eq(fileIndex.registryId, registryId),
    isNotNull(fileIndex.leafIndex),
  ];

  return await db
    .select()
    .from(fileIndex)
    .where(and(...conditions))
    .orderBy(asc(fileIndex.leafIndex));
}

/**
 * Creates file handler from registry file source path.
 * @param db - Drizle database instance.
 * @param registryId - The file registry ID.
 */
export async function openFileFromRegistry(
  db: Database,
  registryId: number,
): Promise<fs.FileHandle> {
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
 * @param handler - The file handler.
 * @param fileSize - File size in bytes.
 * @param leafIndex - Merkle tree leaf index.
 * @param chunkSize - Merkle tree chunk size.
 */
export async function getFileChunk(
  handler: fs.FileHandle,
  fileSize: number,
  leafIndex: number,
  chunkSize: number = DEFAULT_CHUNK_SIZE,
): Promise<Buffer> {
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
 * @param db - Database instace.
 * @param [params]
 * @param [params.fileSourcePath] - Local file path.
 * @param [params.spacePath] - Virtual directory path for space.
 * @param [params.spaceFilename] - Virtual file name for space.
 * @param [params.spaceId] - ID of space for reference.
 * @param [params.onLeaf] - optional callback to track sequential progress of leaf generation (only if params.tree has not passed).
 * @param [params.tree] - optional, pass generated Merkle tree if you already obtain it.
 * @param [params.tree.rootHash] - root hash of the generated Merkle tree.
 * @param [params.tree.levels] - Levels of the generated merkle tree (check documentation for generateMerkleTree).
 * @returns Resolves when the file indexing has been complete.
 */
export async function generateFileTreeRecord(
  db: Database,
  params: GenerateFileTreeRecordInput,
): Promise<{ registryId: number; rootHash: string; leafCount: number }> {
  const { fileSourcePath, spacePath, spaceFilename, spaceId, onLeaf } = params;

  const source = path.resolve(fileSourcePath);
  const exists = await fileExists(source);

  if (!exists) {
    throw new Error(`${fileSourcePath} does not exists on disk`);
  }

  const size = await getFileSize(source);

  let tree: MerkleTree;
  let stream: ReturnType<typeof createFileStream> | undefined;

  if (params.tree) {
    tree = params.tree;
  } else {
    try {
      stream = createFileStream(source);
      tree = await generateMerkleTree({
        stream,
        size,
        chunkSize: DEFAULT_CHUNK_SIZE,
        onLeaf: onLeaf,
      });
    } catch (error) {
      throw new Error(`Generating Merkle tree failed for ${fileSourcePath}`, {
        cause: error,
      });
    } finally {
      if (stream && !stream.destroyed) {
        await stream.destroy();
      }
    }
  }

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
    metaHash,
  });

  await createFileIndexRecord(db, registryId, tree);

  return {
    registryId,
    rootHash,
    leafCount,
  };
}

/**
 * Updates an existing file registry record with a new Merkle tree and metadata hash.
 * @param db - Drizzle database instance.
 * @param params - Update parameters.
 * @param params.registryId - The unique identifier of the file registry record to update.
 * @param params.metaHash - The new metadata hash (e.g., from the updated file).
 * @param params.tree - The new Merkle tree object.
 */
export async function updateFileTreeRecord(
  db: Database,
  params: {
    registryId: number;
    metaHash: string;
    tree: MerkleTree;
  },
): Promise<void> {
  const { registryId, metaHash, tree } = params;

  const registry = await getFileRegistryRecord(db, registryId);
  if (!registry) {
    throw new Error('Registry record does not exists');
  }

  await db.delete(fileIndex).where(eq(fileIndex.registryId, registryId));
  await db
    .delete(downloadRecord)
    .where(eq(downloadRecord.registryId, registryId));

  const height = tree.levels.length - 1;
  await updateFileRegistryRecord(db, registryId, {
    ...registry,
    metaHash: metaHash,
    rootHash: tree.rootHash,
    height: height,
    leafCount: tree.levels[height]?.length ?? 0,
  });

  await createFileIndexRecord(db, registryId, tree);
}

/**
 * Get the Merkle Tree from the local file index records.
 * @param db - Drizzle database instance.
 * @param registryId - The file registry ID.
 */
export async function getFileTreeRecord(
  db: Database,
  registryId: number,
): Promise<FileTreeRecord | null> {
  const rows = await db
    .select()
    .from(fileIndex)
    .where(eq(fileIndex.registryId, registryId));

  if (rows.length === 0) return null;

  const rootHash = rows[0].rootHash;
  const levelsMap = new Map<number, MerkleNode[]>();

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

    levelsMap.get(level)!.push(node);
  }

  // sort nodes by the nodeIndex
  const levels = Array.from(levelsMap.entries())
    .sort(([levelA, nodesA], [levelB, nodesB]) => levelA - levelB)
    .map(([level, nodes]) => {
      nodes.sort((a, b) => a.nodeIndex - b.nodeIndex);
      return nodes;
    });

  const leafCount = levels[levels.length - 1]?.length ?? 0;

  return {
    rootHash,
    levels,
    height: levels.length - 1,
    leafCount: leafCount,
  };
}

/**
 * Creates a partial download record in database.
 * @param db - Drizzle database instance.
 * @param params
 * @param params.tempFilePath   - Path inside the temporary drive directory.
 * @param params.finalDestination - Real final path for the complete file.
 * @param params.spaceId - Space ID within database.
 * @param params.spacePath - Virtual file path within the space.
 * @param params.spaceFilename - Virtual file name within the space.
 * @param params.rootHash - The root hash of the remote Merkle tree.
 * @param params.leafCount - Total leaves in the tree.
 * @param params.height - Tree height.
 */
export async function createDownloadRecord(
  db: Database,
  params: CreateDownloadRecordInput,
): Promise<{ registryId: number }> {
  const {
    tempFilePath,
    finalDestination,
    spaceId,
    spacePath,
    spaceFilename,
    rootHash,
    leafCount,
    height,
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
    height,
  });

  await db.insert(downloadRecord).values({
    registryId,
    lastPushedLeaf: -1,
    finalDestination,
  });

  return { registryId };
}

/**
 * Retrieves download record for a given file registry.
 * @param db - Drizzle database instance.
 * @param registryId - The file registry ID.
 * @returns Resolves with the download record instance is exists.
 */
export async function getDownloadRecord(
  db: Database,
  registryId: number,
): Promise<DownloadRecord | undefined> {
  const result = await db
    .select()
    .from(downloadRecord)
    .where(eq(downloadRecord.registryId, registryId))
    .get();

  return result;
}

/**
 * Finishes a completed download by moving the file to its final destination.
 * @param db - Drizzle database instance.
 * @param registryId - The file registry ID.
 */
export async function setDownloadAsComplete(
  db: Database,
  registryId: number,
): Promise<void> {
  const registry = await getFileRegistryRecord(db, registryId);
  if (!registry) {
    throw new Error(`File registry not found: ${registryId}`);
  }

  const download = await db
    .select()
    .from(downloadRecord)
    .where(eq(downloadRecord.registryId, registryId))
    .get();

  if (!download)
    throw new Error(`No download record for registry ${registryId}`);

  const tempFilePath = registry.fileSourcePath;
  const finalFilePath = download.finalDestination;

  await createDirectory(path.dirname(finalFilePath));
  await fs.rename(tempFilePath, finalFilePath);

  const metaHash = await getFileMetaHashFromSource(finalFilePath);

  await db
    .update(fileRegistry)
    .set({ fileSourcePath: finalFilePath, metaHash: metaHash })
    .where(eq(fileRegistry.id, registryId));

  await db
    .delete(downloadRecord)
    .where(eq(downloadRecord.registryId, registryId));
}

/**
 * Write a single leaf of chunk of file to the correct offset.
 * @param db - Drizzle database instance.
 * @param params
 * @param params.registryId - The file registry ID.
 * @param params.leafIndex - The downloaded leaf index from the Merkle Tree.
 * @param params.leafContent - The raw bytes of the leaf to write.
 * @param params.fileHandler - The write file handler.
 */
export async function updateDownloadRecord(
  db: Database,
  params: UpdateDownloadRecordInput,
): Promise<void> {
  const { registryId, leafIndex, leafContent, fileHandler } = params;

  const offset = leafIndex * DEFAULT_CHUNK_SIZE;

  await fileHandler.write(leafContent, 0, leafContent.length, offset);

  await db
    .update(downloadRecord)
    .set({ lastPushedLeaf: leafIndex })
    .where(eq(downloadRecord.registryId, registryId));

  const metaHash = await getFileMetaHash(fileHandler);

  await db
    .update(fileRegistry)
    .set({ metaHash: metaHash })
    .where(eq(fileRegistry.id, registryId));
}

/**
 * Lists all download records from database.
 * @param db - Drizzle database instance.
 */
export async function listDownloadRecords(
  db: Database,
): Promise<DownloadRecord[]> {
  const query = await db.select().from(downloadRecord);
  return query;
}
