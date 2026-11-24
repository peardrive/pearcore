import * as EVENTS from '../../constants/events.constants.js';
import * as MESSAGES from '../../constants/messages.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import { spaceShouldEncryptMessages } from '../../utils/policy.utils.js';
import { validateHexString } from '../../utils/general.utils.js';
import { decryptPayload } from '../../utils/protocol.utils.js';
import { getSpaceByTopicHash } from '../../utils/space.utils.js';
import { canBroadcast, canRead, subscribed } from '../shared/guards.js';

export class SpaceMessageHandler extends BaseProtocolHandler {
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

    const { result, reason } = await this.enforce(ctx, [
      // sender must be subscribed to the message topic.
      subscribed(this.socketManager),
      // sender must be allowed to read the space.
      canRead(space, 'sender'),
      // author must be allowed to broadcast in the space.
      canBroadcast(space, 'author'),
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    const shouldDecryptCipher =
      spaceShouldEncryptMessages(space) &&
      typeof message.payload === 'string' &&
      validateHexString(message.payload);

    const content = shouldDecryptCipher
      ? await decryptPayload({
          payload: message.payload,
          spaceSecret: space.secret!,
          nonce: message.nonce,
        })
      : message.payload;

    this.emitProtocol(EVENTS.SpaceMessage, ctx, { content });
    await this.forward(ctx, message, {
      topic: message.topic,
      space,
    });
  }
}
