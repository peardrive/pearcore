import { SpaceInstance } from "../space.service.js";
import { SpaceDriveBrowser } from "./components/browsers.js";

export class SpaceDriveService {
    constructor(emitter, { managers }) {
        this.sessionManager = managers.session;
        this.spacefileListManager = managers.spaceFileList;
        this.spaceFileManagaer = managers.spaceFiles;
    }

    /**
     * Get file browser for a given space.
     * @param {SpaceInstance} space - the space record.
     * @returns {SpaceDriveBrowser}
     */
    get(space) {
        const browser = new SpaceDriveBrowser({
            path: '/',
            spaceInstance: space,
            spaceFileListManager: this.spacefileListManager,
            spaceFileManager: this.spaceFileManagaer,
            sessionManager: this.sessionManager
        });

        return browser;
    }
}