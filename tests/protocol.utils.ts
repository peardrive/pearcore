// @ts-nocheck
import * as EVENTS from '../src/constants/events.constants.js';
import { hexToUint8 } from '../src/utils/crypto.utils.js';

/**
 * Protocol-test surface for factory cores.
 *
 * Unlike a fake-socket harness this owns no transport: cores are connected
 * through the in-memory peer network, deterministic messages are injected into
 * the receiver over the real link, and every reply is observed as the message
 * the sender node receives (`EVENTS.General`), which the message manager emits
 * for each handled protocol message.
 *
 * Assertions are scoped by message type (and sender where it matters), so the
 * handshake chatter and duplicate-nonce rejections of the space handshake never
 * leak into them.
 */

/**
 * Connects every core through the shared topic, like discovery would, and waits
 * until the resulting connections and handshakes are flushed.
 */
export async function connectProtocolNodes(factory, topicHash, cores) {
  for (const core of cores) {
    await core.managers.connection.join(topicHash);
  }

  await factory.settle();
}

/**
 * Injects a message into `to` as if it was sent by `from` on their direct link.
 * The handler's reply travels back over the real connection and shows up in
 * `from`'s message collector.
 */
export async function deliverMessage(to, from, message) {
  const [socket] = to.managers.sockets.getConnectedSockets({
    peers: [from.publicKey],
  });

  if (!socket) {
    throw new Error(`${to.name} has no connection to ${from.name}`);
  }

  await to.managers.message.handleIncomingMessage(
    socket,
    JSON.stringify(message),
    { publicKey: hexToUint8(from.publicKey) },
  );
}

/**
 * Collects every protocol message the core receives. Attach the collector once
 * the network is quiet, so setup handshakes stay out of the assertions.
 */
export function collectMessages(core) {
  const received = [];

  core.emitter.on(EVENTS.General, (context) => received.push(context));

  return {
    /** Every received message of `type`, optionally only the ones from `from`. */
    of(type, from = null) {
      return received.filter(
        (entry) =>
          entry.message.type === type &&
          (!from || entry.publicKey === from.publicKey),
      );
    },
  };
}
