import os from 'os';
import HyperDHT from 'hyperdht';
import Hyperswarm from 'hyperswarm';
import type { PeerDiscovery } from 'hyperswarm';
import type { DHTNodeAddress } from 'hyperdht';
import type { KeyPair } from './crypto.utils.js';
import { hash, hex, hexToUint8, validateKeypair } from './crypto.utils.js';
import type {
  PeerNetworkFactory,
  PeerSocket,
} from '../types/peer-network.js';

/**
 * Get all IPv4 addresses from network interfaces.
 * @returns Array of IPv4 addresses from non-internal network interfaces
 */
export function getIPv4(): string[] {
  const interfaces = os.networkInterfaces();
  const ipv4addresses: string[] = [];

  for (let interfaceName in interfaces) {
    const networkAddresses = interfaces[interfaceName] ?? [];

    for (let networkAddress of networkAddresses) {
      if (!networkAddress.internal && networkAddress.family === 'IPv4') {
        ipv4addresses.push(networkAddress.address);
      }
    }
  }

  return ipv4addresses;
}

/**
 * Start a HyperDHT node.
 * @param [opts.port=3000] - UDP port to listen on
 * @param [opts.ephemeral=false] - Make the DHT node ephemeral
 * @param [opts.bootstrap] - Interface to bind the DHT node to
 * @returns Resolves when the DHT node is fully ready
 */
export async function startDHTServer({
  port = 3000,
  ephemeral = false,
  bootstrap,
}: {
  port?: number;
  ephemeral?: boolean;
  bootstrap?: DHTNodeAddress[];
}): Promise<HyperDHT> {
  const persistent = new HyperDHT({
    bootstrap: bootstrap,
    ephemeral: ephemeral,
    port: port,
  });

  await persistent.fullyBootstrapped();
  return persistent;
}

/**
 * Start a DHT bootstrapper node.
 * @param opts.port - UDP port for bootstrapper node
 * @param opts.ipv4 - IPV4 address to bind the bootstrapper to (should be IPV4 and 0.0.0.0 is not acceptable)
 * @returns Resolves when the bootstrapper node is fully ready
 */
export async function startBootstrapper({
  port,
  ipv4,
}: {
  port: number;
  ipv4: string;
}): Promise<{ bootstrapperNode: HyperDHT; persistentNode: HyperDHT }> {
  if (!port) throw new Error('Port is required');
  if (!ipv4) throw new Error('Host is required');

  const bootstrap = HyperDHT.bootstrapper(port, ipv4);
  await bootstrap.fullyBootstrapped();

  const persistentNode = await startDHTServer({
    port: port + 1,
    ephemeral: false,
    bootstrap: [{ host: ipv4, port: port }],
  });

  return {
    bootstrapperNode: bootstrap,
    persistentNode: persistentNode,
  };
}

/**
 * Create and configure a Hyperswarm instance.
 *
 * @param [opts.keyPair]
 *        Optional permanent identity in the form:
 *        { publicKey: Uint8Array, secretKey: Uint8Array }.
 *
 * @param [opts.bootstrap.host]
 *        Optional custom DHT bootstrap host (e.g., "192.168.1.23").
 *
 * @param [opts.bootstrap.port]
 *        Optional custom DHT bootstrap port (e.g., 49737).
 *
 * @returns
 *          A newly created Hyperswarm instance. The swarm is not yet
 *          participating in any topic until `joinSwarmTopic()` is called.
 */
export function connectSwarm({
  keyPair = undefined,
  bootstrap = undefined,
}: {
  keyPair?: KeyPair;
  bootstrap?: { host?: string; port?: string | number };
} = {}): Hyperswarm {
  const bootstrapOpts =
    bootstrap && bootstrap.port && bootstrap.host
      ? [{ host: bootstrap.host, port: Number(bootstrap.port) }]
      : undefined;

  if (keyPair) {
    validateKeypair(keyPair);
  }
  
  const swarm = new Hyperswarm({ keyPair, bootstrap: bootstrapOpts });

  return swarm;
}

/**
 * Join a specific topic on a Hyperswarm instance.
 *
 * This utility derives a discovery key from the given topic string and
 * joins the topic using configurable role semantics:
 *
 *   - opts.server → announce (be discoverable by others)
 *   - opts.client → lookup   (discover others)
 *
 * This abstraction makes intent clearer:
 *   server = true   → your node acts like a broadcaster / service
 *   client = true   → your node searches for servers in the topic
 *
 * If neither is enabled, the function will throw an error, since the node
 * wouldn't interact with the topic at all.
 *
 * @param swarm
 *        The active Hyperswarm instance created by `connectSwarm()`.
 *
 * @param topic
 *        Topic string used to generate a deterministic discovery key.
 *
 * @param [opts.server=true]
 *        If true, the node will ANNOUNCE itself (Hyperswarm announce).
 *
 * @param [opts.client=true]
 *        If true, the node will LOOKUP other announcers (Hyperswarm lookup).
 *
 * @returns
 *          Resolves when the join operation has been flushed to the DHT.
 */
export async function joinSwarmTopic(
  swarm: Hyperswarm,
  topic: string,
  { server = true, client = true }: { server?: boolean; client?: boolean } = {},
): Promise<PeerDiscovery> {
  if (!server && !client)
    throw new Error(
      'joinSwarmTopic() requires at least one of server or client modes',
    );

  if (typeof topic !== 'string') {
    throw new Error('Hyperswarm topic should be typeof string');
  }

  const topicBuffer = hexToUint8(topic);

  const discovery = swarm.join(topicBuffer, {
    announce: server,
    lookup: client,
  });

  await discovery.flushed();

  return discovery;
}

/**
 * Hyperswarm-backed implementation of `PeerNetwork`.
 *
 * This is the only place that maps the transport API onto the
 * transport-independent peer network contract.
 */
export const hyperswarmPeerNetworkFactory: PeerNetworkFactory = (options) => {
  const swarm = connectSwarm(options) as Hyperswarm & {
    joinPeer(publicKey: Uint8Array): void;
  };

  return {
    onConnection(listener) {
      swarm.on(
        'connection',
        (
          socket: unknown,
          info: { publicKey: Uint8Array; topics?: Uint8Array[] },
        ) => {
          listener(socket as PeerSocket, {
            publicKey: hex(info.publicKey),
            topics: (info.topics ?? []).map((topic) => hex(topic)),
          });
        },
      );
    },

    join(topic) {
      return joinSwarmTopic(swarm, topic);
    },

    connect(publicKey) {
      swarm.joinPeer(hexToUint8(publicKey));
    },

    destroy() {
      return swarm.destroy();
    },
  };
};
