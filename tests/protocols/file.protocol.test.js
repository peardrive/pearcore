import * as EVENTS from '../../src/constants/events.constants.js';
import * as MESSAGES from '../../src/constants/messages.constants.js';
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { getSpaceTopicHash } from '../../src/utils/space.utils.js';
import { createSpaceFileContentRequestMessage, createSpaceFileEventMessage, createSpaceFileRecordSignature, createSpaceFileTreeRequestMessage, validateSpaceFileTreeResponsePayload } from "../../src/utils/protocol.utils.js";
import { createP2PNetwork, createConnections, buildTestSpacePayload, unframeJson, makeTempDir, cleanup, generateRandomFile } from '../general.utils.js';
import path from 'path';
import { createDownloadRecord, createFileIndexRecord, deleteFileRecord, generateFileTreeRecord, getFileChunk, getFileTreeRecord, queryFileRegistryRecords, updateDownloadRecord } from '../../src/utils/files.utils.js';
import { generateMerkleTree } from '../../src/utils/merkletree.utils.js';
import { closeFile, createFileStream, fileExists, getFileSize, openFile, pathJoin } from '../../src/utils/system.utils.js';
import { DEFAULT_CHUNK_SIZE } from '../../src/constants/global.constants.js';
import { FrameTypes } from '../../src/managers/multiplexer.manager.js';

