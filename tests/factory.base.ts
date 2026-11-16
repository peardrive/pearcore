// @ts-nocheck
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCore } from '../src/core.js';
import { createDatabase } from '../src/database/database.js';
import { hex } from '../src/utils/crypto.utils.js';
import { createProfileForPublicKey } from '../src/utils/profile.utils.js';
import {
  cleanup as removeDir,
  generateKeypair,
  makeTempDir,
} from './general.utils.js';

const PASSWORD = 'testPassword';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

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

    const extendedCore = {
      ...core,
      root,
      username,
      publicKey,
      secretKey,
      authenticated: true,
    };
    this.cores.push(extendedCore);
    return extendedCore;
  }

  /**
   * Creates a core with a database and credentials but without authenticating.
   *
   * Useful for tests that drive manager initialization themselves while still
   * using the factory's transport options and temp-root lifecycle.
   */
  async createBareCore() {
    const root = await makeTempDir();
    const core = await createCore({
      rootPath: root,
      ...this.createOptions(),
    });

    const { db, sqlite } = await createDatabase(
      path.join(root, 'db.sqlite'),
      MIGRATIONS_DIR,
    );
    const { publicKey, secretKey } = await generateKeypair();

    core.managers.session.setDatabase({ db, sqlite });
    core.managers.session.setCredentials({
      publicKey: hex(publicKey),
      secretKey: hex(secretKey),
    });

    const extendedCore = {
      ...core,
      root,
      publicKey: hex(publicKey),
      secretKey: hex(secretKey),
      authenticated: false,
    };
    this.cores.push(extendedCore);
    return extendedCore;
  }

  async cleanup() {
    for (const core of this.cores) {
      try {
        if (core.authenticated === false) {
          await core.managers.connection.destroy();
          await core.managers.sync.stop();
          await core.managers.delivery.stop();
          core.managers.session.getDatabase().sqlite?.close();
        } else {
          await core.accounts.logout();
        }
      } catch (error) {
        console.error(error);
      }

      if (core.root) {
        try {
          await removeDir(core.root);
        } catch (error) {
          console.error(error);
        }
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
