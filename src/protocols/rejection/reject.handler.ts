import * as EVENTS from '../../constants/events.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';

type RejectionPayload = {
  reason: string;
  linkedMessageNonce: string;
};

export class RejectionProtocolHandler extends BaseProtocolHandler {
  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<RejectionPayload>,
    info: PeerInfo,
  ): Promise<void> {
    const ctx = this.context(socket, message, info);

    // trigger rejection event to be used within other managers/services.
    this.emitProtocol(EVENTS.Reject, ctx, {
      fromPublicKey: ctx.senderPublicKey,
      reason: message.payload.reason,
      linkedMessageNonce: message.payload.linkedMessageNonce,
    });
  }
}
