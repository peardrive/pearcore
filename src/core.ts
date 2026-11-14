import { EventEmitter } from 'node:events';
import { AccountService } from './services/accounts.service.js';
import { SpaceService } from './services/space.service.js';
import { ProfileService } from './services/profile.service.js';
import { MessageService } from './services/message.service.js';
import { SpaceDriveService } from './services/drive/drive.service.js';

import { DEFAULT_ACCOUNT_DIR } from './constants/global.constants.js';
import { initializeManagers } from './managers/initialization.js';

export interface CreateCoreOptions {
  rootPath?: string;
  bootstrap?: string | null;
  user?: {
    username: string;
    password: string;
  } | null;
}

export interface CoreServices {
  emitter: EventEmitter;
  managers: ReturnType<typeof initializeManagers>;
  space: SpaceService;
  drives: SpaceDriveService;
  messages: MessageService;
  profile: ProfileService;
  accounts: AccountService;
  getPublicKey: () => string | undefined;
}

/**
 * Initializes and wires together the core service layer of the application.
 *
 * Composes the domain services, configures runtime options, and optionally
 * authenticates a user.
 *
 * @example
 * const core = await createCore({
 *   rootPath: './data',
 *   user: { username: 'alice', password: 'secret' }
 * })
 *
 */
export async function createCore({
  rootPath = DEFAULT_ACCOUNT_DIR,
  bootstrap = null,
  user = null,
}: CreateCoreOptions = {}): Promise<CoreServices> {
  const emitter = new EventEmitter();
  const managers = initializeManagers(emitter);
  const space = new SpaceService(emitter, { managers });
  const drives = new SpaceDriveService(emitter, { managers });
  const messages = new MessageService(emitter, { managers });
  const profile = new ProfileService(emitter, { managers });
  const accounts = new AccountService(emitter, {
    managers: managers,
    root: rootPath,
  });

  if (bootstrap) managers.session.setBootstrapperEndpoint(bootstrap);

  if (user && user.username && user.password) {
    await accounts.authenticate(user.username, user.password);
  }

  const getPublicKey = () => {
    const { publicKey } = managers.session.getCredentials();
    return publicKey || undefined;
  };

  return {
    emitter,
    managers,
    space,
    drives,
    messages,
    profile,
    accounts,
    getPublicKey,
  };
}
