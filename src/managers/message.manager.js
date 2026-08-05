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
    verifyMessageSignature
} from '../utils/protocol.utils.js';

const logger = createChild('MessageManager');

export class MessageManager {
    constructor(emitter, managers) {
        this.storageManager = managers.storageManager;
        this.sessionManager = managers.sessionManager;
        this.throttleManager = managers.throttleManager;
        this.socketManager = managers.socketManager;
        this.muxManager = managers.muxManager;

        this.protocolHandlers = new Map();
        this.emitter = emitter;
    }

    get messageConfig() {
        return this.sessionManager.getMessageConfig();
    }

    get credentials() {
        return this.sessionManager.getCredentials();
    }

    setProtocolMap(protocols) {
        this.protocolHandlers = new Map()
        for (const { type, handler } of protocols) {
            this.protocolHandlers.set(type, handler);
        }
    }

    /**
     * Sends a message to a socket and optionally records it for event tracking
     * @param {Object} message - The message object to send
     * @param {any} socket - The socket connection to send the message to
     */
    async sendMessageToSocket(message, socket) {
        try {
            this.throttleManager.updateByMessage(message);
            const messageStr = JSON.stringify(message);
            await this.muxManager.send(socket, messageStr, FrameTypes.JSON);
        } catch (error) {
            logger.warn('Failed to send message to socket', {
                message: message,
                error: error
            });
        }
    }

    /**
     * Send rejection message to connected socket
     * @param {Object} socket - Hyperswarm socket connection
     * @param {Object} message - The original message to reject
     * @param {String} reason - The specific reason for rejection
     * @returns {Promise<void>} Resolves when rejection message has been sent to the socket
     */
    async reject(socket, message, reason) {
        const rejection = await createRejectionForMessage({
            message: message,
            reason: reason,
            publicKey: this.credentials.publicKey,
            secretKey: this.credentials.secretKey
        });

        await this.sendMessageToSocket(rejection, socket);
    }

    async broadcastMessageToSockets(message, sockets) {
        if (sockets.length === 0) return [];
        const promises = sockets.map(socket => this.sendMessageToSocket(message, socket));
        const result = await Promise.allSettled(promises);

        return result.map((result, index) => {
            let peerInfo;

            try {
                peerInfo = this.socketManager.getPeerInfoBySocket(sockets[index]);
            } catch(error) {
                peerInfo = { publicKey: 'unkown', topics: [] };
            }

            return { 
                publicKey: peerInfo.publicKey, 
                topics: peerInfo.topics, 
                status: 
                result.status, 
                reason: result.reason
            };

        });
    }

    /**
     * Processes incoming messages with validation and routing to appropriate handlers.
     * @param {Socket} socket - Socket connection initialized by Hyperswarm
     * @param {Buffer} raw - Message context
     * @param {Object} info - Additional information from node (derived from Hyperswarm connection).
     */
    async handleIncomingMessage(socket, raw, info) {
        raw = raw.toString('utf8');

        const publicKey = hex(info.publicKey);
        logger.debug('Handling incomming message', {
            senderPublicKey: publicKey
        })

        this.throttleManager.updateByFrequency(publicKey);

        if (this.throttleManager.shouldBeThrottledByFrequency(publicKey)) {
            if (this.messageConfig.allowThrottleRejection) {
                const rejection = await createRejectionMessage({
                    reason: MESSAGES.MESSAGE_RATE_LIMIT_EXCEEDED,
                    publicKey: this.credentials.publicKey,
                    secretKey: this.credentials.secretKey
                });

                await this.sendMessageToSocket(rejection, socket);
            }

            return;
        }

        if (calculateMessageSize(raw) > this.messageConfig.rawLimitSize) {
            const rejection = await createRejectionMessage({
                reason: MESSAGES.EXCEED_SIZE_MESSAGE,
                publicKey: this.credentials.publicKey,
                secretKey: this.credentials.secretKey
            });

            await this.sendMessageToSocket(rejection, socket);
            return;
        }

        const message = parseJSON(raw);
        if (!message) {
            const rejection = await createRejectionMessage({
                reason: MESSAGES.BAD_JSON_MESSAGE,
                publicKey: this.credentials.publicKey,
                secretKey: this.credentials.secretKey
            });

            await this.sendMessageToSocket(rejection, socket);
            return;
        }

        const { isValid: messageIsValid, reason } = validateBaseMessage(message);
        if (!messageIsValid) {
            const rejection = await createRejectionMessage({
                reason: reason,
                publicKey: this.credentials.publicKey,
                secretKey: this.credentials.secretKey
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

        const handler = this.protocolHandlers.get(message.type);
        if (handler) {
            try {
                this.emitter.emit(EVENTS.General, { message, publicKey })
                await handler.handle(socket, message, info);
            }
            catch (error) {
                logger.error('Handler failed', {
                    handlerType: message.type,
                    message: message,
                    error: error
                });

                console.error(error);
                await this.reject(socket, message, MESSAGES.INTERNAL_ERROR_MESSAGE);
                return;
            }
        }
        else {
            await this.reject(socket, message, MESSAGES.NO_HANDLER_MESSAGE);
            return;
        }
    }
}