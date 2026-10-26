import path from 'path';
import fs from 'fs/promises';
import { sql } from 'drizzle-orm';
import { createReadStream } from 'fs';
import { DEFAULT_CHUNK_SIZE } from '../../src/constants/global.constants.js';
import { describe, it, afterEach, beforeEach, expect } from "vitest";
import { createSpace } from '../../src/utils/space.utils.js';
import { generateMerkleTree, getLeafCount, validateMerkleTree, verifyMerkleTree } from '../../src/utils/merkleTree.utils.js';
import { cleanup, makeTempDir, generateRandomFile, createTempDatabase, buildTestSpacePayload, createNestedFiles } from '../general.utils.js';
import { createFileStream, fileExists, getFileSize, openFile, closeFile } from '../../src/utils/system.utils.js';
import { validateHexString } from '../../src/utils/general.utils.js';
import { hex, hash } from '../../src/utils/crypto.utils.js';
import {
    createfileRegistryRecord,
    createDownloadRecord,
    generateFileTreeRecord,
    getDownloadRecord,
    getFileChunk,
    getFileMetaHash,
    getFileRegistryRecord,
    getFileTreeRecord,
    getFileTreeLeafs,
    openFileFromRegistry,
    updateDownloadRecord,
    setDownloadAsComplete,
    getFileMetaHashFromSource,
    updateFileTreeRecord
} from '../../src/utils/files.utils.js';

