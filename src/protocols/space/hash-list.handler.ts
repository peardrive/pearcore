import * as EVENTS from '../../constants/events.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import { publicKeyIsAllowedToRead } from '../../utils/policy.utils.js';
import { stripIds } from '../../utils/general.utils.js';
import {
  createSpaceSyncMessage,
  validateSpaceHashListPayload,
} from '../../utils/protocol.utils.js';
import { notRelayed, validPayload } from '../shared/guards.js';

export class SpaceHashListHandler extends BaseProtocolHandler {
  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<string[]>,
    info: PeerInfo,
  ): Promise<void> {
    const ctx = this.context(socket, message, info);

    const { result, reason } = await this.enforce(ctx, [
      validPayload(validateSpaceHashListPayload),
      notRelayed,
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    const peerTopicList = message.payload;
    this.socketManager.addSocket(socket, message.publicKey, peerTopicList);

    const spaces = await this.spaceResolver.resolveMany(peerTopicList);
    const { publicKey, secretKey } = this.credentials;

    for (const topic of peerTopicList) {
      const space = spaces.get(topic);
      if (!space) continue;
      if (!publicKeyIsAllowedToRead(ctx.senderPublicKey, space)) continue;

      const spaceSyncMessage = await createSpaceSyncMessage({
        topic,
        space: stripIds(space), // remove primary key from the space payload
        publicKey,
        secretKey,
      });

      await this.messageManager.sendMessageToSocket(spaceSyncMessage, socket);
    }

    this.emitProtocol(EVENTS.SpaceHashList, ctx, { topics: peerTopicList });
  }
}
