// @ts-nocheck
import { startBootstrapper } from '../src/utils/network.utils.js';
import { getRandomPort } from './general.utils.js';
import { BaseCoreFactory } from './factory.base.js';

/**
 * End-to-end factory.
 *
 * Starts a local HyperDHT bootstrapper and gives every core a real
 * Hyperswarm/DHT transport. Use this when a suite needs to exercise actual
 * peer-to-peer networking. Fast unit/integration suites should use
 * `MockCoreFactory` instead.
 */
export class CoreFactory extends BaseCoreFactory {
  constructor() {
    super();
    this.bootstrapperInstance = null;
    this.bootstrapperEndpoint = null;
  }

  async init() {
    const randomPort = getRandomPort();
    this.bootstrapperInstance = await startBootstrapper({
      ipv4: '127.0.0.1',
      port: randomPort,
    });

    this.bootstrapperEndpoint = `127.0.0.1:${randomPort}`;
  }

  createOptions() {
    return { bootstrap: this.bootstrapperEndpoint };
  }

  async cleanup() {
    await super.cleanup();

    if (this.bootstrapperInstance) {
      await this.bootstrapperInstance.bootstrapperNode.destroy();
      await this.bootstrapperInstance.persistentNode.destroy();
    }
  }
}
