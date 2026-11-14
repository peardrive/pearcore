import { EventEmitter } from 'node:events';
import { createChild } from '../logger.js';
import * as EVENTS from '../constants/events.constants.js';
import * as MESSAGES from '../constants/messages.constants.js';
import { calculateMessageSize } from '../utils/general.utils.js';
import { hex } from '../utils/crypto.utils.js';
import { parseJSON } from '../utils/parsers.utils.js';
import { FrameTypes } from './multiplexer.manager.js';
import {
  createRejectionForMessage,
  createRejectionMessage,
  validateBaseMessage,
  verifyMessageSignature,
} from '../utils/protocol.utils.js';
import { pushMessageToHistory } from '../utils/message.utils.js';

const logger: any = createChild('MessageManager');

export class MessageManager {
  [key: string]: any;

  constructor(emitter: any, managers: any) {
    this.sessionManager = managers.sessionManager;
    this.throttleManager = managers.throttleManager;
    this.socketManager = managers.socketManager;
    this.muxManager = managers.muxManager;

    this.protocolHandlers = new Map();
    this.emitter = emitter;
  }

  get db() {
    return this.sessionManager.getDatabase().db;
  }

  get messageConfig() {
    return this.sessionManager.getMessageConfig();
  }

  get credentials() {
    return this.sessionManager.getCredentials();
  }

  setProtocolMap(protocols: any[]) {
    this.protocolHandlers = new Map();
    for (const { type, handler } of protocols) {
      this.protocolHandlers.set(type, handler);
    }
  }

  /**
   * Sends a message to a socket and optionally records it for event tracking
   * @param message - The message object to send
   * @param socket - The socket connection to send the message to
   */
  async sendMessageToSocket(message: any, socket: any) {
    try {
      // update the throttler to avoid duplicates in the future
      this.throttleManager.updateByMessage(message);

      if (this.messageConfig.recordMessagesForEvents.includes(message.type)) {
        const { publicKey } = this.credentials;
        const spaceId = message.payload?.spaceId;
        if (typeof spaceId === 'number') {
          await pushMessageToHistory(this.db, {
            spaceId,
            message,
            senderPublicKey: publicKey,
          });
        }
      }

      const messageStr = JSON.stringify(message);
      await this.muxManager.send(socket, messageStr, FrameTypes.JSON);
    } catch (error) {
      logger.warn('Failed to send message to socket', {
        message: message,
        error: error,
      });
    }
  }

  /**
   * Send rejection message to connected socket
   * @param socket - Hyperswarm socket connection
   * @param message - The original message to reject
   * @param reason - The specific reason for rejection
   * @returns Resolves when rejection message has been sent to the socket
   */
  async reject(socket: any, message: any, reason: string) {
    const rejection = await createRejectionForMessage({
      message: message,
      reason: reason,
      publicKey: this.credentials.publicKey,
      secretKey: this.credentials.secretKey,
    });

    await this.sendMessageToSocket(rejection, socket);
  }

  async broadcastMessageToSockets(message: any, sockets: any[]) {
    if (sockets.length === 0) return [];
    const promises = sockets.map((socket) =>
      this.sendMessageToSocket(message, socket),
    );
    const result = await Promise.allSettled(promises);

    return result.map((result, index) => {
      let peerInfo;

      try {
        peerInfo = this.socketManager.getPeerInfoBySocket(sockets[index]);
      } catch (error) {
        peerInfo = { publicKey: 'unkown', topics: [] };
      }

      return {
        publicKey: peerInfo.publicKey,
        topics: peerInfo.topics,
        status: result.status,
        reason: 'reason' in result ? result.reason : undefined,
      };
    });
  }

  /**
   * Processes incoming messages with validation and routing to appropriate handlers.
   * @param socket - Socket connection initialized by Hyperswarm
   * @param raw - Message context
   * @param info - Additional information from node (derived from Hyperswarm connection).
   */
  async handleIncomingMessage(socket: any, raw: any, info: any) {
    raw = raw.toString('utf8');

    const publicKey = hex(info.publicKey);
    logger.debug('Handling incomming message', {
      senderPublicKey: publicKey,
    });

    this.throttleManager.updateByFrequency(publicKey);

    if (this.throttleManager.shouldBeThrottledByFrequency(publicKey)) {
      if (this.messageConfig.allowThrottleRejection) {
        const rejection = await createRejectionMessage({
          reason: MESSAGES.MESSAGE_RATE_LIMIT_EXCEEDED,
          publicKey: this.credentials.publicKey,
          secretKey: this.credentials.secretKey,
        });

        await this.sendMessageToSocket(rejection, socket);
      }

      return;
    }

    if (calculateMessageSize(raw) > this.messageConfig.rawLimitSize) {
      const rejection = await createRejectionMessage({
        reason: MESSAGES.EXCEED_SIZE_MESSAGE,
        publicKey: this.credentials.publicKey,
        secretKey: this.credentials.secretKey,
      });

      await this.sendMessageToSocket(rejection, socket);
      return;
    }

    const message = parseJSON(raw) as any;
    if (!message) {
      const rejection = await createRejectionMessage({
        reason: MESSAGES.BAD_JSON_MESSAGE,
        publicKey: this.credentials.publicKey,
        secretKey: this.credentials.secretKey,
      });

      await this.sendMessageToSocket(rejection, socket);
      return;
    }

    const { isValid: messageIsValid, reason } = validateBaseMessage(message);
    if (!messageIsValid) {
      const rejection = await createRejectionMessage({
        reason: reason,
        publicKey: this.credentials.publicKey,
        secretKey: this.credentials.secretKey,
      });

      await this.sendMessageToSocket(rejection, socket);
      return;
    }

    const signatureIsValid = await verifyMessageSignature(message);
    if (!signatureIsValid) {
      await this.reject(socket, message, MESSAGES.BAD_SIGNATURE_MESSAGE);
      return;
    }

    if (this.throttleManager.messageIsDuplicated(message)) {
      if (this.messageConfig.allowThrottleRejection) {
        await this.reject(socket, message, MESSAGES.MESSAGE_IS_DUPLICATED);
      }

      return;
    }

    this.throttleManager.updateByMessage(message);

    if (this.messageConfig.recordMessagesForEvents.includes(message.type)) {
      const { publicKey } = this.credentials;
      const spaceId = message.payload?.spaceId;
      if (typeof spaceId === 'number') {
        await pushMessageToHistory(this.db, {
          spaceId,
          message,
          senderPublicKey: publicKey,
        });
      }
    }

    const handler = this.protocolHandlers.get(message.type);
    if (handler) {
      try {
        this.emitter.emit(EVENTS.General, { message, publicKey });
        await handler.handle(socket, message, info);
      } catch (error) {
        logger.error('Handler failed', {
          handlerType: message.type,
          message: message,
          error: error,
        });

        console.error(error);
        await this.reject(socket, message, MESSAGES.INTERNAL_ERROR_MESSAGE);
        return;
      }
    } else {
      await this.reject(socket, message, MESSAGES.NO_HANDLER_MESSAGE);
      return;
    }
  }
}
