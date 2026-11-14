import * as MESSAGES from '../constants/messages.constants.js';
import * as EVENTS from '../constants/events.constants.js';
import { hex } from '../utils/crypto.utils.js';
import { BaseProtocolHandler } from './base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from './base.js';
import { getSpace, getTopicToSpaceMap } from '../utils/space.utils.js';
import type { SpaceWithWhitelists } from '../utils/space.utils.js';
import {
  publicKeyIsAllowedToBroadcast,
  publicKeyIsAllowedToRead,
  spaceShouldEncryptMessages,
} from '../utils/policy.utils.js';
import { validateHexString } from '../utils/general.utils.js';
import {
  decryptPayload,
  validateNegentropySyncPayload,
  validateNegentropyContentRequestPayload,
  validateNegentropyContentCancelPayload,
  validateNegentropyContentDeliveryPayload,
} from '../utils/protocol.utils.js';
import type { ProtocolValidationResult } from '../utils/protocol.utils.js';

type ProtocolMessageInput = ProtocolMessage<any>;

interface NegentropySpaceContext {
  spaceId: number;
  space: SpaceWithWhitelists;
}

export class SpaceMessageHandler extends BaseProtocolHandler {
  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessageInput,
    info: PeerInfo,
  ): Promise<void> {
    // TODO check message against internal records

    const localTopicList = await getTopicToSpaceMap(this.db);
    const messageTopic = message.topic;
    const spaceId = localTopicList.get(messageTopic);

    if (!spaceId) {
      await this.messageManager.reject(
        socket,
        message,
        MESSAGES.SPACE_NOT_FOUND_MESSAGE,
      );
      return;
    }

    const senderPublicKey = hex(info.publicKey);
    const messagePublicKey = message.publicKey;
    const space = (await getSpace(this.db, spaceId))!;

    if (!publicKeyIsAllowedToRead(senderPublicKey, space)) {
      await this.messageManager.reject(
        socket,
        message,
        MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE,
      );
      return;
    }

    if (!publicKeyIsAllowedToBroadcast(messagePublicKey, space)) {
      await this.messageManager.reject(
        socket,
        message,
        MESSAGES.BROADCAST_PERMISSION_NOT_ALLOWED_MESSAGE,
      );
      return;
    }

    const shouldDecryptCipher =
      spaceShouldEncryptMessages(space) &&
      typeof message.payload == 'string' &&
      validateHexString(message.payload);

    if (shouldDecryptCipher) {
      const decryptedPayload = await decryptPayload({
        payload: message.payload,
        spaceSecret: space.secret!,
        nonce: message.nonce,
      });

      this.emit(EVENTS.SpaceMessage, {
        info,
        message,
        content: decryptedPayload,
      });
    } else {
      this.emit(EVENTS.SpaceMessage, {
        info,
        message,
        content: message.payload,
      });
    }

    const peers = this.socketManager.getPeerKeys((publicKey) => {
      return (
        publicKeyIsAllowedToRead(publicKey, space) &&
        publicKey !== senderPublicKey &&
        publicKey !== messagePublicKey
      );
    });
    const sockets = this.socketManager.getConnectedSockets({
      peers: peers,
      topics: [messageTopic],
    });
    await this.messageManager.broadcastMessageToSockets(message, sockets);
  }
}

/**
 * Handles one round of message-history reconciliation (Negentropy) for a space.
 * The peer only gets an answer once it is allowed to read the space.
 */
export class NegentropySyncHandler extends BaseProtocolHandler {
  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessageInput,
    info: PeerInfo,
  ): Promise<void> {
    const senderPublicKey = hex(info.publicKey);

    if (message.publicKey !== senderPublicKey) {
      await this.messageManager.reject(
        socket,
        message,
        MESSAGES.NO_RELAY_MESSAGE,
      );
      return;
    }

    const { maxRanges, maxIdListSize } =
      this.sessionManager.getMessageConfig().reconciliation;
    const { isValid, reason } = validateNegentropySyncPayload(message, {
      maxRanges,
      maxIdListSize,
    });
    if (!isValid) {
      await this.messageManager.reject(socket, message, reason);
      return;
    }

    const topicMap = await getTopicToSpaceMap(this.db);
    const spaceId = topicMap.get(message.topic);

    if (!spaceId) {
      await this.messageManager.reject(
        socket,
        message,
        MESSAGES.SPACE_NOT_FOUND_MESSAGE,
      );
      return;
    }

    const space = (await getSpace(this.db, spaceId))!;
    if (!publicKeyIsAllowedToRead(senderPublicKey, space)) {
      await this.messageManager.reject(
        socket,
        message,
        MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE,
      );
      return;
    }

    this.emit(EVENTS.NegentropySync, { info, message });
    await this.syncManager!.handleMessage(socket, message, spaceId);
  }
}

