import path from "path";
import fs from 'node:fs/promises';
import * as EVENTS from "../../src/constants/events.constants.js";
import { describe, it, beforeEach, beforeAll, afterAll, expect, vi } from "vitest";
import { CoreFactory } from "../factory.js";
import { exampleFileHierarchy } from '../samples.js';
import { cleanup, generateRandomFile, makeTempDir } from "../general.utils.js";
import { LocalFileEntry } from "../../src/services/drive/components/entries.js";
import { createFileStream, fileExists, getFileSize } from "../../src/utils/system.utils.js";
import { generateMerkleTree } from "../../src/utils/merkletree.utils.js";
import { now } from "../../src/utils/general.utils.js";

describe('SpaceDriveService', () => {
    let root = null;
    let filePath = null;
    let factory;

    // nodes
    let primary;
    let primaryDrive;
    let secondary;
    let secondaryDrive;

    // common space that nodes are subscribed
    let space;

    beforeAll(async () => {
        factory = new CoreFactory();
        await factory.init();

        primary = await factory.createCore();
        secondary = await factory.createCore();

        // create space from the primary node (used for wiring nodes)
        space = await primary.space.create({ spaceName: 'hello' });

        const waitForJoin = new Promise(resolve => {
            secondary.emitter.on(EVENTS.SpaceSync, resolve);
        });

        secondary.space.join(space.sharelink);
        await waitForJoin;

        root = await makeTempDir();
        filePath = path.join(root, 'temporary-file.bin');

        await generateRandomFile(filePath, 1); // 1MB

        primaryDrive = primary.drives.get(space);
        secondaryDrive = secondary.drives.get(space);
    });

    afterAll(async () => {
        await factory.cleanup();
        await cleanup(root);
    });

    describe("Directory navigation and file entries", () => {
        let drive;

        beforeAll(async () => {
            const exampleSpace = await primary.space.create({ spaceName: 'temporary' });

            primary.managers.spaceFileList.spaceFileMap[exampleSpace.topicHash] = exampleFileHierarchy;
            drive = primary.drives.get(exampleSpace)
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

            it('getFile("docs") from root should resolve the file', async () => {
                const docsFile = await drive.getFile('docs');
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

            it('getFile() for a path that was never registered returns a non-existent entry, not undefined/throw', async () => {
                const missing = await drive.getFile('nothing-here.txt');
                expect(missing).toBeDefined();
                expect(missing.exists).toBe(false);
                expect(missing.variants).toEqual([]);
            });
        });

        describe('variants and providers', () => {
            it('should expose multiple conflicting rootHash variants for the same path', async () => {
                const summer = await drive.cd('media/photos/vacation/2023').getFile('summer.png');
                expect(summer.variants).toEqual(expect.arrayContaining(['hashSUM1', 'hashSUM2']));

            });

            it('each variant should carry its own independent peer set', async () => {
                const summer = await drive.cd('media/photos/vacation/2023').getFile('summer.png');

                expect(summer.getProvidersForVariant('hashSUM1')).toEqual(
                    expect.arrayContaining(['peerM', 'peerN'])
                );
                expect(summer.getProvidersForVariant('hashSUM2')).toEqual(['peerO']);
            });

            it('exists should be false for a variant map with no recorded providers', async () => {
                const missing = await drive.getFile('nowhere.bin');
                expect(missing.exists).toBe(false);
            });
        });
    });

    describe('addFile()', () => {
        it('should index local file and settle the entry through full callback cycle', async () => {
            const spacePath = '/uploads/research.pdf';
            const entry = await primaryDrive.addFile(spacePath, filePath);

            expect(entry).toBeInstanceOf(LocalFileEntry);
            expect(entry.fileSourcePath).toBe(filePath);
            expect(entry.path).toBe(spacePath);

            const indexingStack = [];
            let hasError = false;
            let completionCallbackTriggered = false;

            const indexingPromise = new Promise((resolve) => {
                setTimeout(resolve, 2000); // 2 seconds

                entry.onIndexing(snapshot => { indexingStack.push(snapshot) });
                entry.onError(() => { hasError = true; });
                entry.onComplete(() => {
                    completionCallbackTriggered = true;
                    resolve();
                });
            });


            await indexingPromise;

            expect(completionCallbackTriggered).toBe(true);
            expect(hasError).toBe(false);
            expect(entry.rootHash).toBeDefined();
            expect(entry.exists).toBe(true);

            const spaceFiles = primaryDrive.files({ recursive: true });
            const localFiles = primaryDrive.local().files({ recursive: true });

            await vi.waitFor(() => {
                expect(secondaryDrive.files({ recursive: true })).toContain(spacePath);
            }, { timeout: 2000, interval: 50 });

            const secondaryEntry = await secondaryDrive.getFile(spacePath);

            expect(secondaryEntry.variants).toContain(entry.rootHash);
            expect(spaceFiles).toContain(spacePath);
            expect(localFiles).toContain(spacePath);
        });

        it("should trigger error callback on the entry when the indexing has failed", async () => {
            const spacePath = '/uploads/report.pdf';
            const randomFilePath = path.join(root, 'random-file.bin');

            await generateRandomFile(randomFilePath, 1);

            const entry = await primaryDrive.addFile(spacePath, randomFilePath);

            const onError = vi.fn();
            const onCompletion = vi.fn();

            const settlementPromise = new Promise(resolve => {
                setTimeout(resolve, 2000);

                entry.onError(() => {
                    onError();
                    resolve();
                });

                entry.onComplete(() => {
                    onCompletion();
                    resolve();
                });

                entry.onIndexing(snapshot => {
                    // force remove the file past 25% indexing
                    if (snapshot.percent > 25) {
                        fs.rmSync(randomFilePath);
                    }
                });
            });

            await settlementPromise;

            expect(onError).toHaveBeenCalledTimes(1);
            expect(onCompletion).not.toHaveBeenCalled();
            expect(entry.rootHash).toBeNull();
        });
    });

    describe('download()', () => {
        it('should download file from other node', async () => {
            const spacePath = '/uploads/tax-report-2026.pdf';
            const entry = await primaryDrive.addFile(spacePath, filePath);

            const waitForIndexing = new Promise(resolve => {
                setTimeout(resolve, 2000);
                entry.onComplete(resolve);
            });

            await waitForIndexing;

            await vi.waitFor(async () => {
                expect(secondaryDrive.files({ recursive: true })).toContain(spacePath);
            }, { timeout: 2000, interval: 50 });

            const secondaryEntry = await secondaryDrive.getFile(spacePath);
            expect(secondaryEntry.variants).toContain(entry.rootHash);

            const downloadPath = path.join(root, 'downloaded-file.bin');
            const task = await secondaryEntry.download(entry.rootHash, downloadPath);

            let lastSnapShot = null;

            const waitForDownload = new Promise(resolve => {
                setTimeout(resolve, 2000);

                task.onProgress(snapshot => { lastSnapShot = snapshot; });
                task.onComplete(resolve);
            });

            await waitForDownload;

            expect(lastSnapShot.percent).toBe(100);
            expect(lastSnapShot.contributions[0].source).toBe(primary.publicKey);
            expect(lastSnapShot.contributions[0].percent).toBe(100)

            // ensure file has been created on disk after download has completed.
            const exists = await fileExists(downloadPath);
            expect(exists).toBe(true);

            // calculate rootHash and ensure downloaded file matched with the primary file.
            const size = await getFileSize(downloadPath);
            const stream = createFileStream(downloadPath);
            const tree = await generateMerkleTree({ stream, size });

            expect(tree.rootHash).toBe(entry.rootHash);
        });

        describe('multiple providers', () => {
            const spacePath = '/uploads/multi-provider.pdf';

            let thirdCore;
            let thirdDrive;
            let entry;

            beforeAll(async () => {
                thirdCore = await factory.createCore();

                const waitForJoin = new Promise(resolve => {
                    thirdCore.emitter.on(EVENTS.SpaceSync, resolve);
                });

                thirdCore.space.join(space.sharelink);
                await waitForJoin;

                thirdDrive = thirdCore.drives.get(space);

                const currentFilePathOne = path.join(root, 'huge-file.bin');
                const currentFilePathTwo = path.join(root, 'huge-file.bin');

                await generateRandomFile(currentFilePathOne, 30); // inject 30MB file
                await fs.copyFile(currentFilePathOne, currentFilePathTwo);

                const primaryEntry = await primaryDrive.addFile(spacePath, currentFilePathOne);
                const thirdEntry = await thirdDrive.addFile(spacePath, currentFilePathTwo);

                await Promise.all([
                    new Promise(resolve => primaryEntry.onComplete(resolve)),
                    new Promise(resolve => thirdEntry.onComplete(resolve)),
                ]);

                entry = primaryEntry;
            });

            it('should report contributions from more than one provider', async () => {
                const rootHash = entry.rootHash;

                const secondaryEntry = await secondaryDrive.getFile(spacePath);

                await vi.waitFor(() => {
                    expect(secondaryEntry.getProvidersForVariant(rootHash)).toEqual(
                        expect.arrayContaining([primary.publicKey, thirdCore.publicKey])
                    );
                }, { timeout: 2000, interval: 50 });

                const downloadPath = path.join(root, 'multi-provider-downloaded.bin');
                const task = await secondaryEntry.download(rootHash, downloadPath);

                let lastSnapshot = null;

                const waitForDownload = new Promise(resolve => {
                    task.onProgress(snapshot => { lastSnapshot = snapshot; });

                    task.onComplete(() => {
                        resolve();
                    });
                });

                await waitForDownload;

                expect(lastSnapshot.percent).toBe(100);

                // ensure both nodes have contributed to the download
                const sources = lastSnapshot.contributions.map(c => c.source);
                expect(
                    sources.every(s => [primary.publicKey, thirdCore.publicKey].includes(s))
                ).toBe(true);

                // ensure the sum of contributions round close to 100% (they are not supposed to be explicitly 100%)
                const totalPercent = lastSnapshot.contributions.reduce((sum, c) => sum + c.percent, 0);
                expect(totalPercent).toBeCloseTo(100, 5);

                const exists = await fileExists(downloadPath);
                expect(exists).toBe(true);

                const size = await getFileSize(downloadPath);
                const stream = createFileStream(downloadPath);
                const tree = await generateMerkleTree({ stream, size });
                expect(tree.rootHash).toBe(rootHash);

            });
        });
    });
});