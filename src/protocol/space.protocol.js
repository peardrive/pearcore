import * as MESSAGES from '../constants/messages.constants.js';
import * as EVENTS from '../constants/events.constants.js';
import { hex } from '../utils/crypto.utils.js';
import { BaseProtocolHandler } from "./base.js";
import { getSpaceTopicHash, verifySpaceSignature } from '../utils/space.utils.js';
import { publicKeyIsAllowedToBroadcast, publicKeyIsAllowedToRead, spaceShouldEncryptMessages } from '../utils/policy.utils.js'
import { isTimestampEqual, isTimestampNewer, validateHexString } from '../utils/general.utils.js';
import { createSpaceFileEventMessage, createSpaceSyncMessage, decryptPayload, validateSpaceHashListPayload, validateSpaceSyncMessagePayload } from "../utils/protocol.utils.js";


export class SpaceHashListHandler extends BaseProtocolHandler {
    async handle(socket, message, info) {
        const senderPublicKey = hex(info.publicKey);

        const { isValid: payloadIsValid, reason } = validateSpaceHashListPayload(message);
        if (!payloadIsValid) {
            await this.messageManager.reject(socket, message, reason);
            return;
        }

        if (message.publicKey !== senderPublicKey) {
            await this.messageManager.reject(socket, message, MESSAGES.NO_RELAY_MESSAGE);
            return;
        }

        const topicList = message.payload;
        this.socketManager.addSocket(socket, message.publicKey, topicList);

        const spaceTopicList = await this.storageManager.generateSpaceTopicHashMap();
        const { publicKey, secretKey } = this.sessionManager.getCredentials();

        for (const topic of topicList) {
            const space = spaceTopicList[topic];
            if (space) {
                if (publicKeyIsAllowedToRead(senderPublicKey, space)) {
                    const spaceSyncMessage = await createSpaceSyncMessage({
                        topic: topic,
                        space: space,
                        publicKey: publicKey,
                        secretKey: secretKey
                    });

                    await this.messageManager.sendMessageToSocket(spaceSyncMessage, socket);
                }
            }
        }

        this.emit(EVENTS.SpaceHashList, { info, message, topics: topicList });
    }
}

export class SpaceSyncHandler extends BaseProtocolHandler {

    static STATES = {
        FIRST_ENCOUNTER: 'first_encounter',
        IDENTICAL: 'indentical',
        LOCAL_SPACE_REQUIRE_UPDATE: 'local_space_require_update',
        PEER_REQUIRE_UPDATE: 'peer_require_update',
    }

    action(localSpace, peerSpace) {
        if (isTimestampEqual(localSpace.timestamp, peerSpace.timestamp)) {
            return SpaceSyncHandler.STATES.IDENTICAL;
        }

        else if (isTimestampNewer(localSpace.timestamp, peerSpace.timestamp)) {
            return SpaceSyncHandler.STATES.PEER_REQUIRE_UPDATE;
        }

        else {
            return SpaceSyncHandler.STATES.LOCAL_SPACE_REQUIRE_UPDATE;
        }
    }

    async broadcastSpaceSyncMessage(message, info) {
        const spaceTopicHash = getSpaceTopicHash(message.payload);
        const senderPublicKey = hex(info.publicKey);

        const peers = this.socketManager.getPeerKeys(publicKey => {
            return publicKeyIsAllowedToRead(publicKey, message.payload) &&
                publicKey !== senderPublicKey &&
                publicKey !== message.publicKey &&
                publicKey !== message.payload.publicKey
        });
        const sockets = this.socketManager.getConnectedSockets({ peers: peers, topics: [spaceTopicHash] });

        await this.messageManager.broadcastMessageToSockets(message, sockets);
    }

    async sendSpaceFileListContextToSocket(socket, topic) {
        const { publicKey, secretKey } = this.sessionManager.getCredentials();
        const fileList = this.spaceFileListManager.get(topic);
        const fileStack = this.spaceFileListManager.convertListToStack(fileList);

        const message = await createSpaceFileEventMessage({
            topic: topic,
            events: [
                {
                    action: EVENTS.SpaceFileEventOptions.ADD,
                    files: fileStack
                }
            ],
            publicKey: publicKey,
            secretKey: secretKey
        });

        await this.messageManager.sendMessageToSocket(message, socket);
    }

