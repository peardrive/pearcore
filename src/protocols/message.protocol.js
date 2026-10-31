import * as MESSAGES from '../constants/messages.constants.js';
import * as EVENTS from '../constants/events.constants.js';
import { hex } from '../utils/crypto.utils.js';
import { BaseProtocolHandler } from "./base.js";
import { getSpace, getTopicToSpaceMap } from '../utils/space.utils.js';
import { publicKeyIsAllowedToBroadcast, publicKeyIsAllowedToRead, spaceShouldEncryptMessages } from '../utils/policy.utils.js';
import { validateHexString } from '../utils/general.utils.js';
import {
    decryptPayload,
    validateNegentropySyncPayload,
    validateNegentropyContentRequestPayload,
    validateNegentropyContentCancelPayload,
    validateNegentropyContentDeliveryPayload
} from "../utils/protocol.utils.js";


export class SpaceMessageHandler extends BaseProtocolHandler {
    async handle(socket, message, info) {
        // TODO check message against internal records

        const localTopicList = await getTopicToSpaceMap(this.db);
        const messageTopic = message.topic;
        const spaceId = localTopicList.get(messageTopic);

        if (!spaceId) {
            await this.messageManager.reject(socket, message, MESSAGES.SPACE_NOT_FOUND_MESSAGE);
            return;
        }

        const senderPublicKey = hex(info.publicKey);
        const messagePublicKey = message.publicKey;
        const space = await getSpace(this.db, spaceId);

        if (!publicKeyIsAllowedToRead(senderPublicKey, space)) {
            await this.messageManager.reject(socket, message, MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE);
            return;
        }

        if (!publicKeyIsAllowedToBroadcast(messagePublicKey, space)) {
            await this.messageManager.reject(socket, message, MESSAGES.BROADCAST_PERMISSION_NOT_ALLOWED_MESSAGE);
            return;
        }

        const shouldDecryptCipher = spaceShouldEncryptMessages(space) &&
            typeof message.payload == 'string' &&
            validateHexString(message.payload);

        if (shouldDecryptCipher) {
            const decryptedPayload = await decryptPayload({
                payload: message.payload,
                spaceSecret: space.secret,
                nonce: message.nonce
            });

            this.emit(EVENTS.SpaceMessage, { info, message, content: decryptedPayload });
        }
        else {
            this.emit(EVENTS.SpaceMessage, { info, message, content: message.payload });
        }

        const peers = this.socketManager.getPeerKeys(publicKey => {
            return publicKeyIsAllowedToRead(publicKey, space) &&
                publicKey !== senderPublicKey &&
                publicKey !== messagePublicKey;
        });
        const sockets = this.socketManager.getConnectedSockets({ peers: peers, topics: [messageTopic] });
        await this.messageManager.broadcastMessageToSockets(message, sockets);
    }
}

/**
 * Handles one round of message-history reconciliation (Negentropy) for a space.
 * The peer only gets an answer once it is allowed to read the space.
 */
export class NegentropySyncHandler extends BaseProtocolHandler {
    async handle(socket, message, info) {
        const senderPublicKey = hex(info.publicKey);

        if (message.publicKey !== senderPublicKey) {
            await this.messageManager.reject(socket, message, MESSAGES.NO_RELAY_MESSAGE);
            return;
        }

        const { maxRanges, maxIdListSize } = this.sessionManager.getMessageConfig().reconciliation;
        const { isValid, reason } = validateNegentropySyncPayload(message, { maxRanges, maxIdListSize });
        if (!isValid) {
            await this.messageManager.reject(socket, message, reason);
            return;
        }

        const topicMap = await getTopicToSpaceMap(this.db);
        const spaceId = topicMap.get(message.topic);

        if (!spaceId) {
            await this.messageManager.reject(socket, message, MESSAGES.SPACE_NOT_FOUND_MESSAGE);
            return;
        }

        const space = await getSpace(this.db, spaceId);
        if (!publicKeyIsAllowedToRead(senderPublicKey, space)) {
            await this.messageManager.reject(socket, message, MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE);
            return;
        }

        this.emit(EVENTS.NegentropySync, { info, message });
        await this.syncManager.handleMessage(socket, message, spaceId);
    }
}

/**
 * Shared checks of the message-sync handlers: no relaying, a valid payload, a known space
 * and a sender allowed to read it. Subclasses implement `validatePayload` and `process`.
 */
class NegentropyContentHandler extends BaseProtocolHandler {
    get limits() {
        const { maxIdListSize } = this.sessionManager.getMessageConfig().reconciliation;
        return { maxIds: maxIdListSize };
    }

    /**
     * @param {Object} message
     * @returns {{ isValid: boolean, reason: string }}
     */
    validatePayload(message) {
        throw new Error("validatePayload method must be implemented by subclass");
    }

    /**
     * @param {Object} socket
     * @param {Object} message
     * @param {Object} info
     * @param {{ spaceId: number, space: Object }} context
     */
    async process(socket, message, info, context) {
        throw new Error("process method must be implemented by subclass");
    }

    async handle(socket, message, info) {
        const senderPublicKey = hex(info.publicKey);

        if (message.publicKey !== senderPublicKey) {
            await this.messageManager.reject(socket, message, MESSAGES.NO_RELAY_MESSAGE);
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
            await this.messageManager.reject(socket, message, MESSAGES.SPACE_NOT_FOUND_MESSAGE);
            return;
        }

        const space = await getSpace(this.db, spaceId);
        if (!publicKeyIsAllowedToRead(senderPublicKey, space)) {
            await this.messageManager.reject(socket, message, MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE);
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
    validatePayload(message) {
        return validateNegentropyContentRequestPayload(message, this.limits);
    }

    async process(socket, message, info, { spaceId }) {
        this.emit(EVENTS.NegentropyContentRequest, { info, message });
        this.syncManager.serveContentRequest(socket, message, spaceId);
    }
}

/**
 * Both sides: cancellation of an assignment (requester gave it up, or provider cannot deliver).
 */
export class NegentropyContentCancelHandler extends NegentropyContentHandler {
    validatePayload(message) {
        return validateNegentropyContentCancelPayload(message, this.limits);
    }

    async process(socket, message, info) {
        const { role, messageIds } = this.syncManager.handleContentCancel(message);
        this.emit(EVENTS.NegentropyContentCancel, { info, message, role, messageIds });
    }
}

/**
 * Requester side: messages delivered for one of our assignments.
 */
export class NegentropyContentDeliveryHandler extends NegentropyContentHandler {
    validatePayload(message) {
        return validateNegentropyContentDeliveryPayload(message);
    }

    async process(socket, message, info, { spaceId, space }) {
        const { messageId, status } = await this.syncManager.acceptContentDelivery(message, spaceId, space);
        this.emit(EVENTS.NegentropyContentDelivery, { info, message, messageId, status });
    }
}
