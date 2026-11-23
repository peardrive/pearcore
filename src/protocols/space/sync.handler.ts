import * as MESSAGES from '../../constants/messages.constants.js';
import * as EVENTS from '../../constants/events.constants.js';
import {
  SPACE_SYNC_STATES,
  type SpaceSyncAction,
} from '../../constants/space.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import {
  getSpaceTopicHash,
  querySpace,
  upsertSpace,
  verifySpaceSignature,
} from '../../utils/space.utils.js';
import type {
  SignedSpace,
  SpacePayload,
  SpaceWithWhitelists,
} from '../../utils/space.utils.js';
import {
  isTimestampEqual,
  isTimestampNewer,
  stripIds,
} from '../../utils/general.utils.js';
import { publicKeyIsAllowedToRead } from '../../utils/policy.utils.js';
import {
  createSpaceFileEventMessage,
  createSpaceSyncMessage,
  validateSpaceSyncMessagePayload,
} from '../../utils/protocol.utils.js';
import {
  deleteShareLink,
  queryShareLink,
} from '../../utils/sharelink.utils.js';
import type { ProtocolContext } from '../shared/context.js';
import { canRead, validPayload, verified } from '../shared/guards.js';

type TimestampedSpace = Pick<SpacePayload, 'timestamp'>;

export class SpaceSyncHandler extends BaseProtocolHandler {
  static readonly STATES = SPACE_SYNC_STATES;

  action(
    localSpace: TimestampedSpace,
    peerSpace: TimestampedSpace,
  ): SpaceSyncAction {
    if (isTimestampEqual(localSpace.timestamp, peerSpace.timestamp)) {
      return SpaceSyncHandler.STATES.IDENTICAL;
    } else if (isTimestampNewer(localSpace.timestamp, peerSpace.timestamp)) {
      return SpaceSyncHandler.STATES.PEER_REQUIRE_UPDATE;
    } else {
      return SpaceSyncHandler.STATES.LOCAL_SPACE_REQUIRE_UPDATE;
    }
  }

  async broadcastSpaceSyncMessage(ctx: ProtocolContext): Promise<void> {
    const { message } = ctx;

    await this.forward(ctx, message, {
      topic: getSpaceTopicHash(message.payload),
      space: message.payload,
      exclude: [message.payload.publicKey],
    });
  }

  async sendSpaceFileListContextToSocket(
    socket: ProtocolSocket,
    topic: string,
  ): Promise<void> {
    const { publicKey, secretKey } = this.credentials;
    const fileList = this.spaceFileListManager.get(topic);
    const fileStack = this.spaceFileListManager.convertListToStack(fileList);

    const message = await createSpaceFileEventMessage({
      topic,
      events: [
        {
          action: EVENTS.SpaceFileEventOptions.ADD,
          files: fileStack,
        },
      ],
      publicKey,
      secretKey,
    });

    await this.messageManager.sendMessageToSocket(message, socket);
  }

  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<SignedSpace>,
    info: PeerInfo,
  ): Promise<void> {
    const ctx = this.context(socket, message, info);

    let spaceTopicHash = '';
    const subscribed = (): string | null => {
      spaceTopicHash = getSpaceTopicHash(message.payload);
      const peerInfo = this.socketManager.getPeerInfoBySocket(socket);

      return peerInfo.topics.includes(spaceTopicHash)
        ? null
        : MESSAGES.NOT_SUBSCRIBED_MESSAGE;
    };

    const { result, reason } = await this.enforce(ctx, [
      validPayload(validateSpaceSyncMessagePayload),
      verified(
        (context) => verifySpaceSignature(context.message.payload),
        MESSAGES.BAD_SPACE_SIGNATURE,
      ),
      subscribed,
      canRead(message.payload, 'author'),
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    const sharelinkQuery = await queryShareLink(this.db, {}); // list all records
    const spaceQuery = await querySpace(this.db, {
      spaceName: message.payload.spaceName,
      publicKey: message.payload.publicKey,
      nonce: message.payload.nonce,
    }); // query all records based on topic parameters

    const messageIsDirect = message.publicKey === ctx.senderPublicKey;
    const isEmpty = (arr: readonly unknown[]): boolean => arr.length === 0;

    if (!isEmpty(sharelinkQuery)) {
      if (isEmpty(spaceQuery)) {
        // first encouter with space sync - create new space record
        await upsertSpace(this.db, message.payload);

        for (const sharelink of sharelinkQuery) {
          await deleteShareLink(this.db, sharelink.id);
        }

        // broadcast to other nodes - they might also look for first encounter
        this.emitProtocol(EVENTS.SpaceSync, ctx, {
          action: SPACE_SYNC_STATES.FIRST_ENCOUNTER,
        });

        await this.broadcastSpaceSyncMessage(ctx);

        if (messageIsDirect) {
          await this.sendSpaceFileListContextToSocket(socket, spaceTopicHash);
        }

        return;
      } else {
        // there is already space record for this message - just delete the sharelink and continue
        for (const sharelink of sharelinkQuery) {
          await deleteShareLink(this.db, sharelink.id);
        }
      }
    } else {
      if (isEmpty(spaceQuery)) {
        // no record of sharelink or space, the message does not relates to this node
        await this.messageManager.reject(
          socket,
          message,
          MESSAGES.SPACE_NOT_FOUND_MESSAGE,
        );
        return;
      }
    }

    const spaceData: SpaceWithWhitelists = spaceQuery[0]!;
    const action = this.action(spaceData, message.payload);

    switch (action) {
      case SPACE_SYNC_STATES.LOCAL_SPACE_REQUIRE_UPDATE: {
        await upsertSpace(this.db, message.payload);
        this.emitProtocol(EVENTS.SpaceSync, ctx, {
          action: SPACE_SYNC_STATES.LOCAL_SPACE_REQUIRE_UPDATE,
        });

        await this.broadcastSpaceSyncMessage(ctx);

        if (messageIsDirect) {
          await this.sendSpaceFileListContextToSocket(socket, spaceTopicHash);
        }

        return;
      }

      case SPACE_SYNC_STATES.PEER_REQUIRE_UPDATE: {
        if (publicKeyIsAllowedToRead(message.publicKey, spaceData)) {
          const responseMessage = await createSpaceSyncMessage({
            topic: message.topic,
            space: spaceData,
            publicKey: this.credentials.publicKey,
            secretKey: this.credentials.secretKey,
          });

          this.emitProtocol(EVENTS.SpaceSync, ctx, {
            action: SPACE_SYNC_STATES.PEER_REQUIRE_UPDATE,
          });
          await this.messageManager.sendMessageToSocket(
            responseMessage,
            socket,
          );

          if (messageIsDirect) {
            await this.sendSpaceFileListContextToSocket(socket, spaceTopicHash);
          }

          return;
        } else {
          await this.messageManager.reject(
            socket,
            message,
            MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE,
          );
          return;
        }
      }

      case SPACE_SYNC_STATES.IDENTICAL: {
        this.emitProtocol(EVENTS.SpaceSync, ctx, {
          action: SPACE_SYNC_STATES.IDENTICAL,
        });

        if (messageIsDirect) {
          await this.sendSpaceFileListContextToSocket(socket, spaceTopicHash);
        }

        return;
      }
    }
  }
}
