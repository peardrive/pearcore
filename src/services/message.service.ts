import * as EVENTS from '../constants/events.constants.js';
import { isFunction } from '../utils/general.utils.js';
import { getSpaceTopicHash } from '../utils/space.utils.js';
import { createSpaceMessage, encryptPayload } from '../utils/protocol.utils.js';
import { publicKeyIsAllowedToRead } from '../utils/policy.utils.js';
import { encryptJSON, hex, randomNonce } from '../utils/crypto.utils.js';
import { SpaceInstance } from './space.service.js';
import {
  flushMessageRecords,
  queryMessageRecord,
} from '../utils/message.utils.js';

export class MessageService {
  [key: string]: any;

  constructor(emitter: any, { managers }: any) {
    this.emitter = emitter;
    this.managers = managers;

    // links: message nonce -> callback function
    this.nonceStack = new Map();
    this.emitter.on(EVENTS.Reject, (context: any) => {
      const nonce = context.linkedMessageNonce;
      const fn = this.nonceStack.get(nonce);

      if (fn) {
        try {
          fn(context);
        } catch (error) {
          console.error(error);
        } // avoid halt
      }
    });
  }

  get db() {
    return this.managers.session.getDatabase().db;
  }

  assignCallback(message: any, callback: (...args: any[]) => void) {
    this.nonceStack.set(message.nonce, callback);
  }

  /**
   * Query message records using filters.
   *
   * @param filters - query filters (all optional)
   * @param filters.id - exact ID match
   * @param filters.type - exact type match
   * @param filters.topic - exact topic match
   * @param filters.isRelay - relay status (true/false)
   * @param filters.senderPublicKey - sender's public key (exact match)
   * @param filters.broadcastTimestamp - broadcast timestamp range
   * @param filters.broadcastTimestamp.start - start timestamp (inclusive)
   * @param filters.broadcastTimestamp.end - end timestamp (inclusive)
   * @param filters.messageTimestamp - message timestamp range
   * @param filters.messageTimestamp.start - start timestamp (inclusive)
   * @param filters.messageTimestamp.end - end timestamp (inclusive)
   * @param filters.nonce - exact nonce match
   * @param filters.messageOwnerPublicKey - owner's public key (exact match)
   * @param filters.signature - exact signature match
   * @param filters.payloadContains - substring search in payload (case-insensitive)
   * @param filters.limit - maximum records to return (default: 100, max: 1000)
   * @param filters.offset - records to skip (default: 0)
   * @param filters.orderBy - field to order by: 'messageTimestamp', 'broadcastTimestamp', or 'id' (default: 'messageTimestamp')
   * @param filters.orderDirection - 'asc' for ascending, 'desc' for descending (default: 'desc')
   * @returns Array of message records
   */
  async list(filters = {}) {
    const messages = await queryMessageRecord(this.db, filters);
    return messages;
  }

  /**
   * Delete message records using filters.
   *
   * @param filters - query filters (all optional)
   * @param filters.id - exact ID match
   * @param filters.type - exact type match
   * @param filters.topic - exact topic match
   * @param filters.isRelay - relay status (true/false)
   * @param filters.senderPublicKey - sender's public key (exact match)
   * @param filters.broadcastTimestamp - broadcast timestamp range
   * @param filters.broadcastTimestamp.start - start timestamp (inclusive)
   * @param filters.broadcastTimestamp.end - end timestamp (inclusive)
   * @param filters.messageTimestamp - message timestamp range
   * @param filters.messageTimestamp.start - start timestamp (inclusive)
   * @param filters.messageTimestamp.end - end timestamp (inclusive)
   * @param filters.nonce - exact nonce match
   * @param filters.messageOwnerPublicKey - owner's public key (exact match)
   * @param filters.signature - exact signature match
   * @param filters.payloadContains - substring search in payload (case-insensitive)
   * @param filters.limit - maximum records to return (default: 100, max: 1000)
   * @param filters.offset - records to skip (default: 0)
   * @param filters.orderBy - field to order by: 'messageTimestamp', 'broadcastTimestamp', or 'id' (default: 'messageTimestamp')
   * @param filters.orderDirection - 'asc' for ascending, 'desc' for descending (default: 'desc')
   * @returns Array of deleted message records
   */
  async flush(filters = {}) {
    return await flushMessageRecords(this.db, filters);
  }

  /**
   * Send a message to a space/topic.
   *
   * @param space - The space instance for message assignment.
   * @param payload - Message content
   * @param onRejectionCallback - callback function that will be called whenever sockets sends back rejection for the mesage
   * @returns Resolves when the message has been sent to the connected nodes.
   */
  async send(
    space: SpaceInstance,
    payload: any,
    onRejectionCallback: ((...args: any[]) => void) | undefined = undefined,
  ) {
    const { publicKey, secretKey } = this.managers.session.getCredentials();

    const nonce = hex(randomNonce());
    if (space.secret) {
      payload = await encryptPayload({
        payload,
        spaceSecret: space.secret,
        nonce: nonce,
      });
    }

    const message = await createSpaceMessage({
      topic: space.topicHash,
      messagePayload: payload,
      publicKey: publicKey,
      secretKey: secretKey,
      nonce: nonce,
    });

    // limit the nodes to a subset that has the required permission to receive this message
    const peers = this.managers.sockets.getPeerKeys((key: string) =>
      publicKeyIsAllowedToRead(key, space as any),
    );
    const sockets = this.managers.sockets.getConnectedSockets({
      peers: peers,
      topics: [space.topicHash],
    });

    // assign the callback for the message
    // when core receives rejection message related to this message, it will be called.
    if (isFunction(onRejectionCallback)) {
      this.assignCallback(message, onRejectionCallback);
    }

    return await this.managers.message.broadcastMessageToSockets(
      message,
      sockets,
    );
  }
}
