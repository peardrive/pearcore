import path from "path";
import { EventEmitter } from "node:events";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as EVENTS from '../../src/constants/events.constants.js';
import { getSpaceTopicHash } from "../../src/utils/space.utils.js";
import { CoreFactory } from "../factory.js";
import { cleanup, generateRandomFile, makeTempDir } from "../general.utils.js";
import { FileEventBroadcaster, LocalFileRegistry } from "../../src/managers/file.manager.js";
import { now } from "../../src/utils/general.utils.js";
import { createSpaceFileRecordSignature } from "../../src/utils/protocol.utils.js";
import { generateFileTreeRecord, createWatcher, createfileRegistryRecord, queryFileRegistryRecords, createDownloadRecord, getTemporarySourcePathForSpaceFile, getFileRegistryRecord, getFileMetaHashFromSource } from "../../src/utils/files.utils.js";
import { createFileStream, deleteFile, fileExists, getFileSize } from "../../src/utils/system.utils.js";
import { generateMerkleTree } from "../../src/utils/merkletree.utils.js";


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
}

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
]

describe("File Management", () => {
    let factory = null;

    beforeEach(async () => {
        factory = new CoreFactory();
        await factory.init();
    });

    afterEach(async () => {
        await factory.cleanup();
    });

    describe('SpaceFileListManager', () => {
        let core = null;
        let manager = null;

        beforeEach(async () => {
            core = await factory.createCore();
            manager = core.managers.spaceFileList;
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

    describe('FileEventBroadcaster', () => {
        let cores = [];
        let primaryCore = null;
        let spaceId = null;
        let topic = null;
        let broadcaster = null;

        beforeEach(async () => {
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
        let core = null;
        let broadcaster = null;
        let localFileRegistry = null;
        let temporaryDirectory = null;
        let filePath = null;
        let space = null;
        let db = null;

        beforeEach(async () => {
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

                await localFileRegistry.init();
                // change the file content (from 1MB size to 2MB)
                await generateRandomFile(filePath, 2);

                await localFileRegistry.onChangeEvent(filePath);
                const updatedRegistry = await getFileRegistryRecord(db, registryId);

                // check registry to be updated with new metaHash
                expect(updatedRegistry.metaHash).not.toBe(originalRegistry.metaHash);
                // check FileEventBroadcaster to be called after registry update
                expect(addSpy).toHaveBeenCalled();

                // check SpaceFileList to be updated with new registry record
                const spaceFile = localFileRegistry.spaceFileListManager.get(space.topicHash)['/file.txt'];
                const finalRootHash = Object.keys(spaceFile)[0];
                expect(finalRootHash).toBe(updatedRegistry.rootHash);
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

    
});