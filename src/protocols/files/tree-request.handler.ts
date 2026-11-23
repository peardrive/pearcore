import * as EVENTS from '../../constants/events.constants.js';
import * as MESSAGES from '../../constants/messages.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import { parseFilePath } from '../../utils/parsers.utils.js';
import {
  getDownloadRecord,
  getFileTreeRecord,
  queryFileRegistryRecords,
} from '../../utils/files.utils.js';
import {
  createSpaceFileTreeResponseMessage,
  validateSpaceFileTreeRequestPayload,
} from '../../utils/protocol.utils.js';
import { canRead, notRelayed, validPayload } from '../shared/guards.js';

type SpaceFileTreeRequestPayload = {
  spaceFilePath: string;
  rootHash: string;
};

export class SpaceFileTreeRequestHandler extends BaseProtocolHandler {
  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<SpaceFileTreeRequestPayload>,
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
      validPayload(validateSpaceFileTreeRequestPayload),
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    const { spaceFilePath, rootHash } = message.payload;
    const parsedSpacePath = parseFilePath(spaceFilePath);

    const registryQuery = await queryFileRegistryRecords(this.db, {
      rootHash,
      spacePath: parsedSpacePath.dir,
      spaceFilename: parsedSpacePath.filename,
    });

    if (registryQuery.length === 0) {
      await this.reject(ctx, MESSAGES.SPACE_FILE_NOT_FOUND);
      return;
    }

    const registry = registryQuery[0]!;
    const tree = await getFileTreeRecord(this.db, registry.id);

    let lastRequestableLeaf = 0;

    const downloadRecord = await getDownloadRecord(this.db, registry.id);

    if (downloadRecord) {
      lastRequestableLeaf = downloadRecord.lastPushedLeaf + 1; // index + 1
    } else {
      lastRequestableLeaf = registry.leafCount;
    }

    const { publicKey, secretKey } = this.credentials;
    const response = await createSpaceFileTreeResponseMessage({
      topic: message.topic,
      tree,
      lastRequestableLeaf,
      replyNonce: message.nonce,
      publicKey,
      secretKey,
    });

    this.emitProtocol(EVENTS.SpaceFileTreeRequest, ctx);
    await this.messageManager.sendMessageToSocket(response, socket);
  }
}
