import { createChild } from "../../../logger.js";
import { filterStoredMessageIds, getMessageRecordById } from "../../../utils/message.utils.js";
import {
    createNegentropyContentCancelMessage,
    createNegentropyContentDeliveryMessage,
    toDeliverableMessage
} from "../../../utils/protocol.utils.js";

const logger = createChild('MessageDeliveryTasks');

/**
 * Serves the message contents peers request (provider side of the message sync).
 *
 * - One task per (peer, topic). The requester's scheduler gives a provider at most one
 *   batch at a time, so a new request means the previous one was given up: it is aborted.
 *   This also recovers when a cancellation got lost on the way.
 * - Requested ids that are not stored (anymore) are found first, reading the id column only,
 *   and reported back right away with a cancellation, so the requester can reassign them
 *   without waiting for its timeout.
 * - Then one message per frame: each row is loaded right before it is sent, so at most one
 *   payload is in memory per task. Stored payloads are forwarded as canonical strings, never parsed.
 * - Cancellation is checked before every frame.
 * - Tasks are addressed by (peer, topic, assignmentKey): a peer can only cancel its own task.
 */
export class MessageDeliveryTasks {
    /**
     * @param {Object} params
     * @param {import('../../session.manager.js').SessionManager} params.sessionManager
     * @param {import('../../message.manager.js').MessageManager} params.messageManager
     */
    constructor({ sessionManager, messageManager }) {
        this.sessionManager = sessionManager;
        this.messageManager = messageManager;

        /**
         * Running tasks.
         * @type {Map<string, { assignmentKey: string, controller: AbortController, skipped: Set<string> }>}
         * - `${peerPublicKey}:${topic}` -> task
         */
        this.tasks = new Map();
    }

    static taskKey(peerPublicKey, topic) {
        return `${peerPublicKey}:${topic}`;
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    get credentials() {
        return this.sessionManager.getCredentials();
    }

    get settings() {
        return this.sessionManager.getMessageConfig().reconciliation;
    }

    /**
     * Returns the running task of a peer for a topic.
     * @param {string} peerPublicKey
     * @param {string} topic
     */
    getTask(peerPublicKey, topic) {
        return this.tasks.get(MessageDeliveryTasks.taskKey(peerPublicKey, topic));
    }

    /**
     * Serves a request. Resolves once the task is finished, cancelled or failed.
     * @param {Object} params
     * @param {Object} params.socket - Socket of the requester.
     * @param {string} params.peerPublicKey - Requester public key.
     * @param {string} params.topic - Space topic hash.
     * @param {number} params.spaceId - Local id of the space.
     * @param {string} params.assignmentKey - Key of the requester's assignment.
     * @param {string[]} params.messageIds - Requested message ids.
     * @returns {Promise<void>}
     */
    async start({ socket, peerPublicKey, topic, spaceId, assignmentKey, messageIds }) {
        const key = MessageDeliveryTasks.taskKey(peerPublicKey, topic);

        // the requester gave up its previous assignment
        this.tasks.get(key)?.controller.abort();

        const task = { assignmentKey, controller: new AbortController(), skipped: new Set() };
        this.tasks.set(key, task);

        try {
            await this.run(task, { socket, topic, spaceId, messageIds });
        }
        catch (error) {
            logger.warn('Message delivery failed', { peerPublicKey, topic, error });
        }
        finally {
            if (this.tasks.get(key) === task) {
                this.tasks.delete(key);
            }
        }
    }

    /** @private */
    async run(task, { socket, topic, spaceId, messageIds }) {
        const { signal } = task.controller;
        const isStopped = () => signal.aborted || socket.destroyed;

        const ids = Array.from(new Set(messageIds));
        const stored = await filterStoredMessageIds(this.db, { spaceId, messageIds: ids });
        if (isStopped()) return;

        if (stored.size < ids.length) {
            const missing = ids.filter(messageId => !stored.has(messageId));
            // nothing stored at all: cancel the whole assignment
            await this.sendCancel(socket, topic, task.assignmentKey, stored.size > 0 ? missing : undefined);
        }

        const vanished = [];

        for (const messageId of ids) {
            if (!stored.has(messageId) || task.skipped.has(messageId)) continue;

            if (isStopped()) return;

            const record = await getMessageRecordById(this.db, { spaceId, messageId });
            if (!record) {
                vanished.push(messageId); // deleted meanwhile
                continue;
            }
            // skipped while it was loading
            if (task.skipped.has(messageId) || isStopped()) continue;

            const { publicKey, secretKey } = this.credentials;
            const message = await createNegentropyContentDeliveryMessage({
                topic,
                assignmentKey: task.assignmentKey,
                content: toDeliverableMessage(record),
                publicKey,
                secretKey,
            });

            await this.messageManager.sendMessageToSocket(message, socket);
        }

        if (vanished.length > 0 && !isStopped()) {
            await this.sendCancel(socket, topic, task.assignmentKey, vanished);
        }
    }

    /**
     * The requester cancelled (part of) its assignment.
     * @param {string} peerPublicKey
     * @param {string} topic
     * @param {string} assignmentKey
     * @param {string[]|null} [messageIds=null] - Skip only these ids; null stops the task.
     * @returns {boolean} True if a matching task was found.
     */
    cancel(peerPublicKey, topic, assignmentKey, messageIds = null) {
        const task = this.getTask(peerPublicKey, topic);
        if (!task || task.assignmentKey !== assignmentKey) {
            return false;
        }

        if (messageIds) {
            for (const messageId of messageIds) {
                task.skipped.add(messageId);
            }

        } else {
            task.controller.abort();
            this.tasks.delete(MessageDeliveryTasks.taskKey(peerPublicKey, topic));
        }

        return true;
    }

    /**
     * Aborts every task of a peer (e.g. on disconnect).
     * @param {string} peerPublicKey
     */
    abortPeer(peerPublicKey) {
        for (const [key, task] of Array.from(this.tasks)) {
            if (key.startsWith(`${peerPublicKey}:`)) {
                task.controller.abort();
                this.tasks.delete(key);
            }
        }
    }

    /**
     * Aborts every task.
     */
    stop() {
        for (const task of this.tasks.values()) {
            task.controller.abort();
        }

        this.tasks.clear();
    }

    /** @private */
    async sendCancel(socket, topic, assignmentKey, messageIds) {
        const { publicKey, secretKey } = this.credentials;
        const message = await createNegentropyContentCancelMessage({
            topic,
            assignmentKey,
            messageIds,
            publicKey,
            secretKey,
        });

        await this.messageManager.sendMessageToSocket(message, socket);
    }
}
