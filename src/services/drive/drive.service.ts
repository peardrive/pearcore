import { SpaceInstance } from '../space.service.js';
import { SpaceDriveBrowser } from './components/browsers.js';

export class SpaceDriveService {
  [key: string]: any;

  constructor(emitter: any, { managers }: any) {
    this.sessionManager = managers.session;
    this.spacefileListManager = managers.spaceFileList;
    this.spaceFileManagaer = managers.spaceFiles;
  }

  /**
   * Get file browser for a given space.
   * @param space - the space record.
   * @returns */
  get(space: SpaceInstance) {
    const browser = new SpaceDriveBrowser({
      path: '/',
      spaceInstance: space,
      spaceFileListManager: this.spacefileListManager,
      spaceFileManager: this.spaceFileManagaer,
      sessionManager: this.sessionManager,
    });

    return browser;
  }
}
