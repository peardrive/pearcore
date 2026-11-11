import path from 'path';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import type { ReadStream, Stats } from 'fs';
import { DEFAULT_CHUNK_SIZE } from '../constants/global.constants.js';

/**
 * Creates file handler with read-only flag for a given file path.
 * @param filePath - The file source path.
 */
export async function readFile(filePath: string): Promise<fs.FileHandle> {
  const handler = await fs.open(filePath, 'r');
  return handler;
}

/**
 * Creates file handler with read/write flags for a given file path.
 * @param filePath - The file source path.
 */
export async function openFile(filePath: string): Promise<fs.FileHandle> {
  const handler = await fs.open(filePath, 'r+');
  return handler;
}

/**
 * Close system file handler.
 */
export async function closeFile(handler: fs.FileHandle): Promise<void> {
  await handler.close();
}

/**
 * Creates async read stream.
 */
export function createFileStream(
  filePath: string,
  chunksize: number = DEFAULT_CHUNK_SIZE,
): ReadStream {
  return createReadStream(filePath, { highWaterMark: chunksize });
}

/**
 * Returns final joined path in POSIX format.
 * @param  paths - all path parameters
 */
export function posixPathJoin(...paths: string[]): string {
  return path.posix.join(...paths);
}

/**
 * Check if a file or directory exists
 * @param path - The path to check
 * @returns - True if exists, false if not
 */
export async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Get metadata from local file.
 * @param filePath - Absolute file path.
 */
export async function getFileMetadata(filePath: string): Promise<Stats> {
  return await fs.stat(filePath);
}

/**
 * Get file size in bytes.
 * @param filePath - Absolute file path.
 */
export async function getFileSize(filePath: string): Promise<number> {
  const stat = await getFileMetadata(filePath);
  return stat.size;
}

/**
 * Create empty file locally.
 * @param filePath - Absolute file path.
 */
export async function createEmptyFile(filePath: string): Promise<void> {
  await fs.writeFile(filePath, '');
}

/**
 * Remove file locally.
 * @param filePath  - Absolute file path.
 */
export async function deleteFile(filePath: string): Promise<void> {
  await fs.rm(filePath);
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 * Despite the name it doesn't report existence: it resolves once the directory exists.
 * @param dirPath - Directory path.
 */
export async function directoryExists(dirPath: string): Promise<void> {
  try {
    await fs.mkdir(dirPath, { recursive: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

/**
 * Create directory locally.
 * @param dirPath - Absolute directory path
 */
export async function createDirectory(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * List all subdirectories (accounts) inside a given root directory.
 * @returns Array of directory names
 */
export async function listSubdirs(rootPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Registers a graceful shutdown handler for SIGINT and SIGTERM.
 *
 * @param name - Name for logging (e.g. "network.utils", "DHT")
 * @param onShutdown - Async function to call on shutdown
 */
export function registerGracefulShutdown(
  name: string,
  onShutdown: () => Promise<void>,
): void {
  const shutdown = async () => {
    console.warn(`[${name}] Shutting down...`);
    try {
      await onShutdown();
    } catch (err) {
      console.error(
        `[${name}] Error during shutdown:`,
        (err as Error)?.message || err,
      );
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
