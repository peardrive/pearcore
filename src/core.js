import { EventEmitter } from 'node:events';
import { AccountService } from './services/accounts.service.js';
import { SpaceService } from './services/space.service.js';
import { ProfileService } from './services/profile.service.js';
import { MessageService } from './services/message.service.js';

import { DEFAULT_ACCOUNT_DIR } from './constants/global.constants.js';
import { initializeManagers } from './managers/initialization.js';

/**
 * Initializes and wires together the core service layer of the application.
 *
 * This factory function composes the primary domain services
 * (SessionService, AccountService, SpaceService, MessageService, ProfileService),
 * configures runtime options (root path and bootstrap node),
 * and optionally authenticates a user.
 *
 * @async
 * @function createCore
 *
 * @param {Object} [options={}] - Initialization options.
 * @param {string} [options.rootPath=DEFAULT_ACCOUNT_DIR]
 *   Filesystem root directory used for account/session persistence.
 *   If provided, it is applied to SessionService via `setRootPath`.
 *
 * @param {string|null} [options.bootstrap=null]
 *   Optional bootstrap address in `host:port` format.
 *   When defined, it is parsed and applied to the session via `setBootstrap`.
 *
 * @param {Object|null} [options.user=null]
 *   Optional user credentials for automatic authentication.
 *
 * @param {string} options.user.username
 *   Username used for account authentication.
 *
 * @param {string} options.user.password
 *   Password used for account authentication.
 *
 * @returns {Promise<{
 *   session: SessionService,
 *   accounts: AccountService,
 *   space: SpaceService,
 *   profile: ProfileService,
 *   messages: MessageService,
 *   getPublicKey: Function
 * }>}
 *   A fully initialized service container with authenticated session
 *   (if credentials were provided).
 *
 * @throws {Error}
 *   Propagates any errors thrown during authentication or service initialization.
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
} = {}) {

  const emitter = new EventEmitter();
  const managers = initializeManagers(emitter);
  const space = new SpaceService(emitter, { managers });
  const messages = new MessageService(emitter, { managers });
  const profile = new ProfileService(emitter, { managers });
  const accounts = new AccountService(emitter, { 
    managers: managers,
    root: rootPath 
  });


  if (bootstrap) managers.session.setBootstrapperEndpoint(bootstrap);

  if (user && user.username && user.password) {
    await accounts.authenticate(user.username, user.password);
  }

  const getPublicKey = () => {
    const { publicKey } = managers.session.getCredentials();
    return publicKey || undefined; 
  }

  return {
    emitter,
    managers,
    space,
    messages,
    profile,
    accounts,
    getPublicKey
  }
}