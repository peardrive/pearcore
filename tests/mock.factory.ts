// @ts-nocheck
import { BaseCoreFactory } from './factory.base.js';
import { InMemoryNetwork } from './in-memory.network.js';

/**
 * Unit/integration factory backed by the in-memory peer network.
 *
 * Accounts are real on-disk accounts under a temp root, so core setup runs
 * through `AccountService.create()` / `authenticate()` exactly as in
 * production. Only the peer transport is virtual.
 */
export class MockCoreFactory extends BaseCoreFactory {
  constructor() {
    super();
    this.network = new InMemoryNetwork();
  }

  createOptions() {
    return { peerNetworkFactory: this.network.factory };
  }

  async cleanup() {
    // Let queued frames reach their handlers before tearing sockets down;
    // otherwise in-flight messages are processed after their peer record
    // has been removed.
    await this.network.settle().catch(() => {});
    await super.cleanup();
    await this.network.destroy();
  }

  /**
   * Waits until the in-memory network has no frame left in flight.
   */
  async settle(options = {}) {
    await this.network.settle(options);
  }

  /**
   * Opens a direct connection between two cores (Hyperswarm `joinPeer`).
   */
  connect(coreA, coreB) {
    coreA.managers.connection.connectWith(coreB.publicKey);
  }

  /**
   * Cuts the link between two cores, if one exists.
   */
  disconnect(coreA, coreB) {
    return this.network.disconnect(coreA.publicKey, coreB.publicKey);
  }
}
