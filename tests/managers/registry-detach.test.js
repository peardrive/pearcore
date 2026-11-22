// A registry names fixed bytes; its place on disk is where they were last seen.
// Several registries, in several spaces, can share one place. These tests cover what happens to
// each of them when the file at that place changes or goes away:
//   - by default all of them follow (unchanged behaviour),
//   - with `only`, the named ones follow and the others are detached with their root hash kept,
//   - a detached registry is neither announced, verified nor served,
//   - `reconnect` attaches a registry to any file that holds its bytes, and to no other.
import path from "path";
import { copyFile, mkdir } from "fs/promises";
import * as EVENTS from '../../src/constants/events.constants.js';
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { CoreFactory } from "../factory.js";
import { cleanup, generateRandomFile, makeTempDir } from "../general.utils.js";
import { generateFileTreeRecord, queryFileRegistryRecords, getFileRegistryRecord, getFileTreeRecord } from "../../src/utils/files.utils.js";
import { deleteFile } from "../../src/utils/system.utils.js";

import { FileEventBroadcaster } from '../../src/managers/files/components/events.js';
import { LocalFileRegistry } from "../../src/managers/files/components/registry.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 150));

describe('LocalFileRegistry: one place on disk, several registries', () => {
    let factory, core, broadcaster, registry, dir, filePath, keptCopy, spaceA, spaceB, db;
    let a, b; // registry ids: the same file in space A and in space B

    const listed = (space, spaceFilePath) => {
        const entry = registry.spaceFileListManager.get(space.topicHash)?.[spaceFilePath];
        return entry ? Object.keys(entry) : [];
    };
    const removals = (spy) => spy.mock.calls
        .filter(([type]) => type === EVENTS.SpaceFileEventOptions.REMOVE)
        .map(([, record]) => record.topic);

    beforeEach(async () => {
        factory = new CoreFactory();
        await factory.init();
        core = await factory.createCore();
        dir = await makeTempDir();

        filePath = path.join(dir, 'movie.bin');
        keptCopy = path.join(dir, 'elsewhere', 'movie-copy.bin');
        await generateRandomFile(filePath, 1);

        spaceA = await core.space.create({ spaceName: 'action' });
        spaceB = await core.space.create({ spaceName: 'family' });
        db = core.managers.session.getDatabase().db;

        core.managers.session.session.set('files.localChangeBackoff', { baseDelay: 10, maxDelay: 15, backoffIncrement: 1 });

        broadcaster = new FileEventBroadcaster(core.emitter, {
            sessionManager: core.managers.session,
            socketManager: core.managers.sockets,
            messageManager: core.managers.message
        });
        registry = new LocalFileRegistry(core.emitter, {
            sessionManager: core.managers.session,
            spaceFileListManager: core.managers.spaceFileList,
            fileEventBroadcaster: broadcaster
        });

        ({ registryId: a } = await generateFileTreeRecord(db, { fileSourcePath: filePath, spacePath: '/', spaceFilename: 'movie.bin', spaceId: spaceA.id }));
        ({ registryId: b } = await generateFileTreeRecord(db, { fileSourcePath: filePath, spacePath: '/films', spaceFilename: 'movie.bin', spaceId: spaceB.id }));

        // the original bytes, kept at another place before anything changes
        await mkdir(path.dirname(keptCopy), { recursive: true });
        await copyFile(filePath, keptCopy);

        await registry.init();
    });

    afterEach(async () => {
        await registry.stop();
        await broadcaster.flush();
        await cleanup(dir);
        await factory.cleanup();
    });

    it('by default every registry at the place follows the change', async () => {
        const before = await getFileRegistryRecord(db, a);

        await generateRandomFile(filePath, 2);
        await registry.onChangeEvent(filePath);
        await settle();

        const afterA = await getFileRegistryRecord(db, a);
        const afterB = await getFileRegistryRecord(db, b);
        expect(afterA.rootHash).not.toBe(before.rootHash);
        expect(afterB.rootHash).toBe(afterA.rootHash);
        expect(afterA.detachedAt).toBeNull();
        expect(afterB.detachedAt).toBeNull();
        expect(listed(spaceA, '/movie.bin')).toEqual([afterA.rootHash]);
        expect(listed(spaceB, '/films/movie.bin')).toEqual([afterA.rootHash]);
    });

    it('with `only`, the named registry follows and the other keeps its bytes, detached', async () => {
        const before = await getFileRegistryRecord(db, b);
        const treeBefore = await getFileTreeRecord(db, b);
        const broadcastSpy = vi.spyOn(registry.fileEventBroadcaster, 'add');

        await generateRandomFile(filePath, 2);
        await registry.onChangeEvent(filePath, { only: [a] });
        await settle();

        const afterA = await getFileRegistryRecord(db, a);
        const afterB = await getFileRegistryRecord(db, b);

        // A follows: new root hash, announced in space A
        expect(afterA.rootHash).not.toBe(before.rootHash);
        expect(afterA.detachedAt).toBeNull();
        expect(listed(spaceA, '/movie.bin')).toEqual([afterA.rootHash]);

        // B names the bytes it always named, and no longer claims they are at this place
        expect(afterB.rootHash).toBe(before.rootHash);
        expect(afterB.metaHash).toBe(before.metaHash);
        expect(afterB.detachedAt).toBeTypeOf('number');
        expect(await getFileTreeRecord(db, b)).toEqual(treeBefore);
        expect(listed(spaceB, '/films/movie.bin')).toEqual([]);

        // the new root hash is announced in space A only; space B hears a removal and nothing else
        const adds = broadcastSpy.mock.calls.filter(([type]) => type === EVENTS.SpaceFileEventOptions.ADD).map(([, r]) => r.topic);
        expect(adds).toEqual([spaceA.topicHash]);
        expect(removals(broadcastSpy)).toContain(spaceB.topicHash);
        expect(broadcastSpy.mock.calls.some(([, r]) => r.topic === spaceB.topicHash && r.rootHash === afterA.rootHash)).toBe(false);
    });

    it('an empty `only` detaches every registry at the place and indexes nothing', async () => {
        const before = await getFileRegistryRecord(db, a);
        const indexSpy = vi.spyOn(registry, 'processFileIndex');

        await generateRandomFile(filePath, 2);
        await registry.onChangeEvent(filePath, { only: [] });
        await settle();

        for (const id of [a, b]) {
            const row = await getFileRegistryRecord(db, id);
            expect(row.rootHash).toBe(before.rootHash);
            expect(row.detachedAt).toBeTypeOf('number');
        }
        expect(indexSpy).not.toHaveBeenCalled();
    });

    it('a later change does not touch a detached registry, and neither does the next init', async () => {
        const before = await getFileRegistryRecord(db, b);

        await generateRandomFile(filePath, 2);
        await registry.onChangeEvent(filePath, { only: [a] });
        await settle();

        await generateRandomFile(filePath, 3);
        await registry.onChangeEvent(filePath); // no option: every ATTACHED registry follows
        await settle();
        expect((await getFileRegistryRecord(db, b)).rootHash).toBe(before.rootHash);

        // a fresh start (the verify path re-hashes what changed while it was not running)
        await registry.stop();
        await generateRandomFile(filePath, 2);
        const addSpy = vi.spyOn(core.managers.spaceFileList, 'add');
        await registry.init();

        expect((await getFileRegistryRecord(db, b)).rootHash).toBe(before.rootHash);
        expect(addSpy.mock.calls.every(([record]) => record.topic !== spaceB.topicHash)).toBe(true);
    });

    it('a detached registry is not among the attached ones a serve looks up', async () => {
        await generateRandomFile(filePath, 2);
        await registry.onChangeEvent(filePath, { only: [a] });
        await settle();

        const lookup = { spaceId: spaceB.id, spacePath: '/films', spaceFilename: 'movie.bin' };
        expect((await queryFileRegistryRecords(db, { ...lookup, detached: false })).length).toBe(0);
        expect((await queryFileRegistryRecords(db, { ...lookup, detached: true })).map(r => r.id)).toEqual([b]);
        expect((await queryFileRegistryRecords(db, lookup)).map(r => r.id)).toEqual([b]);
    });

    it('a missing file deletes its registries by default, and keeps them detached with `detach`', async () => {
        await deleteFile(filePath);
        const broadcastSpy = vi.spyOn(registry.fileEventBroadcaster, 'add');
        await registry.onDeleteEvent(filePath, { detach: true });

        const rows = await queryFileRegistryRecords(db, {});
        expect(rows.map(r => r.id).sort()).toEqual([a, b].sort());
        expect(rows.every(r => typeof r.detachedAt === 'number')).toBe(true);
        expect(removals(broadcastSpy).sort()).toEqual([spaceA.topicHash, spaceB.topicHash].sort());
        expect(listed(spaceA, '/movie.bin')).toEqual([]);

        // the default is what it always was
        await copyFile(keptCopy, filePath);
        expect(await registry.reconnect({ registryId: a })).toBe(true);
        await deleteFile(filePath);
        await registry.onDeleteEvent(filePath);
        expect((await queryFileRegistryRecords(db, {})).map(r => r.id)).toEqual([b]); // b was detached, not at this place
    });

    it('reconnect attaches a registry to a file holding its bytes, at a new place', async () => {
        const before = await getFileRegistryRecord(db, b);

        await generateRandomFile(filePath, 2);
        await registry.onChangeEvent(filePath, { only: [a] });
        await settle();

        const broadcastSpy = vi.spyOn(registry.fileEventBroadcaster, 'add');
        expect(await registry.reconnect({ registryId: b, fileSourcePath: keptCopy })).toBe(true);

        const afterB = await getFileRegistryRecord(db, b);
        expect(afterB.fileSourcePath).toBe(keptCopy);
        expect(afterB.rootHash).toBe(before.rootHash);
        expect(afterB.detachedAt).toBeNull();
        expect(listed(spaceB, '/films/movie.bin')).toEqual([before.rootHash]);
        expect(broadcastSpy.mock.calls.map(([type, r]) => [type, r.topic, r.rootHash]))
            .toEqual([[EVENTS.SpaceFileEventOptions.ADD, spaceB.topicHash, before.rootHash]]);

        // and A, at the old place, is untouched by it
        expect((await getFileRegistryRecord(db, a)).fileSourcePath).toBe(filePath);
    });

    it('reconnect refuses a file with other bytes, and a place with no file', async () => {
        await generateRandomFile(filePath, 2);
        await registry.onChangeEvent(filePath, { only: [a] });
        await settle();
        const detached = await getFileRegistryRecord(db, b);

        // the recorded place now holds A's new bytes
        expect(await registry.reconnect({ registryId: b })).toBe(false);
        expect(await registry.reconnect({ registryId: b, fileSourcePath: path.join(dir, 'nothing-here.bin') })).toBe(false);
        expect(await getFileRegistryRecord(db, b)).toEqual(detached);
        expect(listed(spaceB, '/films/movie.bin')).toEqual([]);

        await expect(registry.reconnect({ registryId: 9999 })).rejects.toThrow();
    });

    it('deleting a detached registry announces nothing a second time', async () => {
        await generateRandomFile(filePath, 2);
        await registry.onChangeEvent(filePath, { only: [a] });
        await settle();

        const broadcastSpy = vi.spyOn(registry.fileEventBroadcaster, 'add');
        await registry.delete({ registryId: b });

        expect(await getFileRegistryRecord(db, b)).toBeFalsy();
        expect(broadcastSpy).not.toHaveBeenCalled();
    });
});
