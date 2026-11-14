import { startBootstrapper } from '../utils/network.utils.js';

/**
 * Starts a HyperDHT bootstrap node and a Hyperswarm node
 * that joins the default topic for logging peer joins.
 */
export async function startBootstrapServer({
  ipv4 = '127.0.0.1',
  port = 8787,
} = {}) {
  const bootstrapper = await startBootstrapper({
    ipv4: ipv4,
    port: port,
  });

  return {
    ipv4: ipv4,
    port: port,
    bootstrapperNode: bootstrapper.bootstrapperNode,
    persistentNode: bootstrapper.persistentNode,
  };
}
