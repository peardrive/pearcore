import os from 'os';
import HyperDHT from 'hyperdht';
import Hyperswarm from 'hyperswarm';
import { hash, hexToUint8, validateKeypair } from './crypto.utils.js';


/**
 * Get all IPv4 addresses from network interfaces.
 * @returns {string[]} Array of IPv4 addresses from non-internal network interfaces
 */
export function getIPv4() {
  const interfaces = os.networkInterfaces();
  const ipv4addresses = [];

  for (let interfaceName in interfaces) {
    const networkAddresses = interfaces[interfaceName];

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
 * @param {Object} opts
 * @param {number} [opts.port=3000] - UDP port to listen on
 * @param {Boolean} [opts.ephermeral=3000] - Make the DHT node persistent
 * @param {Array} [opts.bootstrap] - Interface to bind the DHT node to
 * @returns {Promise<HyperDHT>} Resolves when the DHT node is fully ready
 */
export async function startDHTServer({ port = 3000, ephermeral = false, bootstrap }) {
  const persistent = new HyperDHT({
    bootstrap: bootstrap,
    ephermeral: ephermeral,
    port: port
  })

  await persistent.fullyBootstrapped();
  return persistent;
}

/**
 * Start a DHT bootstrapper node.
 * @param {Object} opts 
 * @param {number} opts.port - UDP port for bootstrapper node
 * @param {string} opts.ipv4 - IPV4 address to bind the bootstrapper to (should be IPV4 and 0.0.0.0 is not acceptable)
 * @returns {Promise<HyperDHT>} Resolves when the bootstrapper node is fully ready
 */
export async function startBootstrapper({ port, ipv4 }) {
  if (!port) throw new Error('Port is required')
  if (!ipv4) throw new Error('Host is required')

  const bootstrap = HyperDHT.bootstrapper(port, ipv4);
  await bootstrap.fullyBootstrapped();

  const persistentNode = await startDHTServer({
    port: port + 1,
    ephermeral: false,
    bootstrap: [{ host: ipv4, port: port }]
  });

  return {
    bootstrapperNode: bootstrap,
    persistentNode: persistentNode
  };
}

/**
 * Create and configure a Hyperswarm instance.
 *
 * @param {Object} opts
 * @param {Object} [opts.keyPair]
 *        Optional permanent identity in the form:
 *        { publicKey: Uint8Array, secretKey: Uint8Array }.
 *
 * @param {string} [opts.bootstrap.port]
 *        Optional custom DHT bootstrap host (e.g., "192.168.1.23").
 *
 * @param {number} [opts.bootstrap.host]
 *        Optional custom DHT bootstrap port (e.g., 49737).
 *
 * @returns {Hyperswarm}
 *          A newly created Hyperswarm instance. The swarm is not yet
 *          participating in any topic until `joinSwarmTopic()` is called.
 */
export function connectSwarm({
  keyPair=undefined,
  bootstrap=undefined
} = {}) {

  const bootstrapOpts = (bootstrap && bootstrap.port && bootstrap.host)
    ? [{ host: bootstrap.host, port: Number(bootstrap.port) }]
    : undefined

  if (keyPair) validateKeypair(keyPair);
  const swarm = new Hyperswarm({ keyPair, bootstrap: bootstrapOpts })

  return swarm
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
 * @param {Hyperswarm} swarm
 *        The active Hyperswarm instance created by `connectSwarm()`.
 *
 * @param {string} topic
 *        Topic string used to generate a deterministic discovery key.
 *
 * @param {Object} [opts]
 * @param {boolean} [opts.server=true]
 *        If true, the node will ANNOUNCE itself (Hyperswarm announce).
 *
 * @param {boolean} [opts.client=true]
 *        If true, the node will LOOKUP other announcers (Hyperswarm lookup).
 *
 * @returns {Promise<void>}
 *          Resolves when the join operation has been flushed to the DHT.
 */
export async function joinSwarmTopic(
  swarm,
  topic,
  { server = true, client = true } = {}
) {
  if (!server && !client)
    throw new Error('joinSwarmTopic() requires at least one of server or client modes')

  if (typeof topic !== 'string') {
    throw new Error('Hyperswarm topic should be typeof string');
  }

  const topicBuffer = hexToUint8(topic);

  const discovery = swarm.join(topicBuffer, {
    announce: server,
    lookup: client
  });

  // The announce reaching the DHT is unbounded on a slow network (six minutes seen).
  // Callers need the discovery now, so hash lists and space.join()/create() do not wait
  // on it; the swarm keeps announcing in the background either way.
  discovery.flushed().catch(() => {});

  return discovery;
}