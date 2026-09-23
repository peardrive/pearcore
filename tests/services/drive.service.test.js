import { describe, it, beforeEach, beforeAll, afterAll, expect } from "vitest";
import { CoreFactory } from "../factory.js";
import { exampleFileHierarchy } from '../samples.js';

describe('SpaceDriveService', () => {
    let factory;
    let core;
    let space;
    let drive;

    beforeAll(async () => {
        factory = new CoreFactory();
        await factory.init();

        core = await factory.createCore();
        space = await core.space.create({ spaceName: 'hello' });

        core.managers.spaceFileList.spaceFileMap[space.topicHash] = exampleFileHierarchy;

        drive = core.drives.get(space);
    });

    afterAll(async () => {
        await factory.cleanup();
    });

    describe('root', () => {
        it('should expose "/" as root path', () => {
            expect(drive.path).toBe('/');
        });

        it('should list only first-child files at root, non-recursive', () => {
            expect(drive.folders()).toEqual([
                '.hidden', 'UPPERCASE',
                'a', 'docs',
                'docs-backup', 'media',
                'projects', 'shared docs',
                '日本語'
            ]);
        });

        it('should list every folder at every depth when recursive', () => {
            const all = drive.folders({ recursive: true });
            expect(all).toEqual([
                '.hidden', 'UPPERCASE', 'a', 'a/a',
                'a/a/a', 'docs', 'docs-backup', 'docs-backup/archive',
                'docs/guide', 'docs/guide/advanced', 'docs/guide/advanced/appendix', 'media',
                'media/photos', 'media/photos/vacation', 'media/photos/vacation/2023', 'media/videos',
                'projects', 'projects/another-project', 'projects/pearcore', 'projects/pearcore/src',
                'projects/pearcore/src/utils', 'shared docs', '日本語',
            ]);
        });
    });

    describe('name collisions ("docs" as both file and folder)', () => {
        it('root should include the "docs" file', () => {
            expect(drive.files()).toContain('/docs');
        });

        it('root should include "docs" as folder', () => {
            const folders = drive.folders();
            expect(folders.filter(f => f === 'docs')).toHaveLength(1);
        });

        it('cd("docs") should browse the folder and not the file', () => {
            const docsDir = drive.cd('docs');
            expect(docsDir.files()).not.toContain('/docs');
            expect(docsDir.files()).toEqual(['/docs/readme.txt']);
        });

        it('getFile("docs") from root should resolve the file', () => {
            const docsFile = drive.getFile('docs');
            expect(docsFile.path).toBe('/docs');
            expect(docsFile.exists).toBe(true);
        });
    });

    describe('prefix collision', () => {
        it('cd("docs-backup") should not leak any /docs/* files', () => {
            const backup = drive.cd('docs-backup');
            const files = backup.files({ recursive: true });
            expect(files.every(p => p.startsWith('/docs-backup/'))).toBe(true);
        });

        it('cd("docs-backup") should return its own files recursively', () => {
            const backup = drive.cd('docs-backup');
            expect(backup.files({ recursive: true })).toEqual([
                '/docs-backup/notes.txt',
                '/docs-backup/archive/old-notes.txt',
            ]);
        });

        it('cd("docs-backup") non-recursive files() excludes the nested archive/ file', () => {
            const backup = drive.cd('docs-backup');
            expect(backup.files()).toEqual(['/docs-backup/notes.txt']);
        });

        it('cd("docs-backup") folders() surfaces only "archive"', () => {
            const backup = drive.cd('docs-backup');
            expect(backup.folders()).toEqual(['archive']);
        });
    });

    describe('non-existent paths', () => {
        it('cd() into a path with no files returns empty listings, not an error', () => {
            const ghost = drive.cd('this/does/not/exist');
            expect(ghost.files()).toEqual([]);
            expect(ghost.folders()).toEqual([]);
            expect(ghost.files({ recursive: true })).toEqual([]);
        });

        it('getFile() for a path that was never registered returns a non-existent entry, not undefined/throw', () => {
            const missing = drive.getFile('nothing-here.txt');
            expect(missing).toBeDefined();
            expect(missing.exists).toBe(false);
            expect(missing.variants).toEqual({});
        });
    });

    describe('variants and providers', () => {
        it('should expose multiple conflicting rootHash variants for the same path', () => {
            const summer = drive.cd('media/photos/vacation/2023').getFile('summer.png');
            expect(Object.keys(summer.variants)).toEqual(
                expect.arrayContaining(['hashSUM1', 'hashSUM2'])
            );
        });

        it('each variant should carry its own independent peer set', () => {
            const summer = drive.cd('media/photos/vacation/2023').getFile('summer.png');
            expect(Object.keys(summer.variants.hashSUM1.peers)).toEqual(
                expect.arrayContaining(['peerM', 'peerN'])
            );
            expect(Object.keys(summer.variants.hashSUM2.peers)).toEqual(['peerO']);
        });

        it('exists should be false for a variant map with no recorded providers', () => {
            const missing = drive.getFile('nowhere.bin');
            expect(missing.exists).toBe(false);
        });
    });
});