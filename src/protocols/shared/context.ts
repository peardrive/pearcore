import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import { hex } from '../../utils/crypto.utils.js';

/**
 * State shared by a protocol handler and its guards for one incoming message.
 *
 * The context is deliberately stateless: it describes only the message and the
 * connection that delivered it. Resources such as spaces are resolved by their
 * own services and passed to guards explicitly, so this type stays independent
 * of how (or where) they are stored.
 */
export interface ProtocolContext {
  /** Socket of the peer that delivered the message; used for replies and forwarding. */
  socket: ProtocolSocket;
  /** The signed message being handled. */
  message: ProtocolMessage<any>;
  /** Raw connection details reported by the transport. */
  info: PeerInfo;
  /**
   * Hex-encoded public key of the peer that delivered the message.
   * This is the transport sender, which is not necessarily the message author
   * (`message.publicKey`).
   */
  senderPublicKey: string;
}

/**
 * Builds the context of an incoming protocol message.
 *
 * @param socket - Socket of the delivering peer.
 * @param message - Incoming signed message.
 * @param info - Connection details reported by the transport.
 * @returns The context shared by the handler and its guards.
 */
export function createProtocolContext(
  socket: ProtocolSocket,
  message: ProtocolMessage<any>,
  info: PeerInfo,
): ProtocolContext {
  return {
    socket,
    message,
    info,
    senderPublicKey: hex(info.publicKey),
  };
}
