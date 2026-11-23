import * as EVENTS from '../../constants/events.constants.js';
import * as MESSAGES from '../../constants/messages.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import { verifyMerkleTree } from '../../utils/merkletree.utils.js';
import type { MerkleTree } from '../../utils/merkletree.utils.js';
import { validateSpaceFileTreeResponsePayload } from '../../utils/protocol.utils.js';
import { canRead, notRelayed, validPayload } from '../shared/guards.js';

type SpaceFileTreeResponsePayload = {
  tree: MerkleTree;
  lastRequestableLeaf: number;
  replyNonce: string;
};

export class SpaceFileTreeResponseHandler extends BaseProtocolHandler {
  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<SpaceFileTreeResponsePayload>,
    info: PeerInfo,
  ): Promise<void> {
    const ctx = this.context(socket, message, info);

    const space = await this.spaceResolver.resolve(message.topic);
    if (!space) {
      await this.reject(ctx, MESSAGES.SPACE_NOT_FOUND_MESSAGE);
      return;
    }

    const { result, reason } = await this.enforce(ctx, [
      notRelayed,
      canRead(space, 'author'),
      validPayload(validateSpaceFileTreeResponsePayload),
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    const verificationResult = verifyMerkleTree(message.payload.tree);

    if (!verificationResult.isValid) {
      await this.reject(ctx, verificationResult.reason);
      return;
    }

    this.emitProtocol(EVENTS.SpaceFileTreeResponse, ctx);
  }
}
