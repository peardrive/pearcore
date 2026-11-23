import * as EVENTS from '../../constants/events.constants.js';
import * as MESSAGES from '../../constants/messages.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import { publicKeyIsAllowedToBroadcast } from '../../utils/policy.utils.js';
import type { SpaceWithWhitelists } from '../../utils/space.utils.js';
import {
  createSpaceFileEventMessage,
  validateSpaceFileEventPayload,
  verifySpaceFileRecordSignature,
} from '../../utils/protocol.utils.js';
import { canBroadcast, canRead, validPayload } from '../shared/guards.js';

type SpaceFileRecordTuple = [
  path: string,
  publicKey: string,
  timestamp: number,
  rootHash: string,
  signature: string,
];

type SpaceFileEventPayload = Array<{
  action: string;
  files: SpaceFileRecordTuple[];
}>;

export class SpaceFileEventHandler extends BaseProtocolHandler {
  /**
   * Filter file records by the signatrue and permission.
   * @param space - The space record.
   * @param topic - Space topic hash.
   * @param recordStack - File list stack.
   * @returns The records with valid signatures and permissions.
   */
  async filterVerifiedRecords(
    space: SpaceWithWhitelists,
    topic: string,
    recordStack: SpaceFileRecordTuple[],
  ): Promise<SpaceFileRecordTuple[]> {
    const verifiedRecords: SpaceFileRecordTuple[] = [];

    for (const record of recordStack) {
      const [path, publicKey, timestamp, rootHash, signature] = record;

      // ensure records are authorized
      if (!publicKeyIsAllowedToBroadcast(publicKey, space)) continue;

      const result = await verifySpaceFileRecordSignature({
        topic,
        path,
        publicKey,
        timestamp,
        rootHash,
        signature,
      });

      if (result) {
        verifiedRecords.push(record);
      }
    }

    return verifiedRecords;
  }

  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<SpaceFileEventPayload>,
    info: PeerInfo,
  ): Promise<void> {
    const ctx = this.context(socket, message, info);

    const space = await this.spaceResolver.resolve(message.topic);
    if (!space) {
      await this.reject(ctx, MESSAGES.SPACE_NOT_FOUND_MESSAGE);
      return;
    }

    const { result, reason } = await this.enforce(ctx, [
      canBroadcast(space, 'author'),
      canRead(space, 'sender'),
      validPayload(validateSpaceFileEventPayload),
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    const eventStack: SpaceFileEventPayload = [];

    for (const event of message.payload) {
      const { action, files } = event;
      const records = await this.filterVerifiedRecords(
        space,
        message.topic,
        files,
      );
      const fileList = this.spaceFileListManager.convertStackToList(records);

      const diff = this.spaceFileListManager.diff({
        topic: message.topic,
        fileList: fileList,
        mode: action,
      });

      if (Object.keys(diff).length === 0) continue;

      switch (action) {
        case EVENTS.SpaceFileEventOptions.ADD: {
          this.spaceFileListManager.merge({
            topic: message.topic,
            fileList: diff,
          });

          const broadcastStack =
            this.spaceFileListManager.convertListToStack(diff);
          eventStack.push({ action, files: broadcastStack });

          break;
        }

        case EVENTS.SpaceFileEventOptions.REMOVE: {
          const removeStack = this.spaceFileListManager.convertListToStack(
            diff,
          ) as SpaceFileRecordTuple[];

          removeStack.forEach((record) => {
            const [filepath, publicKey] = record;

            this.spaceFileListManager.remove({
              topic: message.topic,
              publicKey: publicKey,
              path: filepath,
            });
          });

          if (removeStack.length > 0) {
            eventStack.push({ action, files: removeStack });
          }

          break;
        }

        default:
          await this.reject(ctx, MESSAGES.INVALID_FILE_EVENT_ACTION_MESSAGE);
          return;
      }
    }

    this.emitProtocol(EVENTS.SpaceFileEvent, ctx);

    if (eventStack.length === 0) return;

    const broadcastMessage = await createSpaceFileEventMessage({
      topic: message.topic,
      events: eventStack,
      ...this.credentials,
    });

    await this.forward(ctx, broadcastMessage, {
      topic: message.topic,
      space,
    });
  }
}
