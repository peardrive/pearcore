import * as EVENTS from '../../constants/events.constants.js';
import * as MESSAGES from '../../constants/messages.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import { parseFilePath } from '../../utils/parsers.utils.js';
import {
  getDownloadRecord,
  queryFileRegistryRecords,
} from '../../utils/files.utils.js';
import { validateSpaceFileContentRequestPayload } from '../../utils/protocol.utils.js';
import { getSpaceByTopicHash } from '../../utils/space.utils.js';
import {
  canRead,
  notRelayed,
  subscribed,
  validPayload,
} from '../shared/guards.js';

type SpaceFileContentRequestPayload = {
  spaceFilePath: string;
  slice: [number, number];
  key: string;
};

export class SpaceFileContentRequestHandler extends BaseProtocolHandler {
  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<SpaceFileContentRequestPayload>,
    info: PeerInfo,
  ): Promise<void> {
    const ctx = this.context(socket, message, info);

    const space = await getSpaceByTopicHash(this.db, message.topic);
    if (!space) {
      await this.reject(ctx, MESSAGES.SPACE_NOT_FOUND_MESSAGE);
      return;
    }

    const { result, reason } = await this.enforce(ctx, [
      // author must be the connected peer, not a relay.
      notRelayed,
      // sender must be subscribed to the message topic.
      subscribed(this.socketManager),
      // payload must contain a valid path, slice and request key.
      validPayload(validateSpaceFileContentRequestPayload),
      // author must be allowed to read the space.
      canRead(space, 'author'),
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    const { spaceFilePath, slice, key } = message.payload;

    const parsed = parseFilePath(spaceFilePath);
    const spacePath = parsed.dir;
    const spaceFilename = parsed.filename;

    const registryRecords = await queryFileRegistryRecords(this.db, {
      spaceId: space.id,
      spacePath,
      spaceFilename,
    });

    if (registryRecords.length === 0) {
      await this.reject(ctx, MESSAGES.SPACE_FILE_NOT_FOUND);
      return;
    }

    const registry = registryRecords[0]!;
    const downloadRecord = await getDownloadRecord(this.db, registry.id);
    const maxAvailableLeafs = downloadRecord
      ? downloadRecord.lastPushedLeaf
      : registry.leafCount - 1;

    const [startLeaf, endLeaf] = slice;

    if (startLeaf < 0 || endLeaf > maxAvailableLeafs || startLeaf > endLeaf) {
      await this.reject(ctx, MESSAGES.SLICE_NOT_AVAILABLE_MESSAGE);
      return;
    }

    const taskResult = await this.spaceFileManager.createDeliveryTask({
      socket,
      key,
      publicKey: message.publicKey,
      filePath: registry.fileSourcePath,
      startLeaf,
      endLeaf,
    });

    if (!taskResult.succeed) {
      await this.reject(ctx, taskResult.reason);
    }

    this.emitProtocol(EVENTS.SpaceFileContentRequest, ctx);
  }
}
