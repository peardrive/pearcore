// @ts-nocheck
import { createCore } from '../src/core.js';
import { createProfileForPublicKey } from '../src/utils/profile.utils.js';
import { cleanup as removeDir, makeTempDir } from './general.utils.js';

const PASSWORD = 'testPassword';

/**
 * Shared factory surface for test cores.
 *
 * `CoreFactory` (real network) and `MockCoreFactory` (in-memory network) only
 * provide their transport options; account creation, authentication and
 * profile setup run through the real services here.
 */
export class BaseCoreFactory {
  constructor() {
    this.cores = [];
  }

  async init() {
    // optional per-factory setup
  }

  /**
   * Transport options forwarded to `createCore()`.
   * Subclasses override this to select a network.
   */
  createOptions() {
    return {};
  }

  async createCore(username = 'test user') {
    const root = await makeTempDir();
    const core = await createCore({
      rootPath: root,
      ...this.createOptions(),
    });

    await core.accounts.create(username, PASSWORD);
    await core.accounts.authenticate(username, PASSWORD);

    const { publicKey, secretKey } = core.managers.session.getCredentials();
    const { db } = core.managers.session.getDatabase();

    const profile = {
      username: username,
      tag: `tag@${username}`,
      profileURL: null,
    };

    await createProfileForPublicKey(db, { ...profile, publicKey }, secretKey);

    const extendedCore = { ...core, root, username, publicKey, secretKey };
    this.cores.push(extendedCore);
    return extendedCore;
  }

  async cleanup() {
    for (const core of this.cores) {
      try {
        await core.accounts.logout();

        if (core.root) {
          await removeDir(core.root);
        }
      } catch (error) {
        console.error(error);
      }
    }

    this.cores = [];
  }

  async createMultipleCores(count) {
    const cores = [];
    for (let index = 0; index < count; index++) {
      const username = `testUserIndex_${index}`;
      const core = await this.createCore(username);
      cores.push(core);
    }

    return cores;
  }

  async condition(fn, opts = {}) {
    const { excludeIndices = [], timeout = 10000 } = opts;

    return new Promise((resolve, reject) => {
      let results = [];
      const corePromises = [];

      const timer = setTimeout(() => {
        reject(new Error(`condition timeout after ${timeout} ms`));
      }, timeout);

      const resolverFactory = (resolver, index) => {
        const caller = (successState) => {
          return (data = {}) => {
            results.push({
              index: index,
              success: successState,
              data: data,
            });

            resolver();
          };
        };

        return {
          success: caller(true),
          failure: caller(false),
        };
      };

      for (let index = 0; index < this.cores.length; index++) {
        if (excludeIndices.includes(index)) continue;

        corePromises.push(
          new Promise((resolveCore) => {
            const { success, failure } = resolverFactory(resolveCore, index);
            fn(this.cores[index], success, failure);
          }),
        );
      }

      Promise.allSettled(corePromises)
        .then(() => {
          clearTimeout(timer);
          resolve(results);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }
}
