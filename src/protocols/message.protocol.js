import * as MESSAGES from '../constants/messages.constants.js';
import * as EVENTS from '../constants/events.constants.js';
import { hex } from '../utils/crypto.utils.js';
import { BaseProtocolHandler } from "./base.js";
import { getSpace, getTopicToSpaceMap } from '../utils/space.utils.js';
import { publicKeyIsAllowedToBroadcast, publicKeyIsAllowedToRead, spaceShouldEncryptMessages } from '../utils/policy.utils.js';
import { validateHexString } from '../utils/general.utils.js';
import { decryptPayload, validateNegentropySyncPayload } from "../utils/protocol.utils.js";


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
        await this.negentropyManager.handleMessage(socket, message, spaceId);
    }
}