describe('Space File Protocols', () => {
    let primary = null;
    let secondary = null;
    let standby = null;
    let spaceParams = null;
    let spaceTopicHash = null;

    beforeEach(async () => {
        [primary, secondary, standby] = await createP2PNetwork(3);

        spaceParams = await buildTestSpacePayload({
            spaceName: 'TestSpace',
            publicKey: primary.publicKey,
            permissionRead: 0,
            permissionBroadcast: 0,
            readWhitelist: [primary.publicKey, secondary.publicKey, standby.publicKey],
            broadcastWhitelist: [secondary.publicKey],
        });

        const space = await primary.manager.storage.createSpace(spaceParams, primary.secretKey);
        await secondary.manager.storage.upsertSpace(space);
        await standby.manager.storage.upsertSpace(space);

        spaceTopicHash = getSpaceTopicHash(spaceParams);

        createConnections(spaceTopicHash, [primary, secondary, standby]);
    })

    describe('SpaceFileEventHandler', () => {

        const createRecord = async params => {
            const records = {
                path: '/file1.txt',
                timestamp: 1000,
                rootHash: 'rootHash1',
                ...params
            };

            const signature = await createSpaceFileRecordSignature(records);
            return { ...params, signature };
        };

        const toEvent = record => {
            return [
                record.path,
                record.publicKey,
                record.timestamp,
                record.rootHash,
                record.signature
            ];
        }

        it('should reject message from unknown space', async () => {
            const unkownTopic = "0x012345";
            const message = await createSpaceFileEventMessage({
                topic: unkownTopic,
                events: [],
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            await secondary.manager.message.handleIncomingMessage(
                primary.socket,
                JSON.stringify(message),
                primary.info
            );

            const primaryCalls = primary.socket.write.mock.calls;
            expect(primaryCalls.length).toBe(1);

            const secondaryResponse = JSON.parse(unframeJson(primary.socket.write.mock.calls[0][0]));
            expect(secondaryResponse.payload.reason).toBe(MESSAGES.SPACE_NOT_FOUND_MESSAGE);
        });

        it('should reject when node is not allowed to broadcast', async () => {
            const message = await createSpaceFileEventMessage({
                topic: spaceTopicHash,
                events: [],
                publicKey: standby.publicKey,
                secretKey: standby.secretKey
            });

            await secondary.manager.message.handleIncomingMessage(
                primary.socket,
                JSON.stringify(message),
                primary.info
            );

            const primaryCalls = primary.socket.write.mock.calls;
            expect(primaryCalls.length).toBe(1);

            const rejection = JSON.parse(unframeJson(primaryCalls[0][0]));
            expect(rejection.payload.reason).toBe(MESSAGES.BROADCAST_PERMISSION_NOT_ALLOWED_MESSAGE);
        });

        it('should broadcast the event stack while duplicates are removed and locally stored events are dropped', async () => {
            const fileOneRecord = await createRecord({
                topic: spaceTopicHash,
                path: '/file1.txt',
                rootHash: 'hash1',
                timestamp: 1000,
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            const fileOneRenewalRecord = await createRecord({
                ...fileOneRecord,
                timestamp: 2000,
            });

            const fileTwoRecord = await createRecord({
                ...fileOneRecord,
                path: '/file2.txt',
                rootHash: 'hash2',
            });

            primary.manager.spaceFileList.add(fileOneRecord);

            const eventStack = [
                {
                    action: EVENTS.SpaceFileEventOptions.ADD,
                    files: [
                        toEvent(fileOneRecord), // duplicate => drop
                        toEvent(fileOneRenewalRecord), // new timestamp => include
                        toEvent(fileTwoRecord) // new record => include
                    ]
                }
            ];

            const message = await createSpaceFileEventMessage({
                topic: spaceTopicHash,
                events: eventStack,
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            await primary.manager.message.handleIncomingMessage(
                secondary.socket,
                JSON.stringify(message),
                secondary.info
            );

            const primaryFiles = primary.manager.spaceFileList.get(spaceTopicHash);
            expect(primaryFiles['/file1.txt']).toBeDefined();

            const file1Peers = primaryFiles['/file1.txt']['hash1'].peers;
            expect(file1Peers[secondary.publicKey].timestamp).toBe(2000);

            const standbyCalls = standby.socket.write.mock.calls;
            expect(standbyCalls.length).toBe(1);

            const primaryBroadcastMessage = JSON.parse(unframeJson(standby.socket.write.mock.calls[0][0]));
            const broadcastEvents = primaryBroadcastMessage.payload[0].files;

            expect(broadcastEvents).toEqual([
                toEvent(fileOneRenewalRecord),
                toEvent(fileTwoRecord)
            ]);
        });
    });

    describe('SpaceFileTreeRequestHandler', () => {
        let root = null;
        let spacePath = '/root';
        let spaceFilename = 'tempfile';
        let rootHash = null;
        let tree = null;
        let filePath = null;
        let fileSize = null;

        beforeEach(async () => {
            root = await makeTempDir();
            filePath = path.join(root, 'tempfile');
            await generateRandomFile(filePath, 1); // 1 MB

            fileSize = await getFileSize(filePath);

            const { db } = primary.manager.session.getDatabase();
            const result = await generateFileTreeRecord(db, {
                fileSourcePath: filePath,
                spacePath: spacePath,
                spaceFilename: spaceFilename,
                spaceId: 1
            });

            rootHash = result.rootHash;
            tree = result.tree;
        });

        afterEach(async () => {
            await cleanup(root);
        });

        it('should response with the correct file tree for valid request', async () => {
            const { db } = primary.manager.session.getDatabase();
            const message = await createSpaceFileTreeRequestMessage({
                topic: spaceTopicHash,
                rootHash: rootHash,
                spaceFilePath: pathJoin(spacePath, spaceFilename),
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            await primary.manager.message.handleIncomingMessage(
                secondary.socket,
                JSON.stringify(message),
                secondary.info
            );

            const secondaryCalls = secondary.socket.write.mock.calls;
            expect(secondaryCalls.length).toBe(1);

            const primaryResponse = JSON.parse(unframeJson(secondary.socket.write.mock.calls[0][0]));
            const responseStatus = validateSpaceFileTreeResponsePayload(primaryResponse);

            expect(responseStatus.isValid).toBe(true);
            expect(primaryResponse.payload.tree.rootHash).toEqual(rootHash);
        });

        it('should response with the last downloaded leaf for partially download file', async () => {
            const { db } = primary.manager.session.getDatabase();

            await deleteFileRecord(db, 1); // remove preloaded file registry

            // suppose we have partial download record for certain file
            // here we first should insert the tree into the database
            const tree = await generateMerkleTree({
                stream: createFileStream(filePath),
                size: fileSize,
                chunkSize: DEFAULT_CHUNK_SIZE
            });

            // now we need to create a download record the that file
            const { registryId } = await createDownloadRecord(db, {
                tempFilePath: path.join(root, 'temp.download'),
                finalDestination: path.join(root, 'final.download'),
                spaceId: 1,
                spaceFilename: spaceFilename,
                spacePath: spacePath,
                rootHash: tree.rootHash,
                leafCount: tree.levels[tree.height].length,
                height: tree.height
            });

            await createFileIndexRecord(db, registryId, tree);

            // we download the first two chunks as our partial download
            const localFileHandler = await openFile(filePath);
            const firstChunk = await getFileChunk(localFileHandler, fileSize, 0, DEFAULT_CHUNK_SIZE);

            const writeHandler = await openFile(path.join(root, 'temp.download'));

            await updateDownloadRecord(db, {
                registryId: registryId,
                leafIndex: 0,
                leafContent: firstChunk,
                fileHandler: writeHandler
            });

            const message = await createSpaceFileTreeRequestMessage({
                topic: spaceTopicHash,
                rootHash: rootHash,
                spaceFilePath: pathJoin(spacePath, spaceFilename),
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            await primary.manager.message.handleIncomingMessage(
                secondary.socket,
                JSON.stringify(message),
                secondary.info
            );

            const secondaryCalls = secondary.socket.write.mock.calls;
            expect(secondaryCalls.length).toBe(1);

            const primaryResponse = JSON.parse(unframeJson(secondary.socket.write.mock.calls[0][0]));
            const responseStatus = validateSpaceFileTreeResponsePayload(primaryResponse);

            expect(responseStatus.isValid).toBe(true);
            expect(primaryResponse.payload.tree.rootHash).toEqual(rootHash);
            expect(primaryResponse.payload.lastRequestableLeaf).toBe(1);

            await closeFile(localFileHandler);
            await closeFile(writeHandler);
        });

    });

    describe('SpaceFileContentRequestHandler', () => {
        let root = null;
        let filePath = null;
        let spacePath = '/root';
        let spaceFilename = 'tempfile';
        let rootHash = null;
        let leafCount = null;
        let registryId = null;
        let fileSize = null;
        let testKey = null;

        beforeEach(async () => {
            root = await makeTempDir();
            filePath = path.join(root, 'tempfile');
            await generateRandomFile(filePath, 1); // 1 MB

            fileSize = await getFileSize(filePath);

            const { db } = primary.manager.session.getDatabase();
            const result = await generateFileTreeRecord(db, {
                fileSourcePath: filePath,
                spacePath,
                spaceFilename,
                spaceId: 1 // space ID from the created space
            });

            registryId = result.registryId;
            rootHash = result.rootHash;
            leafCount = result.leafCount;

            // Generate a random key for content requests
            testKey = 'a'.repeat(24); // 24 character hex string
        });

        afterEach(async () => {
            await cleanup(root);
        });

        it('should reject when message is a relay', async () => {
            const message = await createSpaceFileContentRequestMessage({
                topic: spaceTopicHash,
                spaceFilePath: pathJoin(spacePath, spaceFilename),
                leafStart: 0,
                leafStop: 0,
                downloadKey: testKey,
                publicKey: standby.publicKey,
                secretKey: standby.secretKey
            });

            await primary.manager.message.handleIncomingMessage(
                secondary.socket, // socket from secondary, info.publicKey = secondary
                JSON.stringify(message),
                secondary.info
            );

            const primaryCalls = secondary.socket.write.mock.calls;
            const rejection = JSON.parse(unframeJson(primaryCalls[0][0]));
            expect(rejection.payload.reason).toBe(MESSAGES.NO_RELAY_MESSAGE);
        });

        it('should reject when space not found', async () => {
            const message = await createSpaceFileContentRequestMessage({
                topic: '0x999999999',
                spaceFilePath: pathJoin(spacePath, spaceFilename),
                leafStart: 0,
                leafStop: 0,
                downloadKey: testKey,
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            await primary.manager.message.handleIncomingMessage(
                secondary.socket,
                JSON.stringify(message),
                secondary.info
            );

            const primaryCalls = secondary.socket.write.mock.calls;
            expect(primaryCalls.length).toBe(1);
            const rejection = JSON.parse(unframeJson(primaryCalls[0][0]));
            expect(rejection.payload.reason).toBe(MESSAGES.SPACE_NOT_FOUND_MESSAGE);
        });

        it('should reject when the sender is not allowed to read', async () => {
            // create a node not in readWhitelist
            const [unauthorized] = await createP2PNetwork(1);
            // connect unauthorized to primary
            createConnections(spaceTopicHash, [primary, unauthorized]);

            const message = await createSpaceFileContentRequestMessage({
                topic: spaceTopicHash,
                spaceFilePath: pathJoin(spacePath, spaceFilename),
                leafStart: 0,
                leafStop: 0,
                downloadKey: testKey,
                publicKey: unauthorized.publicKey,
                secretKey: unauthorized.secretKey
            });


            await primary.manager.message.handleIncomingMessage(
                unauthorized.socket,
                JSON.stringify(message),
                unauthorized.info
            );

            const primaryCalls = unauthorized.socket.write.mock.calls;
            expect(primaryCalls.length).toBe(1);

            const rejection = JSON.parse(unframeJson(primaryCalls[0][0]));
            expect(rejection.payload.reason).toBe(MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE);
        });

        it('should reject when space file path is not found', async () => {
            const nonExistentPath = '/nonexistent/file.txt';
            const message = await createSpaceFileContentRequestMessage({
                topic: spaceTopicHash,
                spaceFilePath: nonExistentPath,
                leafStart: 0,
                leafStop: 0,
                downloadKey: testKey,
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            await primary.manager.message.handleIncomingMessage(
                secondary.socket,
                JSON.stringify(message),
                secondary.info
            );

            const primaryCalls = secondary.socket.write.mock.calls;
            expect(primaryCalls.length).toBe(1);
            const rejection = JSON.parse(unframeJson(primaryCalls[0][0]));
            expect(rejection.payload.reason).toBe(MESSAGES.SPACE_FILE_NOT_FOUND);
        });

        it('should reject when slice is not available (beyond leaf count)', async () => {
            const message = await createSpaceFileContentRequestMessage({
                topic: spaceTopicHash,
                spaceFilePath: pathJoin(spacePath, spaceFilename),
                leafStart: leafCount,
                leafStop: leafCount + 1, // out of leaf index
                downloadKey: testKey,
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            await primary.manager.message.handleIncomingMessage(
                secondary.socket,
                JSON.stringify(message),
                secondary.info
            );

            const primaryCalls = secondary.socket.write.mock.calls;
            expect(primaryCalls.length).toBe(1);
            const rejection = JSON.parse(unframeJson(primaryCalls[0][0]));
            expect(rejection.payload.reason).toBe(MESSAGES.SLICE_NOT_AVAILABLE_MESSAGE);
        });

        it('should send correct frames for a valid request', async () => {
            const startLeaf = 0;
            const endLeaf = 2;

            const message = await createSpaceFileContentRequestMessage({
                topic: spaceTopicHash,
                spaceFilePath: pathJoin(spacePath, spaceFilename),
                leafStart: startLeaf,
                leafStop: endLeaf,
                downloadKey: testKey,
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            await primary.manager.message.handleIncomingMessage(
                secondary.socket,
                JSON.stringify(message),
                secondary.info
            );

            // wait for task to be assigned internally and then wait for completion of the task
            await new Promise(resolve => setImmediate(resolve));
            await primary.manager.delivery.waitForTask(testKey);

            const calls = secondary.socket.write.mock.calls;
            
            const expectedChunks = endLeaf - startLeaf + 1;
            expect(calls.length).toBe(expectedChunks);

            const keyBuffer = Buffer.from(testKey, 'hex');
            const fileHandler = await openFile(filePath);
            const stats = await fileHandler.stat();
            const size = stats.size;

            for (let index=0; index < expectedChunks; index++) {
                const frame = calls[index][0];

                const type = frame[0];
                expect(type).toBe(FrameTypes.STREAM);

                const length = frame.readUInt32BE(1);
                const payload = frame.subarray(5, 5 + length);
                const receivedKey = payload.subarray(0, keyBuffer.length);
                const leafIndex = payload.readUInt32BE(keyBuffer.length);
                
                expect(receivedKey).toEqual(keyBuffer);
                expect(leafIndex).toBe(startLeaf + index);
                
                const chunk = payload.subarray(keyBuffer.length + 4);
                const expectedChunk = await getFileChunk(fileHandler, size, startLeaf + index, DEFAULT_CHUNK_SIZE);
                
                expect(chunk).toEqual(expectedChunk);
            }

            await closeFile(fileHandler);
        });
    });

    describe('SpaceFileContentCancel');
})