/**
 * Shared checks of the message-sync handlers: no relaying, a valid payload, a known space
 * and a sender allowed to read it. Subclasses implement `validatePayload` and `process`.
 */
class NegentropyContentHandler extends BaseProtocolHandler {
  get limits() {
    const { maxIdListSize } =
      this.sessionManager.getMessageConfig().reconciliation;
    return { maxIds: maxIdListSize };
  }

  /**
   * @param message - The protocol message to validate.
   * @returns The payload validation result.
   */
  validatePayload(message: ProtocolMessageInput): ProtocolValidationResult {
    throw new Error('validatePayload method must be implemented by subclass');
  }

  /**
   * @param socket - The peer socket.
   * @param message - The protocol message to process.
   * @param info - Details about the sending peer.
   * @param context - The resolved space for the message topic.
   */
  async process(
    socket: ProtocolSocket,
    message: ProtocolMessageInput,
    info: PeerInfo,
    context: NegentropySpaceContext,
  ): Promise<void> {
    throw new Error('process method must be implemented by subclass');
  }

  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessageInput,
    info: PeerInfo,
  ): Promise<void> {
    const senderPublicKey = hex(info.publicKey);

    if (message.publicKey !== senderPublicKey) {
      await this.messageManager.reject(
        socket,
        message,
        MESSAGES.NO_RELAY_MESSAGE,
      );
      return;
    }

    const { isValid, reason } = this.validatePayload(message);
    if (!isValid) {
      await this.messageManager.reject(socket, message, reason);
      return;
    }

    const topicMap = await getTopicToSpaceMap(this.db);
    const spaceId = topicMap.get(message.topic);

    if (!spaceId) {
      await this.messageManager.reject(
        socket,
        message,
        MESSAGES.SPACE_NOT_FOUND_MESSAGE,
      );
      return;
    }

    const space = (await getSpace(this.db, spaceId))!;
    if (!publicKeyIsAllowedToRead(senderPublicKey, space)) {
      await this.messageManager.reject(
        socket,
        message,
        MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE,
      );
      return;
    }

    await this.process(socket, message, info, { spaceId, space });
  }
}

/**
 * Provider side: a peer requests the contents of messages it is missing.
 * The delivery runs in the background; it is not awaited.
 */
export class NegentropyContentRequestHandler extends NegentropyContentHandler {
  override validatePayload(
    message: ProtocolMessageInput,
  ): ProtocolValidationResult {
    return validateNegentropyContentRequestPayload(message, this.limits);
  }

  override async process(
    socket: ProtocolSocket,
    message: ProtocolMessageInput,
    info: PeerInfo,
    { spaceId }: NegentropySpaceContext,
  ): Promise<void> {
    this.emit(EVENTS.NegentropyContentRequest, { info, message });
    this.syncManager!.serveContentRequest(socket, message, spaceId);
  }
}

/**
 * Both sides: cancellation of an assignment (requester gave it up, or provider cannot deliver).
 */
export class NegentropyContentCancelHandler extends NegentropyContentHandler {
  override validatePayload(
    message: ProtocolMessageInput,
  ): ProtocolValidationResult {
    return validateNegentropyContentCancelPayload(message, this.limits);
  }

  override async process(
    socket: ProtocolSocket,
    message: ProtocolMessageInput,
    info: PeerInfo,
  ): Promise<void> {
    const { role, messageIds } = this.syncManager!.handleContentCancel(message);
    this.emit(EVENTS.NegentropyContentCancel, {
      info,
      message,
      role,
      messageIds,
    });
  }
}

/**
 * Requester side: messages delivered for one of our assignments.
 */
export class NegentropyContentDeliveryHandler extends NegentropyContentHandler {
  override validatePayload(
    message: ProtocolMessageInput,
  ): ProtocolValidationResult {
    return validateNegentropyContentDeliveryPayload(message);
  }

  override async process(
    socket: ProtocolSocket,
    message: ProtocolMessageInput,
    info: PeerInfo,
    { spaceId, space }: NegentropySpaceContext,
  ): Promise<void> {
    const { messageId, status } = await this.syncManager!.acceptContentDelivery(
      message,
      spaceId,
      space,
    );
    this.emit(EVENTS.NegentropyContentDelivery, {
      info,
      message,
      messageId,
      status,
    });
  }
}
