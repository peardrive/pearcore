import { describe, it, beforeEach, beforeAll, afterAll, expect } from "vitest";
import { CoreFactory } from "../factory.js";
import { exampleFileHierarchy } from '../samples.js';

describe('SpaceFileService', () => {
    let factory;
    let core;
    let space;

    beforeAll(async () => {
        factory = new CoreFactory();
        await factory.init();

        core = await factory.createCore();
        space = await core.space.create({ spaceName: 'hello' });
        core.managers.spaceFileList.spaceFileMap[space.topicHash] = exampleFileHierarchy;
    });

    afterAll(async () => {
        await factory.cleanup();
    });

    it('should brows files', async () => {
        const drive = core.drives.get(space);
        console.log(drive.files())
        console.log(drive.folders());
        console.log(drive.folders({ recursive: true }));
        const projectDirectory = drive.cd('docs-backup');
        console.log(projectDirectory.folders({ recursive: true }))
        console.log(projectDirectory.files({ recursive: true }))
    });
});