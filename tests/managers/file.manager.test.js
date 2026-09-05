import path from "path";
import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as EVENTS from '../../src/constants/events.constants.js';
import { getSpaceTopicHash } from "../../src/utils/space.utils.js";
import { CoreFactory } from "../factory.js";
import { cleanup, createP2PNetwork, generateRandomFile, makeTempDir } from "../general.utils.js";
import { FileEventBroadcaster, LocalFileRegistry, ProviderList, SpaceFileListManager, SpaceTreePuller } from "../../src/managers/file.manager.js";
import { now } from "../../src/utils/general.utils.js";
import { createSpaceFileRecordSignature } from "../../src/utils/protocol.utils.js";
import { generateFileTreeRecord, createWatcher, createfileRegistryRecord, queryFileRegistryRecords, createDownloadRecord, getTemporarySourcePathForSpaceFile, getFileRegistryRecord, getFileMetaHashFromSource } from "../../src/utils/files.utils.js";
import { createFileStream, deleteFile, fileExists, getFileSize } from "../../src/utils/system.utils.js";
import { generateMerkleTree } from "../../src/utils/merkletree.utils.js";
import { SessionManager } from "../../src/managers/session.manager.js";


const createSignedEvent = async event => {
    const signature = await createSpaceFileRecordSignature(event);
    const signedEvent = { ...event, signature };
    return signedEvent;
};