describe('File Utils', () => {
    let filePath = null;
    let fileSize = 1; // MBs
    let spaceId = null;
    let root = null;
    let db = null;

    beforeEach(async () => {
        root = await makeTempDir();
        const { db: dbInstance } = await createTempDatabase();
        db = dbInstance;

        filePath = path.join(root, 'tempfile');
        await generateRandomFile(filePath, fileSize);

        const spacePayload = await buildTestSpacePayload({ spaceName: 'test' });
        const space = await createSpace(db, spacePayload);
        spaceId = space.spaceId;
    })

    afterEach(async () => {
        await cleanup(root);
    })

    describe('getFileMetaHash', () => {
        it('should generate valid hash for local file', async () => {
            const handler = await openFile(filePath);
            const result = await getFileMetaHash(handler);
            expect(result.length).toBe(64);
            expect(validateHexString(result)).toBe(true);

            await closeFile(handler);
        });
    });

    describe('getFileChunk', () => {
        it('should retrieve each chunk by index and match the leaf hash', async () => {
            const stream = createFileStream(filePath);
            const size = await getFileSize(filePath);
            const tree = await generateMerkleTree({
                stream,
                size,
                chunkSize: DEFAULT_CHUNK_SIZE,
            });

            const leafCount = getLeafCount(size, DEFAULT_CHUNK_SIZE);
            const handler = await openFile(filePath);

            for (let i = 0; i < leafCount; i++) {
                const chunk = await getFileChunk(handler, size, i, DEFAULT_CHUNK_SIZE);
                const chunkHash = hex(hash(chunk));
                const expectedHash = tree.levels[tree.height][i].hash;
                expect(chunkHash).toBe(expectedHash);
            }

            await closeFile(handler);
        });

        it('should throw an erro when the leafIndex is out of bounds', async () => {
            const size = await getFileSize(filePath);
            const handler = await openFile(filePath);

            await expect(getFileChunk(handler, size, 100000000, DEFAULT_CHUNK_SIZE))
                .rejects.toThrow('out of bounds');

            await closeFile(handler);
        });
    });

    describe('generateFileTreeRecord', () => {
        it('should successfully insert Merkle Tree record of file into database', async () => {
            const { registryId, fileIndexRecords } = await generateFileTreeRecord(db, {
                fileSourcePath: filePath,
                spaceId: spaceId
            });

            const registry = await getFileRegistryRecord(db, registryId);
            expect(registry.id).toBe(registryId);
            expect(registry.fileSourcePath).toBe(filePath);
            expect(registry.spaceId).toBe(spaceId);

            const leafs = await getFileTreeLeafs(db, registryId);
            const fileSize = await getFileSize(filePath);

            const expectedLeafCount = Math.ceil(fileSize / DEFAULT_CHUNK_SIZE);
            expect(leafs.length).toBe(expectedLeafCount);

            const rootHash = registry.rootHash;
            leafs.forEach((leaf, index) => {
                expect(leaf.registryId).toBe(registryId);
                expect(leaf.rootHash).toBe(rootHash);
                expect(validateHexString(leaf.hash)).toBe(true);
                expect(validateHexString(leaf.parentHash)).toBe(true);
                expect(leaf.leftChildHash).toBeNull();
                expect(leaf.rightChildHash).toBeNull();
                expect(leaf.nodeIndex).toBe(index);
                expect(leaf.leafIndex).toBe(index);
            });
        });
    });

    describe('generateFileTreeRecord — one file in a second space', () => {
        let spaceB = null;
        let rowA = null;

        // Mark the first row's leaf 0 so a COPIED index is told apart from a
        // re-hashed one: a copy carries the mark, a fresh hash does not.
        const MARK = 'ab'.repeat(32);
        const markLeaf0 = (registryId) => db.run(sql`UPDATE file_index SET hash = ${MARK} WHERE file_registry_id = ${registryId} AND leaf_index = 0`);
        const leaf0 = async (registryId) => (await getFileTreeLeafs(db, registryId))[0].hash;

        beforeEach(async () => {
            const payload = await buildTestSpacePayload({ spaceName: 'second' });
            spaceB = (await createSpace(db, payload)).spaceId;
            rowA = await generateFileTreeRecord(db, { fileSourcePath: filePath, spaceId });
        });

        it('copies the tree of the same unchanged file instead of hashing it again', async () => {
            await markLeaf0(rowA.registryId);
            const rowB = await generateFileTreeRecord(db, { fileSourcePath: filePath, spaceId: spaceB });

            expect(rowB.registryId).not.toBe(rowA.registryId);
            expect(rowB.rootHash).toBe(rowA.rootHash);
            expect(rowB.leafCount).toBe(rowA.leafCount);
            expect(await leaf0(rowB.registryId)).toBe(MARK);

            const a = await getFileRegistryRecord(db, rowA.registryId);
            const b = await getFileRegistryRecord(db, rowB.registryId);
            expect(b.spaceId).toBe(spaceB);
            expect(b.metaHash).toBe(a.metaHash);
            expect(b.height).toBe(a.height);
            const count = (id) => db.get(sql`SELECT count(*) AS n FROM file_index WHERE file_registry_id = ${id}`).n;
            expect(count(rowB.registryId)).toBe(count(rowA.registryId));
        });

        it('hashes again when the file changed since (metaHash differs)', async () => {
            await markLeaf0(rowA.registryId);
            const later = new Date(Date.now() + 60_000);
            await fs.utimes(filePath, later, later);
            const rowB = await generateFileTreeRecord(db, { fileSourcePath: filePath, spaceId: spaceB });
            expect(await leaf0(rowB.registryId)).not.toBe(MARK);
        });

        it('never copies from a download in progress', async () => {
            await markLeaf0(rowA.registryId);
            db.run(sql`INSERT INTO partial_download_record (registry_id, last_pushed_leaf, final_destination) VALUES (${rowA.registryId}, 0, ${filePath})`);
            const rowB = await generateFileTreeRecord(db, { fileSourcePath: filePath, spaceId: spaceB });
            expect(await leaf0(rowB.registryId)).not.toBe(MARK);
        });

        it('keeps the copy whole when the first row is removed', async () => {
            const rowB = await generateFileTreeRecord(db, { fileSourcePath: filePath, spaceId: spaceB });
            const before = await getFileTreeRecord(db, rowB.registryId);
            db.run(sql`DELETE FROM file_index WHERE file_registry_id = ${rowA.registryId}`);
            db.run(sql`DELETE FROM file_registry WHERE id = ${rowA.registryId}`);
            expect(await getFileTreeRecord(db, rowB.registryId)).toEqual(before);
        });
    });

    describe('updateFileTreeRecord', async () => {
        let registryId = null;
        let oldTree = null;
        let oldMetaHash = null;

        beforeEach(async () => {
            const result = await generateFileTreeRecord(db, {
                fileSourcePath: filePath,
                spaceId: spaceId
            });

            registryId = result.registryId;

            oldTree = await getFileTreeRecord(db, registryId);
            const registery = await getFileRegistryRecord(db, registryId);
            oldMetaHash = registery.metaHash;
        });

        it('should update all tree fields and delete old indexes when the file content changes', async () => {
            const newFilePath = path.join(root, 'newfile.dat');
            await generateRandomFile(newFilePath, 2); // 2 MB vs original 1 MB

            const stream = createFileStream(newFilePath);
            const size = await getFileSize(newFilePath);
            const newTree = await generateMerkleTree({
                stream,
                size,
                chunkSize: DEFAULT_CHUNK_SIZE,
            });
            
            const newMetaHash = await getFileMetaHashFromSource(newFilePath);

            await createDownloadRecord(db, {
                tempFilePath: path.join(root, 'temp'),
                finalDestination: path.join(root, 'final'),
                spaceId: spaceId,
                spacePath: '/',
                spaceFilename: 'old.dat',
                rootHash: oldTree.rootHash,
                leafCount: oldTree.leafCount,
                height: oldTree.height,
            });

            await updateFileTreeRecord(db, {
                registryId,
                metaHash: newMetaHash,
                tree: newTree
            });

            const updatedRegistry = await getFileRegistryRecord(db, registryId);
            expect(updatedRegistry.rootHash).toBe(newTree.rootHash);
            expect(updatedRegistry.metaHash).toBe(newMetaHash);
            expect(updatedRegistry.height).toBe(newTree.levels.length - 1);
            expect(updatedRegistry.leafCount).toBe(getLeafCount(size, DEFAULT_CHUNK_SIZE));

            const leafs = await getFileTreeLeafs(db, registryId);
            expect(leafs.length).toBe(updatedRegistry.leafCount);

            const rootHash = updatedRegistry.rootHash;
            leafs.forEach((leaf, index) => {
                expect(leaf.registryId).toBe(registryId);
                expect(leaf.rootHash).toBe(rootHash);
                expect(leaf.leafIndex).toBe(index);
                expect(leaf.nodeIndex).toBe(index);
                expect(validateHexString(leaf.hash)).toBe(true);
            });

            const download = await getDownloadRecord(db, registryId);
            expect(download).not.toBeDefined();
        });
    });

    describe('getFileFromRegistry', () => {
        it('should return valid file handler', async () => {
            const { registryId } = await generateFileTreeRecord(db, {
                fileSourcePath: filePath,
                spaceId: spaceId
            });

            const handler = await openFileFromRegistry(db, registryId);
            expect(handler).toBeDefined();

            await closeFile(handler);
        });

        it('should throw error when the file does not exists', async () => {
            const nonExistentPath = path.join(root, 'does-not-exist.dat');
            const spacePayload2 = await buildTestSpacePayload({ spaceName: 'missing' });
            const space2 = await createSpace(db, spacePayload2);
            const metaHash2 = 'a'.repeat(32); // dummy
            const { registryId: missingId } = await createfileRegistryRecord(db, {
                fileSourcePath: nonExistentPath,
                spaceId: space2.spaceId,
                spacePath: '/',
                spaceFilename: 'missing.dat',
                rootHash: '0'.repeat(64),
                metaHash: metaHash2,
                leafCount: 1,
                height: 0
            });
            // Ensure the file doesn't exist
            expect(await fileExists(nonExistentPath)).toBe(false);

            await expect(openFileFromRegistry(db, missingId))
                .rejects.toThrow(/file source is not available for registry/);
        });
    });

    describe('getFileTreeRecord', () => {
        let registryId = null;

        beforeEach(async () => {
            const result = await generateFileTreeRecord(db, {
                fileSourcePath: filePath,
                spaceId: spaceId
            });

            registryId = result.registryId;
        });

        it('should retrieve the Merkle tree and pass validation and verification', async () => {
            const tree = await getFileTreeRecord(db, registryId);

            const validationResult = validateMerkleTree(tree);
            expect(validationResult.isValid).toBe(true);

            const verificationResult = verifyMerkleTree(tree);
            expect(verificationResult.isValid).toBe(true);
        });

        it('should return null if no records exist for the registryId', async () => {
            const nonExistentId = 999999;
            const tree = await getFileTreeRecord(db, nonExistentId);
            expect(tree).toBeNull();
        });

        it('should correctly handle an empty file (size 0)', async () => {
            const emptyFilePath = path.join(root, 'emptyfile');
            await generateRandomFile(emptyFilePath, 0);

            const result = await generateFileTreeRecord(db, {
                fileSourcePath: emptyFilePath,
                spaceId: spaceId,
            });

            const tree = await getFileTreeRecord(db, result.registryId);
            expect(tree).not.toBeNull();
            expect(tree.height).toBe(0);
            expect(tree.leafCount).toBe(1);
            expect(tree.levels.length).toBe(1);
            expect(tree.levels[0].length).toBe(1);

            const validationResult = validateMerkleTree(tree);
            expect(validationResult.isValid).toBe(true);

            const verificationResult = verifyMerkleTree(tree);
            expect(verificationResult.isValid).toBe(true);
        });
    });

    describe('Download Utils', () => {
        let tree = null;
        let tempFilePath = null;
        let destinationFilePath = null;
        let spaceDirectoryPath = '/space';
        let spaceFilename = 'foo.mp4';

        beforeEach(async () => {
            const stream = createFileStream(filePath);
            const size = await getFileSize(filePath);
            tree = await generateMerkleTree({
                stream: stream,
                size: size,
                chunkSize: DEFAULT_CHUNK_SIZE
            });

            tempFilePath = path.join(root, 'download.temp.file');
            destinationFilePath = path.join(root, 'final.file');
        });

        describe('createDownloadRecord', () => {
            it('should create file registry and downlaod record', async () => {
                const { registryId } = await createDownloadRecord(db, {
                    tempFilePath: tempFilePath,
                    finalDestination: destinationFilePath,
                    spaceId: spaceId,
                    spacePath: spaceDirectoryPath,
                    spaceFilename: spaceFilename,
                    rootHash: tree.rootHash,
                    leafCount: getLeafCount(fileSize, DEFAULT_CHUNK_SIZE),
                    height: tree.levels.length - 1
                });

                await expect(fileExists(tempFilePath)).resolves.toBe(true);
                await expect(getFileSize(tempFilePath)).resolves.toBe(0);

                const registry = await getFileRegistryRecord(db, registryId);
                expect(registry).toBeDefined();
                expect(registry.fileSourcePath).toBe(tempFilePath);
                expect(registry.rootHash).toBe(tree.rootHash);
                expect(registry.spaceId).toBe(spaceId);

                const download = await getDownloadRecord(db, registryId);
                expect(download).toBeDefined();
                expect(download.registryId).toBe(registryId);
                expect(download.lastPushedLeaf).toBe(-1);
                expect(download.finalDestination).toBe(destinationFilePath);
            });
        });

        describe('updateDownloadRecord', () => {
            it('should write leaf chunk at correct offset and update record', async () => {
                const { registryId } = await createDownloadRecord(db, {
                    tempFilePath: tempFilePath,
                    finalDestination: destinationFilePath,
                    spaceId: spaceId,
                    spacePath: spaceDirectoryPath,
                    spaceFilename: spaceFilename,
                    rootHash: tree.rootHash,
                    leafCount: getLeafCount(fileSize, DEFAULT_CHUNK_SIZE),
                    height: tree.levels.length - 1
                });

                const registry = await getFileRegistryRecord(db, registryId);
                const metaHash = registry.metaHash;

                const sourceHandler = await openFile(filePath);
                const size = await getFileSize(filePath);

                const leafIndex = 0;
                const writeHandler = await openFile(tempFilePath);
                const leafContent = await getFileChunk(sourceHandler, size, leafIndex, DEFAULT_CHUNK_SIZE);

                await updateDownloadRecord(db, {
                    registryId,
                    leafIndex,
                    leafContent,
                    fileHandler: writeHandler
                });

                const tempFileSize = await getFileSize(tempFilePath);
                const buffer = await getFileChunk(writeHandler, tempFileSize, 0, DEFAULT_CHUNK_SIZE);
                const bufferHash = hex(hash(buffer));

                // ensure locally written buffer has same hash as the tree's leaf
                expect(bufferHash).toEqual(tree.levels[tree.height][leafIndex].hash);

                // ensure download record has been updated
                const download = await getDownloadRecord(db, registryId);
                expect(download.lastPushedLeaf).toBe(leafIndex);

                // ensure file registy has been updated
                const updatedMetaHash = await getFileMetaHash(writeHandler);
                const updatedRegistry = await getFileRegistryRecord(db, registryId);
                expect(updatedRegistry.metaHash).toEqual(updatedMetaHash);

                // close file handlers
                await closeFile(writeHandler);
                await closeFile(sourceHandler);
            });
        });

        describe('setDownloadAsComplete', () => {
            it('should sucessfully move download record into final completion stage', async () => {
                const { registryId } = await createDownloadRecord(db, {
                    tempFilePath: tempFilePath,
                    finalDestination: destinationFilePath,
                    spaceId: spaceId,
                    spacePath: spaceDirectoryPath,
                    spaceFilename: spaceFilename,
                    rootHash: tree.rootHash,
                    leafCount: getLeafCount(fileSize, DEFAULT_CHUNK_SIZE),
                    height: tree.levels.length - 1
                });

                const registry = await getFileRegistryRecord(db, registryId);

                // read handler for the source file
                const sourceHandler = await openFile(filePath);
                const sourceFileSize = await getFileSize(filePath);

                // write handler for the download
                const writeHandler = await openFile(tempFilePath);

                const leafs = tree.levels[tree.height];

                // update the download record through all the leafs from the original file.
                for (const leafNode of leafs) {
                    const leafIndex = leafNode.leafIndex;
                    const leafContent = await getFileChunk(
                        sourceHandler,
                        sourceFileSize,
                        leafIndex,
                        DEFAULT_CHUNK_SIZE
                    );

                    await updateDownloadRecord(db, {
                        registryId,
                        leafIndex,
                        leafContent,
                        fileHandler: writeHandler
                    });
                }

                await setDownloadAsComplete(db, registryId);
                // ensure file sucessfully has moved to correct destination
                await expect(fileExists(tempFilePath)).resolves.toBe(false);

                await closeFile(writeHandler);
                await closeFile(sourceHandler);

                const destinationFileHandler = await openFile(destinationFilePath);
                const destinationfileSize = await getFileSize(destinationFilePath);

                const finalMetaHash = await getFileMetaHash(destinationFileHandler);
                const completedFileRegistry = await getFileRegistryRecord(db, registryId);

                // ensure metadata hash stays consistent witht the file registry
                expect(completedFileRegistry.metaHash).toEqual(finalMetaHash);
                expect(destinationfileSize).toEqual(sourceFileSize);

                const stream = await createReadStream(completedFileRegistry.fileSourcePath);
                const destinationTree = await generateMerkleTree({
                    stream: stream,
                    size: destinationfileSize,
                    chunkSize: DEFAULT_CHUNK_SIZE
                });

                // ensure the file root hash is consistent with the registry
                expect(destinationTree.rootHash).toEqual(completedFileRegistry.rootHash);

                await closeFile(destinationFileHandler);
            });
        });
    });
})