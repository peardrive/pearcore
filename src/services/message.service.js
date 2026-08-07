import * as EVENTS from '../constants/events.constants.js';
import { isFunction } from '../utils/general.utils.js';
import { getSpaceTopicHash } from "../utils/space.utils.js"
import { createSpaceMessage, encryptPayload } from '../utils/protocol.utils.js';
import { publicKeyIsAllowedToRead } from '../utils/policy.utils.js';
import { encryptJSON, hex, randomNonce } from '../utils/crypto.utils.js';

export class MessageService {
    constructor(emitter, { managers }) {
        this.emitter = emitter;
        this.managers = managers;

        // links: message nonce -> callback function
        this.nonceStack = new Map();
        this.emitter.on(EVENTS.Reject, (context) => {
            const nonce = context.linkedMessageNonce;
            const fn = this.nonceStack.get(nonce);

            if (fn) {
                try { fn(context); }
                catch(error) { console.error(error); } // avoid halt
            }
        })
    }

    assignCallback(message, callback) {
        this.nonceStack.set(message.nonce, callback);
    }

    /**
     * Query message records using filters.
     *
     * @param {Object} filters - query filters (all optional)
     * @param {number} filters.id - exact ID match
     * @param {string} filters.type - exact type match
     * @param {string} filters.topic - exact topic match
     * @param {boolean} filters.isRelay - relay status (true/false)
     * @param {string} filters.senderPublicKey - sender's public key (exact match)
     * @param {Object} filters.broadcastTimestamp - broadcast timestamp range
     * @param {number} filters.broadcastTimestamp.start - start timestamp (inclusive)
     * @param {number} filters.broadcastTimestamp.end - end timestamp (inclusive)
     * @param {Object} filters.messageTimestamp - message timestamp range
     * @param {number} filters.messageTimestamp.start - start timestamp (inclusive)
     * @param {number} filters.messageTimestamp.end - end timestamp (inclusive)
     * @param {string} filters.nonce - exact nonce match
     * @param {string} filters.messageOwnerPublicKey - owner's public key (exact match)
     * @param {string} filters.signature - exact signature match
     * @param {string} filters.payloadContains - substring search in payload (case-insensitive)
     * @param {number} filters.limit - maximum records to return (default: 100, max: 1000)
     * @param {number} filters.offset - records to skip (default: 0)
     * @param {string} filters.orderBy - field to order by: 'messageTimestamp', 'broadcastTimestamp', or 'id' (default: 'messageTimestamp')
     * @param {string} filters.orderDirection - 'asc' for ascending, 'desc' for descending (default: 'desc')
     * @returns {Promise<Array<Object>>} Array of message records
     */
    async list(filters = {}) {
        const messages = await this.managers.storage.queryMessages(filters);
        return messages;
    }

    /**
     * Delete message records using filters.
     *
     * @param {Object} filters - query filters (all optional)
     * @param {number} filters.id - exact ID match
     * @param {string} filters.type - exact type match
     * @param {string} filters.topic - exact topic match
     * @param {boolean} filters.isRelay - relay status (true/false)
     * @param {string} filters.senderPublicKey - sender's public key (exact match)
     * @param {Object} filters.broadcastTimestamp - broadcast timestamp range
     * @param {number} filters.broadcastTimestamp.start - start timestamp (inclusive)
     * @param {number} filters.broadcastTimestamp.end - end timestamp (inclusive)
     * @param {Object} filters.messageTimestamp - message timestamp range
     * @param {number} filters.messageTimestamp.start - start timestamp (inclusive)
     * @param {number} filters.messageTimestamp.end - end timestamp (inclusive)
     * @param {string} filters.nonce - exact nonce match
     * @param {string} filters.messageOwnerPublicKey - owner's public key (exact match)
     * @param {string} filters.signature - exact signature match
     * @param {string} filters.payloadContains - substring search in payload (case-insensitive)
     * @param {number} filters.limit - maximum records to return (default: 100, max: 1000)
     * @param {number} filters.offset - records to skip (default: 0)
     * @param {string} filters.orderBy - field to order by: 'messageTimestamp', 'broadcastTimestamp', or 'id' (default: 'messageTimestamp')
     * @param {string} filters.orderDirection - 'asc' for ascending, 'desc' for descending (default: 'desc')
     * @returns {Promise<Array<Object>>} Array of deleted message records
     */
    async flush(filters = {}) {
        return await this.managers.storage.flushMessages(filters);
    }

    /**
     * Send a message to a space/topic.
     * 
     * @param {Object} space - The space object to send the message into
     * @param {string} space.spaceName - spaceName property of space is required.
     * @param {string} space.publicKey - publicKey property of space is required.
     * @param {string} space.nonce - nonce property of space is required.
     * @param {Object} payload - Message content
     * @param {CallableFunction} onRejectionCallback - callback function that will be called whenever sockets sends back rejection for the mesage
     * @returns {Promise<void>} Resolves when the message has been sent to the connected nodes.
     */
    async send(space, payload, onRejectionCallback = undefined) {
        const spaceQuery = await this.managers.storage.querySpace(space);
        if (spaceQuery.length === 0) throw new Error('space not found');

        const spaceRecord = spaceQuery[0];
        const topic = getSpaceTopicHash(spaceRecord);

        const { publicKey, secretKey } = this.managers.session.getCredentials();

        const nonce = hex(randomNonce());
        if (spaceRecord.secret) {
            payload = await encryptPayload({ payload, spaceSecret: spaceRecord.secret, nonce: nonce });
        }

        const message = await createSpaceMessage({
            topic: topic,
            messagePayload: payload,
            publicKey: publicKey,
            secretKey: secretKey,
            nonce: nonce
        });

        // limit the nodes to a subset that has the required permission to receive this message
        const peers = this.managers.sockets.getPeerKeys(key => publicKeyIsAllowedToRead(key, spaceRecord));
        const sockets = this.managers.sockets.getConnectedSockets({
            peers: peers, topics: [topic]
        });

        // assign the callback for the message
        // when core receives rejection message related to this message, it will be called.
        if (isFunction(onRejectionCallback)) {
            this.assignCallback(message, onRejectionCallback);
        }

        return await this.managers.message.broadcastMessageToSockets(message, sockets);
    }
}