const waitForEvent = (core, eventName, timeout = 5000) => {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error(`Timeout waiting for ${eventName} on core ${core.publicKey}`));
        }, timeout);

        core.emitter.once(eventName, (data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
};

const exampleFileList = {
    '/doc1.txt': {
        'hashA1': {
            peers: {
                'peerA': { timestamp: 1000, signature: 'sigA1' },
                'peerB': { timestamp: 1001, signature: 'sigB1' }
            }
        },
        'hashA2': {
            peers: {
                'peerC': { timestamp: 1002, signature: 'sigC2' },
                'peerD': { timestamp: 1003, signature: 'sigD2' }
            }
        }
    },

    '/doc2.pdf': {
        'hashB1': {
            peers: {
                'peerE': { timestamp: 2000, signature: 'sigE1' },
                'peerF': { timestamp: 2001, signature: 'sigF1' }
            }
        },
        'hashB2': {
            peers: {
                'peerG': { timestamp: 2002, signature: 'sigG2' },
                'peerH': { timestamp: 2003, signature: 'sigH2' }
            }
        }
    },

    '/doc3.zip': {
        'hashC1': {
            peers: {
                'peerI': { timestamp: 3000, signature: 'sigI1' },
                'peerJ': { timestamp: 3001, signature: 'sigJ1' }
            }
        },
        'hashC2': {
            peers: {
                'peerK': { timestamp: 3002, signature: 'sigK2' },
                'peerL': { timestamp: 3003, signature: 'sigL2' }
            }
        }
    }
};

const exampleFileStack = [
    ['/doc1.txt', 'peerA', 1000, 'hashA1', 'sigA1'],
    ['/doc1.txt', 'peerB', 1001, 'hashA1', 'sigB1'],
    ['/doc1.txt', 'peerC', 1002, 'hashA2', 'sigC2'],
    ['/doc1.txt', 'peerD', 1003, 'hashA2', 'sigD2'],
    ['/doc2.pdf', 'peerE', 2000, 'hashB1', 'sigE1'],
    ['/doc2.pdf', 'peerF', 2001, 'hashB1', 'sigF1'],
    ['/doc2.pdf', 'peerG', 2002, 'hashB2', 'sigG2'],
    ['/doc2.pdf', 'peerH', 2003, 'hashB2', 'sigH2'],
    ['/doc3.zip', 'peerI', 3000, 'hashC1', 'sigI1'],
    ['/doc3.zip', 'peerJ', 3001, 'hashC1', 'sigJ1'],
    ['/doc3.zip', 'peerK', 3002, 'hashC2', 'sigK2'],
    ['/doc3.zip', 'peerL', 3003, 'hashC2', 'sigL2']
];

describe("SpaceFileListManager", () => {
    let factory = null;
    let core = null;
    let manager = null;

    beforeEach(async () => {
        factory = new CoreFactory();
        await factory.init();

        core = await factory.createCore();
        manager = core.managers.spaceFileList;
    });

    afterEach(async () => {
        await factory.cleanup();
    });

    describe('add', () => {
        it('should add new entry when nothing exists', () => {
            manager.add({
                topic: 'topic1',
                publicKey: 'peerA',
                path: '/file.txt',
                rootHash: 'abc123',
                timestamp: 1000,
                signature: 'abc'
            });

            const state = manager.get('topic1');
            expect(state).toEqual({
                "/file.txt": {
                    "abc123": {
                        peers: { "peerA": { timestamp: 1000, signature: 'abc' } }
                    }
                }
            })
        });

        it('should add new path to an existing topic', () => {
            manager.add({
                topic: "topic1",
                path: "/file1.txt",
                rootHash: "abc",
                publicKey: "peerA",
                timestamp: 1000
            });

            manager.add({
                topic: "topic1",
                path: "/file2.txt",
                rootHash: "def",
                publicKey: "peerB",
                timestamp: 2000
            });

            const state = manager.get("topic1");
            expect(state).toHaveProperty("/file1.txt");
            expect(state).toHaveProperty("/file2.txt");
            expect(Object.keys(state).length).toBe(2);
        });

        it('should add a new variant to an existing path', () => {
            manager.add({
                topic: "topic1",
                path: "/file.txt",
                rootHash: "abc",
                publicKey: "peerA",
                timestamp: 1000,
                signature: 'abc'
            });

            manager.add({
                topic: "topic1",
                path: "/file.txt",
                rootHash: "def",
                publicKey: "peerB",
                timestamp: 2000,
                signature: 'cba'
            });

            const variants = manager.get("topic1")["/file.txt"];
            expect(variants).toEqual({
                "abc": { peers: { "peerA": { timestamp: 1000, signature: 'abc' } } },
                "def": { peers: { "peerB": { timestamp: 2000, signature: 'cba' } } }
            });
        });

        it('should add a new peer to and existing variant', () => {
            manager.add({
                topic: "topic1",
                path: "/file.txt",
                rootHash: "abc",
                publicKey: "peerA",
                timestamp: 1000,
                signature: 'abc'
            });


            manager.add({
                topic: "topic1",
                path: "/file.txt",
                rootHash: "abc",
                publicKey: "peerB",
                timestamp: 2000,
                signature: 'cba'
            });

            const variant = manager.get("topic1")["/file.txt"]["abc"];
            expect(variant.peers).toEqual({
                "peerA": { timestamp: 1000, signature: 'abc' },
                "peerB": { timestamp: 2000, signature: 'cba' }
            });
        });

        it("should update timestamp when incoming is newer", () => {
            manager.add({
                topic: "t", path: "/f", rootHash: "rh", publicKey: "pk", timestamp: 1000, signature: 'abc'
            });
            manager.add({
                topic: "t", path: "/f", rootHash: "rh", publicKey: "pk", timestamp: 2000, signature: 'cba'
            });

            const variant = manager.get("t")["/f"]["rh"];
            expect(variant.peers).toEqual({ "pk": { timestamp: 2000, signature: 'cba' } });
        });

        it("should move peer to new variant when timestamp is newer", () => {
            manager.add({
                topic: "t", path: "/f", rootHash: "old", publicKey: "pk", timestamp: 1000, signature: 'abc'
            });
            manager.add({
                topic: "t", path: "/f", rootHash: "new", publicKey: "pk", timestamp: 2000, signature: 'cba'
            });

            const variants = manager.get("t")["/f"];
            expect(variants).toEqual({
                "new": { peers: { "pk": { timestamp: 2000, signature: 'cba' } } }
            });
            expect(variants["old"]).toBeUndefined();
        });

        it("should ignore move when timestamp is older than existing variant", () => {
            manager.add({
                topic: "t", path: "/f", rootHash: "new", publicKey: "pk", timestamp: 2000, signature: 'abc'
            });
            manager.add({
                topic: "t", path: "/f", rootHash: "old", publicKey: "pk", timestamp: 1000, signature: 'cba'
            });

            const variants = manager.get("t")["/f"];
            expect(variants).toEqual({
                "new": { peers: { "pk": { timestamp: 2000, signature: 'abc' } } }
            });
        });
    });

    describe('remove', () => {
        it('should remove peer from variation', () => {
            manager.add({
                topic: "t", path: "/f", rootHash: "old", publicKey: "pk", timestamp: 1000, signature: 'abc'
            });

            manager.remove({ topic: 't', path: '/f', publicKey: 'pk' });
            expect(manager.get('t')).toEqual({});
        });
    });

    describe('merge', () => {
        it('should merge foreign entries and ignore the local publickey', () => {
            manager.add({
                topic: 't',
                path: '/existing.txt',
                rootHash: 'rh1',
                publicKey: 'peerA',
                timestamp: 1000,
                signature: 'sigA'
            });

            const remoteFileList = {
                '/existing.txt': {
                    'rh1': {
                        peers: {
                            'peerB': { timestamp: 2000, signature: 'sigB' }   // new foreign peer
                        }
                    }
                },
                '/new.txt': {
                    'rh2': {
                        peers: {
                            'peerC': { timestamp: 4000, signature: 'sigC' }
                        }
                    }
                }
            };

            manager.merge({ topic: 't', fileList: remoteFileList });

            const state = manager.get('t');

            expect(state['/existing.txt']).toEqual({
                'rh1': {
                    peers: {
                        'peerA': { timestamp: 1000, signature: 'sigA' },
                        'peerB': { timestamp: 2000, signature: 'sigB' }
                    }
                }
            });

            expect(state['/new.txt']).toEqual({
                'rh2': {
                    peers: {
                        'peerC': { timestamp: 4000, signature: 'sigC' }
                    }
                }
            });

            // no local publickey registry should be there
            const allPeers = Object.values(state)
                .flatMap(variants => Object.values(variants))
                .flatMap(v => Object.keys(v.peers));
            expect(allPeers).not.toContain('local-pk');
        });
    });

    describe('diff', () => {
        it('should return an empty object when remote file list is empty', () => {
            const result = manager.diff({ topic: 't', fileList: {} });
            expect(result).toEqual({});
        });

        it('should return all remote entries when local state is empty (mode=add)', () => {
            const remoteFileList = {
                '/file1.txt': {
                    'hash1': { peers: { 'peerA': { timestamp: 100, signature: 'sigA' } } }
                },
                '/file2.txt': {
                    'hash2': { peers: { 'peerB': { timestamp: 200, signature: 'sigB' } } }
                }
            };

            const result = manager.diff({ topic: 't', fileList: remoteFileList, mode: 'add' });
            expect(result).toEqual(remoteFileList);
        });

        it('should return zero remote entries when local state is empty (mode=remove)', () => {
            const remoteFileList = {
                '/file1.txt': {
                    'hash1': { peers: { 'peerA': { timestamp: 100, signature: 'sigA' } } }
                },
                '/file2.txt': {
                    'hash2': { peers: { 'peerB': { timestamp: 200, signature: 'sigB' } } }
                }
            };

            const result = manager.diff({ topic: 't', fileList: remoteFileList, mode: 'remove' });
            expect(result).toEqual({});
        });

        it('should exclude entries that already exist locally (mode=add)', () => {
            manager.add({
                topic: 't',
                path: '/doc.txt',
                rootHash: 'abc',
                publicKey: 'peerA',
                timestamp: 1000,
                signature: 'sigA'
            });

            const remoteFileList = {
                '/doc.txt': {
                    'abc': {
                        peers: {
                            'peerA': { timestamp: 1000, signature: 'sigA' },  // exists
                            'peerB': { timestamp: 2000, signature: 'sigB' }   // new
                        }
                    }
                }
            };

            const result = manager.diff({ topic: 't', fileList: remoteFileList });

            expect(result).toEqual({
                '/doc.txt': {
                    'abc': {
                        peers: {
                            'peerB': { timestamp: 2000, signature: 'sigB' }
                        }
                    }
                }
            });
        });

        it('should exclude entries that does not exist locally (mode=remove)', () => {
            manager.add({
                topic: 't',
                path: '/doc.txt',
                rootHash: 'abc',
                publicKey: 'peerA',
                timestamp: 1000,
                signature: 'sigA'
            });

            const remoteFileList = {
                '/doc.txt': {
                    'abc': {
                        peers: {
                            'peerA': { timestamp: 1050, signature: 'sigA' },  // exists
                            'peerB': { timestamp: 2000, signature: 'sigB' }   // new
                        }
                    }
                }
            };

            const result = manager.diff({ topic: 't', fileList: remoteFileList, mode: 'remove' });

            expect(result).toEqual({
                '/doc.txt': {
                    'abc': {
                        peers: {
                            'peerA': { timestamp: 1050, signature: 'sigA' }
                        }
                    }
                }
            });
        });
    });

    describe('convertListToStack', () => {
        it('should convert file list into valid stack', () => {
            const stack = manager.convertListToStack(exampleFileList);
            expect(stack).toEqual(exampleFileStack);
        });
    });

    describe('convertStackToList', () => {
        it('should convert file stack into valid file list', () => {
            const fileList = manager.convertStackToList(exampleFileStack);
            expect(fileList).toEqual(exampleFileList);
        });
    });
});

describe("FileEventBroadcaster", () => {
    let factory = null;
    let cores = [];
    let primaryCore = null;
    let spaceId = null;
    let topic = null;
    let broadcaster = null;

    beforeEach(async () => {
        factory = new CoreFactory();
        await factory.init();

        cores = await factory.createMultipleCores(5);
        primaryCore = cores[0];

        broadcaster = new FileEventBroadcaster(primaryCore.emitter, {
            sessionManager: primaryCore.managers.session,
            socketManager: primaryCore.managers.sockets,
            messageManager: primaryCore.managers.message
        });

        const space = await primaryCore.space.create({ spaceName: 'test-space' });
        topic = space.topicHash;

        const status = await factory.condition(async (core, success) => {
            // resolve the condition after SpaceSync state
            core.emitter.once(EVENTS.SpaceHashList, (data) => {
                success(data);
            });

            await core.space.join(space.sharelink);
        }, { excludeIndices: [0], timeout: 1000 });

    });

    afterEach(async () => {
        await broadcaster.flush();
        await factory.cleanup();
    });

    it('should add an event to the stack and flush it', async () => {
        const signedEvent = await createSignedEvent({
            topic: topic,
            path: '/test.txt',
            publicKey: primaryCore.publicKey,
            secretKey: primaryCore.secretKey,
            timestamp: now(),
            rootHash: 'a'.repeat(64),
        });

        broadcaster.add(
            EVENTS.SpaceFileEventOptions.ADD,
            signedEvent
        );

        const eventPromise = waitForEvent(cores[1], EVENTS.SpaceFileEvent);
        await broadcaster.flush();

        const received = await eventPromise;

        expect(received.message.topic).toBe(topic);
        expect(received.message.payload).toHaveLength(1);
        expect(received.message.payload[0].action).toBe(EVENTS.SpaceFileEventOptions.ADD);
        expect(received.message.payload[0].files).toEqual([
            [signedEvent.path, signedEvent.publicKey, signedEvent.timestamp, signedEvent.rootHash, signedEvent.signature]
        ]);

        expect(broadcaster.stack.size).toBe(0);
    });

    it('should combine add/remove events into one broadcast message', async () => {
        const addEvent = await createSignedEvent({
            topic: topic,
            path: '/test.txt',
            publicKey: primaryCore.publicKey,
            secretKey: primaryCore.secretKey,
            timestamp: now(),
            rootHash: 'a'.repeat(64),
        });

        const removeEvent = await createSignedEvent({
            topic: topic,
            path: '/test2.txt',
            publicKey: primaryCore.publicKey,
            secretKey: primaryCore.secretKey,
            timestamp: now(),
            rootHash: 'a'.repeat(64),
        });

        broadcaster.add(EVENTS.SpaceFileEventOptions.ADD, addEvent);
        broadcaster.add(EVENTS.SpaceFileEventOptions.REMOVE, removeEvent);

        const eventPromise = waitForEvent(cores[1], EVENTS.SpaceFileEvent);

        await broadcaster.flush();

        const received = await eventPromise;
        expect(received.message.payload).toHaveLength(2);

        const actions = received.message.payload.map(e => e.action);
        expect(actions).toContain(EVENTS.SpaceFileEventOptions.ADD);
        expect(actions).toContain(EVENTS.SpaceFileEventOptions.REMOVE);
    });
});

describe('LocalFileRegistry', () => {
    let factory;
    let core = null;
    let broadcaster = null;
    let localFileRegistry = null;
    let temporaryDirectory = null;
    let filePath = null;
    let space = null;
    let db = null;

    beforeEach(async () => {
        factory = new CoreFactory();
        await factory.init();

        core = await factory.createCore();
        temporaryDirectory = await makeTempDir();

        filePath = path.join(temporaryDirectory, 'test.txt');
        await generateRandomFile(filePath, 1); // 1MB

        space = await core.space.create({ spaceName: 'testspace' });
        db = core.managers.session.getDatabase().db;

        broadcaster = new FileEventBroadcaster(core.emitter, {
            sessionManager: core.managers.session,
            socketManager: core.managers.sockets,
            messageManager: core.managers.message
        });

        localFileRegistry = new LocalFileRegistry(core.emitter, {
            sessionManager: core.managers.session,
            spaceFileListManager: core.managers.spaceFileList,
            fileEventBroadcaster: broadcaster
        });
    });

    afterEach(async () => {
        await localFileRegistry.stop();
        await broadcaster.flush();
        await cleanup(temporaryDirectory);
        await factory.cleanup();
    });

    describe('init', () => {

        it('should load existing registries and add them to SpaceFileList and broadcast to network', async () => {
            const { registryId } = await generateFileTreeRecord(db, {
                fileSourcePath: filePath,
                spacePath: '/',
                spaceFilename: 'file.txt',
                spaceId: 1
            });

            const addSpy = vi.spyOn(core.managers.spaceFileList, 'add');
            const broadcastSpy = vi.spyOn(localFileRegistry.fileEventBroadcaster, 'add');

            await localFileRegistry.init();

            expect(addSpy).toHaveBeenCalled(1);

            const addedRecord = addSpy.mock.calls[0][0];
            expect(addedRecord.path).toBe('/file.txt');
            expect(addedRecord.rootHash).toBeDefined();

            expect(broadcastSpy).toHaveBeenCalled(1);
            expect(broadcastSpy).toHaveBeenCalledWith(
                EVENTS.SpaceFileEventOptions.ADD,
                expect.objectContaining({ path: '/file.txt' })
            );
        });

        it('should delete registry if the source file does not exist', async () => {
            const { registryId } = await generateFileTreeRecord(db, {
                fileSourcePath: filePath,
                spacePath: '/',
                spaceFilename: 'file.txt',
                spaceId: 1
            });

            await deleteFile(filePath);
            await localFileRegistry.init();

            const list = await queryFileRegistryRecords(db, {});
            expect(list.length).toBe(0);
        });

        it('should skip registry if download record exists', async () => {
            const topic = 'a'.repeat(64);

            const { directory, username } = core.managers.session.getAccount();
            const temporaryPath = getTemporarySourcePathForSpaceFile({
                root: directory,
                username,
                topic: topic,
                spaceFilePath: '/file.txt',
                rootHash: 'b'.repeat(64)
            });

            const size = await getFileSize(filePath);
            const stream = createFileStream(filePath);
            const tree = await generateMerkleTree({ stream, size });

            const { registryId } = await createDownloadRecord(db, {
                tempFilePath: temporaryPath,
                finalDestination: path.join(temporaryDirectory, 'final.file.txt'),
                spaceId: 1,
                spacePath: '/',
                spaceFilename: 'file.txt',
                rootHash: tree.rootHash,
                leafCount: tree.levels[tree.height].length,
                height: tree.height
            });

            const addSpy = vi.spyOn(core.managers.spaceFileList, 'add');

            await localFileRegistry.init();

            expect(addSpy).not.toHaveBeenCalled();

            const fileList = localFileRegistry.spaceFileListManager.get(topic)
            expect(Object.keys(fileList).length).toBe(0);
        });
    });

    describe('onChangeEvent', () => {
        it('should update registry if the file content has been changed', async () => {
            const { registryId } = await generateFileTreeRecord(db, {
                fileSourcePath: filePath,
                spacePath: '/',
                spaceFilename: 'file.txt',
                spaceId: 1
            });

            // retrieve the original metaHash
            const originalRegistry = await getFileRegistryRecord(db, registryId);
            const addSpy = vi.spyOn(localFileRegistry.fileEventBroadcaster, 'add');

            // set short backoff for testing
            const session = core.managers.session;
            session.session.set('files.localChangeBackoff', {
                baseDelay: 10,
                maxDelay: 15,
                backoffIncrement: 1
            });

            // change the file content (from 1MB size to 2MB)
            await generateRandomFile(filePath, 2);

            await localFileRegistry.init();
            await localFileRegistry.onChangeEvent(filePath);

            // wait until the file-indexing settles
            await new Promise(resolve => setTimeout(resolve, 100));

            // check SpaceFileList to be updated with new registry record
            const updatedRegistry = await getFileRegistryRecord(db, registryId);
            const spaceFile = localFileRegistry.spaceFileListManager.get(space.topicHash)['/file.txt'];
            const finalRootHash = Object.keys(spaceFile)[0];
            expect(finalRootHash).toBe(updatedRegistry.rootHash);

            expect(addSpy).toHaveBeenCalled();
        });

        it('should increase delay on rapid changes and only run indexing once after last change', async () => {
            vi.useFakeTimers();

            const session = core.managers.session;
            session.session.set('files.localChangeBackoff', {
                baseDelay: 100,
                maxDelay: 500,
                backoffIncrement: 150
            });

            await generateFileTreeRecord(db, { fileSourcePath: filePath, spacePath: '/', spaceFilename: 'file.txt', spaceId: 1 });
            await localFileRegistry.init();

            const processSpy = vi.spyOn(localFileRegistry, 'processFileIndex');

            for (let i = 0; i < 3; i++) {
                await generateRandomFile(filePath, 2 + i);
                await localFileRegistry.onChangeEvent(filePath);
                vi.advanceTimersByTime(50); // less than baseDelay
            }

            expect(processSpy).not.toHaveBeenCalled();

            vi.advanceTimersByTime(400);
            expect(processSpy).toHaveBeenCalledTimes(1);

            vi.useRealTimers();
        });

        it('should set pending flag when changes occur during active indexing', async () => {
            vi.useFakeTimers();

            const session = core.managers.session;
            session.session.set('files.localChangeBackoff', {
                baseDelay: 100,
                maxDelay: 500,
                backoffIncrement: 150
            });

            await generateFileTreeRecord(db, { fileSourcePath: filePath, spacePath: '/', spaceFilename: 'file.txt', spaceId: 1 });
            await localFileRegistry.init();

            const originalProcess = localFileRegistry.processFileIndex;
            const processSpy = vi.spyOn(localFileRegistry, 'processFileIndex').mockImplementation(async function (...args) {
                await new Promise(resolve => setTimeout(resolve, 200));
                return originalProcess.apply(this, args);
            });

            await generateRandomFile(filePath, 2);
            await localFileRegistry.onChangeEvent(filePath);

            // this will trigger initial indexing
            vi.advanceTimersByTime(100);

            await generateRandomFile(filePath, 3);
            await localFileRegistry.onChangeEvent(filePath);

            // finish the indexing and allow a follow-up
            vi.advanceTimersByTime(300);
            expect(processSpy).toHaveBeenCalledTimes(2);
            expect(localFileRegistry.pendingAfterIndex.get(filePath)).toBeUndefined();

            vi.useRealTimers();
        });
    });

    describe('onDeleteEvent', () => {
        it('should remove registry if the file has been deleted', async () => {
            const { registryId } = await generateFileTreeRecord(db, {
                fileSourcePath: filePath,
                spacePath: '/',
                spaceFilename: 'file.txt',
                spaceId: 1
            });

            const addSpy = vi.spyOn(localFileRegistry.fileEventBroadcaster, 'add');
            const fileListRemoveSpy = vi.spyOn(localFileRegistry.spaceFileListManager, 'remove');

            await localFileRegistry.init();
            await deleteFile(filePath);
            await localFileRegistry.onDeleteEvent(filePath);

            const registryList = await queryFileRegistryRecords(db, {});
            expect(registryList.length).toBe(0);
            expect(addSpy).toHaveBeenCalled();
            expect(fileListRemoveSpy).toHaveBeenCalled();
        });
    });

    describe('add', () => {
        it('should create new registry and broadcast to the space', async () => {
            const addSpy = vi.spyOn(localFileRegistry.spaceFileListManager, 'add');
            const broadcastSpy = vi.spyOn(localFileRegistry.fileEventBroadcaster, 'add');

            await localFileRegistry.init();

            const registryId = await localFileRegistry.add({
                spaceId: 1,
                spacePath: '/docs',
                spaceFilename: 'file.txt',
                fileSourcePath: filePath
            });

            const registry = await getFileRegistryRecord(db, registryId);
            expect(registry).toBeDefined();
            expect(registry.fileSourcePath).toBe(filePath);
            expect(registry.spaceId).toBe(1);
            expect(registry.spacePath).toBe('/docs');
            expect(registry.spaceFilename).toBe('file.txt');

            expect(addSpy).toHaveBeenCalledTimes(1);
            const addedRecord = addSpy.mock.calls[0][0];
            expect(addedRecord.path).toBe('/docs/file.txt');
            expect(addedRecord.rootHash).toBe(registry.rootHash);

            expect(broadcastSpy).toHaveBeenCalledWith(
                EVENTS.SpaceFileEventOptions.ADD,
                expect.objectContaining({
                    path: '/docs/file.txt',
                    rootHash: registry.rootHash
                })
            );
        });
    });

    describe('remove', () => {
        it('should delete the registry and broadcast to the space', async () => {

            await localFileRegistry.init();

            const removeSpy = vi.spyOn(localFileRegistry.spaceFileListManager, 'remove');
            const broadcastSpy = vi.spyOn(localFileRegistry.fileEventBroadcaster, 'add');

            const registryId = await localFileRegistry.add({
                spaceId: 1,
                spacePath: '/docs/',
                spaceFilename: 'to-delete.txt',
                fileSourcePath: filePath
            });

            const { rootHash } = await getFileRegistryRecord(db, registryId);

            await localFileRegistry.delete({ registryId });

            const registry = await getFileRegistryRecord(db, registryId);
            expect(registry).toBeUndefined();

            expect(removeSpy).toHaveBeenCalledTimes(1);
            const removeRecord = removeSpy.mock.calls[0][0];
            expect(removeRecord.path).toBe('/docs/to-delete.txt');
            expect(removeRecord.rootHash).toBe(rootHash);

            expect(broadcastSpy).toHaveBeenCalledWith(
                EVENTS.SpaceFileEventOptions.REMOVE,
                expect.objectContaining({
                    path: '/docs/to-delete.txt',
                    rootHash: rootHash
                })
            );
        });
    });
});

describe("ProviderList", () => {
    const SPACE_FILE_PATH = "/doc.txt";
    const ROOT_HASH = 'hash01';
    const TOPIC = "topic1";

    const fileListWith = (peer) => ({
        [SPACE_FILE_PATH]: {
            [ROOT_HASH]: { peer }
        }
    });

    let publicKey;
    let spaceFileListManager;
    let onDrop;
    let providerList;

    beforeEach(async () => {
        const peers = await createP2PNetwork(1);
        const { manager, publicKey: current } = peers[0];

        onDrop = vi.fn();
        publicKey = current;
        spaceFileListManager = manager.spaceFileList;
        providerList = new ProviderList({
            spaceFileListManager: spaceFileListManager,
            topic: TOPIC,
            spaceFilePath: SPACE_FILE_PATH,
            rootHash: ROOT_HASH,
            onDrop: onDrop
        });
    });

    it('should add a new provider with an unkown lastRequestableLeaf', () => {
        spaceFileListManager.add({
            topic: TOPIC,
            path: SPACE_FILE_PATH,
            rootHash: ROOT_HASH,
            timestamp: now(),
            signature: 'abc',
            publicKey
        });

        providerList.refresh();
        expect(providerList.has(publicKey)).toBe(true);
        expect(providerList.get(publicKey)).toEqual({ lastRequestableLeaf: undefined });
    });

    it('should not add provider from another file or rootHash', () => {
        spaceFileListManager.add({
            topic: TOPIC,
            path: 'random1',
            rootHash: ROOT_HASH,
            timestamp: now(),
            signature: 'abc',
            publicKey
        });

        spaceFileListManager.add({
            topic: TOPIC,
            path: SPACE_FILE_PATH,
            rootHash: 'random2',
            timestamp: now(),
            signature: 'abc',
            publicKey
        });

        providerList.refresh();

        expect([...providerList.peers()].length).toBe(0);
    });

    it('should add every peer listed for the space file', () => {
        spaceFileListManager.add({
            topic: TOPIC,
            path: SPACE_FILE_PATH,
            rootHash: ROOT_HASH,
            timestamp: now(),
            signature: 'abc',
            publicKey: 'A1'
        });

        spaceFileListManager.add({
            topic: TOPIC,
            path: SPACE_FILE_PATH,
            rootHash: ROOT_HASH,
            timestamp: now(),
            signature: 'abc',
            publicKey: 'A2'
        });

        providerList.refresh();
        providerList.setAdvertisedLeaf('A1', 10);

        expect([...providerList.peers()]).toEqual(['A1', 'A2']);
        expect(providerList.get('A1').lastRequestableLeaf).toBe(10)
    });

    it('should drop a provider that is no longer listed and call onDrop', () => {
        spaceFileListManager.add({
            topic: TOPIC,
            path: SPACE_FILE_PATH,
            rootHash: ROOT_HASH,
            timestamp: now(),
            signature: 'abc',
            publicKey: 'A1'
        });

        providerList.refresh();

        spaceFileListManager.remove({
            topic: TOPIC,
            path: SPACE_FILE_PATH,
            rootHash: ROOT_HASH,
            publicKey: 'A1'
        });

        providerList.refresh();
        expect(providerList.has('A1')).toBe(false);
        expect(onDrop).toHaveBeenCalledOnce();
    });
});

describe('SpaceTreePuler', () => {
    const SPACE_FILE_PATH = '/shared.txt';

    let factory;
    let primaryCore;
    let secondaryCore;
    let space;

    // file related variables
    let temporaryDirectory;
    let filePath;
    let rootHash;
    let leafCount;

    let puller;

    beforeEach(async () => {
        factory = new CoreFactory();
        await factory.init();

        primaryCore = await factory.createCore();
        secondaryCore = await factory.createCore();

        space = await secondaryCore.space.create({ spaceName: 'tree-puller' });
        // wait for primaryCore to connect with secondary
        await factory.condition(async (core, success) => {
            core.emitter.once(EVENTS.SpaceSync, () => success());
            await core.space.join(space.sharelink);

        }, { excludeIndices: [1], timeout: 5000 });

        temporaryDirectory = await makeTempDir();
        filePath = path.join(temporaryDirectory, 'shared.txt');

        await generateRandomFile(filePath, 1); // 1MB

        const db = primaryCore.managers.session.getDatabase().db;
        const { registryId } = await generateFileTreeRecord(db, {
            fileSourcePath: filePath,
            spacePath: '/',
            spaceFilename: 'shared.txt',
            spaceId: space.id
        });

        const registry = await getFileRegistryRecord(db, registryId);
        rootHash = registry.rootHash;
        leafCount = registry.leafCount;

        puller = new SpaceTreePuller({
            sessionManager: secondaryCore.managers.session,
            socketManager: secondaryCore.managers.sockets,
            messageManager: secondaryCore.managers.message,
            connectionManager: secondaryCore.managers.connection,
            topic: space.topicHash,
            spaceFilePath: SPACE_FILE_PATH,
            rootHash
        });
    });

    afterEach(async () => {
        await factory.cleanup();
        await cleanup(temporaryDirectory);
    });

    it('should send SpaceFileTreeRequest and mark the peer as pending', async () => {
        await puller.request(primaryCore.publicKey);
        expect(puller.isPending(primaryCore.publicKey)).toBe(true);
    });

    it('should ask to connect and record nothing for a peer with no active connection', async () => {
        const isolatedCore = await factory.createCore('isolated');
        const connectSpy = vi.spyOn(puller.connectionManager, 'connectWith');

        await puller.request(isolatedCore.publicKey);

        expect(connectSpy).toHaveBeenCalledOnce();
        expect(puller.isPending(isolatedCore.publicKey)).toBe(false);
    });

    it('should verify a genuine tree response from the provider', async () => {
        const responsePromise = waitForEvent(secondaryCore, EVENTS.SpaceFileTreeResponse);

        await puller.request(primaryCore.publicKey);
        const { message } = await responsePromise;
        const result = puller.verify(message);

        expect(result.succeed).toBe(true);
        expect(result.publicKey).toBe(primaryCore.publicKey);
        expect(result.tree.rootHash).toBe(rootHash);
        expect(result.lastRequestableLeaf).toBe(leafCount);
        expect(puller.isPending(primaryCore.publicKey)).toBe(false);
    });

    describe('shouldRequest', () => {
        it('should return false while a request is already pending for that peer', async () => {
            await puller.request(primaryCore.publicKey);
            expect(puller.shouldRequest(primaryCore.publicKey, undefined, null)).toBe(false);
        });

        it('should return true when there is no info at all for the peer', () => {
            expect(puller.shouldRequest(primaryCore.publicKey, undefined, 10)).toBe(true);
        });

        it('should return true when the leaf count is not known yet', () => {
            expect(puller.shouldRequest(primaryCore.publicKey, { lastRequestableLeaf: 5 }, null)).toBe(true);
        });

        it('should return true for a partial provider (advertised leaf below leafCount - 1)', () => {
            expect(puller.shouldRequest(primaryCore.publicKey, { lastRequestableLeaf: 5 }, 10)).toBe(true);
        });
    });
});