    async handle(socket, message, info) {

        const { isValid: payloadIsValid, reason } = validateSpaceSyncMessagePayload(message);
        if (!payloadIsValid) {
            await this.messageManager.reject(socket, message, reason);
            return;
        }

        const spaceSignatureIsValid = await verifySpaceSignature(message.payload);
        if (!spaceSignatureIsValid) {
            await this.messageManager.reject(socket, message, MESSAGES.BAD_SPACE_SIGNATURE);
            return;
        }

        const spaceTopicHash = getSpaceTopicHash(message.payload);

        const peerInfo = this.socketManager.getPeerInfoBySocket(socket);
        if (!peerInfo.topics.includes(spaceTopicHash)) {
            await this.messageManager.reject(socket, message, MESSAGES.NOT_SUBSCRIBED_MESSAGE);
            return;
        }

        const permissionRead = publicKeyIsAllowedToRead(message.publicKey, message.payload);
        if (!permissionRead) {
            await this.messageManager.reject(socket, message, MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE);
            return;
        }

        const sharelinkQuery = await this.storageManager.queryShareLink({});
        const spaceQuery = await this.storageManager.querySpace({
            spaceName: message.payload.spaceName,
            publicKey: message.payload.publicKey,
            nonce: message.payload.nonce,
        });

        const messageIsDirect = message.publicKey === hex(info.publicKey);
        const isEmpty = (arr) => arr.length === 0;

        if (!isEmpty(sharelinkQuery)) {
            if (isEmpty(spaceQuery)) {
                // first encouter with space sync - create new space record
                await this.storageManager.upsertSpace(message.payload);
                await this.storageManager.deleteShareLink(message.payload);

                // broadcast to other nodes - they might also look for first encounter
                this.emit(EVENTS.SpaceSync, { info, message, action: SpaceSyncHandler.STATES.FIRST_ENCOUNTER });

                await this.broadcastSpaceSyncMessage(message, info);

                if (messageIsDirect) {
                    await this.sendSpaceFileListContextToSocket(socket, spaceTopicHash);
                }

                return;
            }
            else {
                // there is already space record for this message - just delete the sharelink and continue
                await this.storageManager.deleteShareLink(message.payload);
            }
        }
        else {
            if (isEmpty(spaceQuery)) {
                // no record of sharelink or space, the message does not relates to this node
                await this.messageManager.reject(socket, message, MESSAGES.SPACE_NOT_FOUND_MESSAGE);
                return;
            }

        }

        const spaceData = spaceQuery[0];
        const action = this.action(spaceData, message.payload);

        switch (action) {
            case SpaceSyncHandler.STATES.LOCAL_SPACE_REQUIRE_UPDATE:
                await this.storageManager.upsertSpace(message.payload);
                this.emit(EVENTS.SpaceSync, { info, message, action: SpaceSyncHandler.STATES.LOCAL_SPACE_REQUIRE_UPDATE });

                await this.broadcastSpaceSyncMessage(message, info);

                if (messageIsDirect) {
                    await this.sendSpaceFileListContextToSocket(socket, spaceTopicHash);
                }

                return;

            case SpaceSyncHandler.STATES.PEER_REQUIRE_UPDATE:
                if (publicKeyIsAllowedToRead(message.publicKey, spaceData)) {
                    const responseMessage = await createSpaceSyncMessage({
                        topic: message.topic,
                        space: spaceData,
                        publicKey: this.credentials.publicKey,
                        secretKey: this.credentials.secretKey
                    });

                    this.emit(EVENTS.SpaceSync, { info, message, action: SpaceSyncHandler.STATES.PEER_REQUIRE_UPDATE });
                    await this.messageManager.sendMessageToSocket(responseMessage, socket);

                    if (messageIsDirect) {
                        await this.sendSpaceFileListContextToSocket(socket, spaceTopicHash);
                    }

                    return;
                }

                else {
                    await this.messageManager.reject(socket, message, MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE);
                    return;
                }

            case SpaceSyncHandler.STATES.IDENTICAL:
                this.emit(EVENTS.SpaceSync, { info, message, action: SpaceSyncHandler.STATES.IDENTICAL });

                if (messageIsDirect) {
                    await this.sendSpaceFileListContextToSocket(socket, spaceTopicHash);
                }

                return;
        }
    }
}

export class SpaceMessageHandler extends BaseProtocolHandler {
    async handle(socket, message, info) {
        const topicMap = await this.storageManager.generateSpaceTopicHashMap();
        const messageTopic = message.topic;
        const space = topicMap[messageTopic];

        if (!space) {
            await this.messageManager.reject(socket, message, MESSAGES.SPACE_NOT_FOUND_MESSAGE);
            return;
        }

        const senderPublicKey = hex(info.publicKey);
        const messagePublicKey = message.publicKey;

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