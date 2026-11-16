// @ts-nocheck
import dgram from 'node:dgram';
import { startBootstrapper } from '../src/utils/network.utils.js';
import { BaseCoreFactory } from './factory.base.js';

/**
 * Binds a UDP port on loopback and returns the port the OS picked, or the given one.
 * Used to probe availability: the socket is closed before the promise resolves.
 */
function bindUdpPort(port = 0) {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');

    socket.once('error', (error) => {
      try {
        socket.close();
      } catch {}
      reject(error);
    });

    socket.bind(port, '127.0.0.1', () => {
      const assigned = socket.address().port;
      socket.close(() => resolve(assigned));
    });
  });
}

/**
 * Finds a free pair of consecutive UDP ports for the bootstrapper (it uses `port`
 * and `port + 1`).
 *
 * Candidates are random because the OS keeps handing back the port it just freed,
 * which would make concurrent factories pick the same pair. Random ports can also
 * fall into an excluded range (e.g. Windows hypervisor reservations), so a failed
 * probe just moves on to the next candidate.
 */
async function findFreeBootstrapperPort() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const port = 20000 + Math.floor(Math.random() * 40000);

    try {
      await bindUdpPort(port);
      await bindUdpPort(port + 1);
      return port;
    } catch {
      // taken or reserved, try another candidate
    }
  }

  throw new Error('could not find a free UDP port pair for the bootstrapper');
}

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
    let lastError: unknown;

    // the port can still be taken between probing and binding (parallel test files)
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await findFreeBootstrapperPort();

      try {
        this.bootstrapperInstance = await startBootstrapper({
          ipv4: '127.0.0.1',
          port,
        });

        this.bootstrapperEndpoint = `127.0.0.1:${port}`;
        return;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
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
