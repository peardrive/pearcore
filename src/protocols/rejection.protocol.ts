import * as EVENTS from '../constants/events.constants.js';
import { hex } from '../utils/crypto.utils.js';
import { BaseProtocolHandler } from './base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from './base.js';

type RejectionPayload = {
  reason: string;
  linkedMessageNonce: string;
};

export class RejectionProtocolHandler extends BaseProtocolHandler {
  override async handle(
    _socket: ProtocolSocket,
    message: ProtocolMessage<RejectionPayload>,
    info: PeerInfo,
  ): Promise<void> {
    const publicKey = hex(info.publicKey);

    // trigger rejection event to be used within other managers/services.
    this.emit(EVENTS.Reject, {
      info,
      message,
      fromPublicKey: publicKey,
      reason: message.payload.reason,
      linkedMessageNonce: message.payload.linkedMessageNonce,
    });
  }
}
