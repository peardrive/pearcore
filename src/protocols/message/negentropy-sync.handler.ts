import * as EVENTS from '../../constants/events.constants.js';
import * as MESSAGES from '../../constants/messages.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import { validateNegentropySyncPayload } from '../../utils/protocol.utils.js';
import { getSpaceByTopicHash } from '../../utils/space.utils.js';
import { canRead, notRelayed, validPayload } from '../shared/guards.js';

/**
 * Handles one round of message-history reconciliation (Negentropy) for a space.
 * The peer only gets an answer once it is allowed to read the space.
 */
export class NegentropySyncHandler extends BaseProtocolHandler {
  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<any>,
    info: PeerInfo,
  ): Promise<void> {
    const ctx = this.context(socket, message, info);

    const space = await getSpaceByTopicHash(this.db, message.topic);
    if (!space) {
      await this.reject(ctx, MESSAGES.SPACE_NOT_FOUND_MESSAGE);
      return;
    }

    const { maxRanges, maxIdListSize } =
      this.sessionManager.getMessageConfig().reconciliation;

    const { result, reason } = await this.enforce(ctx, [
      notRelayed,
      validPayload((payload) =>
        validateNegentropySyncPayload(payload, {
          maxRanges,
          maxIdListSize,
        }),
      ),
      canRead(space, 'sender'),
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    this.emitProtocol(EVENTS.NegentropySync, ctx);
    await this.syncManager!.handleMessage(socket, message, space.id);
  }
}
