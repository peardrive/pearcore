import path from "path";
import fs from 'fs/promises';
import { createReadStream } from "fs";
import { DEFAULT_CHUNK_SIZE } from "../constants/global.constants.js";

/**
 * Creates file handler with read-only flag for a given file path.
 * @param {string} filePath - The file source path.
 * @returns {Promise<fs.FileHandle>}
 */
export async function readFile(filePath) {
  const handler = await fs.open(filePath, 'r');
  return handler;
}

/**
 * Creates file handler with read/write flags for a given file path.
 * @param {string} filePath - The file source path.
 * @returns {Promise<fs.FileHandle>}
 */
export async function openFile(filePath) {
  const handler = await fs.open(filePath, 'r+');
  return handler;
}

/**
 * Close system file handler.
 * @param {fs.FileHandle} handler 
 */
export async function closeFile(handler) {
  await handler.close();
}

/**
 * Creates async read stream.
 * @param {string} filePath 
 * @param {number} chunksize 
 */
export function createFileStream(filePath, chunksize = DEFAULT_CHUNK_SIZE) {
  return createReadStream(filePath, { highWaterMark: chunksize });
}

/**
 * Returns final joined path in POSIX format.
 * @param  {...any} paths - all path parameters
 * @returns {string}
 */
export function posixPathJoin(...paths) {
  return path.posix.join(...paths);
}

/**
 * Check if a file or directory exists
 * @param {string} path - The path to check
 * @returns {boolean} - True if exists, false if not
 */
export async function fileExists(path) {
  try {
    await fs.access(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/**
 * Get metadata from local file.
 * @param {string} filePath - Absolute file path.
 * @returns {Promise<object>}
 */
export async function getFileMetadata(filePath) {
  return await fs.stat(filePath);
}

/**
 * Get file size in bytes.
 * @param {string} filePath - Absolute file path.
 * @returns {Promise<number>}
 */
export async function getFileSize(filePath) {
  const stat = await getFileMetadata(filePath);
  return stat.size;
}

/**
 * Create empty file locally.
 * @param {string} filePath - Absolute file path.
 * @returns {Promise<void>}
 */
export async function createEmptyFile(filePath) {
  await fs.writeFile(filePath, '');
}

/**
 * Remove file locally.
 * @param {string} filePath  - Absolute file path.
 * @returns {Promise<void>}
 */
export async function deleteFile(filePath) {
  await fs.rm(filePath);
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 * @param {string} dirPath - Directory path.
 * @returns {Promise<boolean>}
 */
export async function directoryExists(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true })
  } catch (err) {
    if (err.code !== 'EEXIST') throw err
  }
}

/**
 * Create directory locally.
 * @param {string} dirPath - Absolute directory path
 * @returns {Promise<void>}
 */
export async function createDirectory(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * List all subdirectories (accounts) inside a given root directory.
 * @param {string} rootPath
 * @returns {Promise<string[]>} Array of directory names
 */
export async function listSubdirs(rootPath) {
  try {
    const entries = await fs.readdir(rootPath, { withFileTypes: true })
    return entries.filter(e => e.isDirectory()).map(e => e.name)
  } catch {
    return []
  }
}

/**
 * Registers a graceful shutdown handler for SIGINT and SIGTERM.
 *
 * @param {string} name - Name for logging (e.g. "network.utils", "DHT")
 * @param {() => Promise<void>} onShutdown - Async function to call on shutdown
 */
export function registerGracefulShutdown(name, onShutdown) {
  const shutdown = async () => {
    console.warn(`[${name}] Shutting down...`)
    try {
      await onShutdown()
    } catch (err) {
      console.error(`[${name}] Error during shutdown:`, err?.message || err)
    } finally {
      process.exit(0)
    }
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}