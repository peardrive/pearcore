import * as EVENTS from '../../constants/events.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import { validateSpaceFileContentCancelPayload } from '../../utils/protocol.utils.js';
import { notRelayed, validPayload } from '../shared/guards.js';

type SpaceFileContentCancelPayload = {
  key: string;
};

export class SpaceFileContentCancelHandler extends BaseProtocolHandler {
  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<SpaceFileContentCancelPayload>,
    info: PeerInfo,
  ): Promise<void> {
    const ctx = this.context(socket, message, info);

    const { result, reason } = await this.enforce(ctx, [
      notRelayed,
      validPayload(validateSpaceFileContentCancelPayload),
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    const { key } = message.payload;
    // a peer can only abort the tasks it requested itself
    this.spaceFileManager.abortDeliveryTask(key, message.publicKey);
    this.emitProtocol(EVENTS.SpaceFileContentCancel, ctx, { key });
  }
}
