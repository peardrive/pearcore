import * as EVENTS from '../../constants/events.constants.js';
import * as MESSAGES from '../../constants/messages.constants.js';
import { createChild } from '../../logger.js';
import { hex, randomNonce } from '../../utils/crypto.utils.js';
import { now } from '../../utils/general.utils.js';
import { buildMessageRecordPayload, insertMessageRecords, isReconciliationInitiator } from '../../utils/message.utils.js';
import { publicKeyIsAllowedToBroadcast, publicKeyIsAllowedToRead } from '../../utils/policy.utils.js';
import {
    computeDeliveredMessageId,
    createNegentropyContentCancelMessage,
    createNegentropyContentRequestMessage,
    createNegentropySyncMessage,
    verifyDeliveredMessage
} from '../../utils/protocol.utils.js';
import { getSpace, getSpaceTopicHash, getTopicToSpaceMap } from '../../utils/space.utils.js';
import { SpaceSyncHandler } from '../../protocols/space.protocol.js';
import { NegentropyRole, NegentropySync } from './components/sync.js';
import { MessageRequestScheduler } from './components/scheduler.js';
import { MessageDeliveryTasks } from './components/delivery.js';

const logger = createChild('NegentropySyncManager');

/**
 * Coordinates message-history reconciliation with every connected peer.
 *
 * - One `NegentropySync` session per (peer, space topic).
 * - Sessions start after `SpaceSync`: the peer chosen by `isReconciliationInitiator()`
 *   initiates. On a first encounter only the newcomer receives a `SpaceSync`, so it
 *   always initiates; the other peer creates its responder session on the first message.
 * - Once a session is done, the peer is registered as provider of the ids the local node
 *   needs, in the topic's `MessageRequestScheduler` (work-stealing between peers).
 * - Requester side: the schedulers decide who delivers what; this class sends their
 *   `NegentropyContentRequest`/`NegentropyContentCancel` messages and feeds the delivered
 *   `NegentropyContentDelivery` messages back to them once verified and stored.
 * - Provider side: `MessageDeliveryTasks` serves the requests of other peers.
 *
 * Registered on the manager stack as `managers.sync`; protocol handlers only talk to this class.
 */
export class NegentropySyncManager {
    constructor(emitter, managers) {
        this.emitter = emitter;
        this.sessionManager = managers.sessionManager;
        this.socketManager = managers.socketManager;
        this.messageManager = managers.messageManager;

        /** `${peerPublicKey}:${topic}` -> session entry */
        this.sessions = new Map();
        /** topic -> MessageRequestScheduler */
        this.schedulers = new Map();
        /** serves message contents requested by other peers */
        this.delivery = new MessageDeliveryTasks({
            sessionManager: this.sessionManager,
            messageManager: this.messageManager,
        });

        this.heartbeatTimer = null;
        this._heartbeatRunning = false;

        this._onSpaceSync = null;
        this._onDisconnect = null;
        this._onReject = null;
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

    static sessionKey(peerPublicKey, topic) {
        return `${peerPublicKey}:${topic}`;
    }

    /**
     * Starts listening to space and connection events.
     */
    async init() {
        this._onSpaceSync = context => this.onSpaceSync(context).catch(error => logger.warn(error));
        this._onDisconnect = context => this.onDisconnect(context);
        this._onReject = context => this.onReject(context);

        this.emitter.on(EVENTS.SpaceSync, this._onSpaceSync);
        this.emitter.on(EVENTS.Disconnect, this._onDisconnect);
        this.emitter.on(EVENTS.Reject, this._onReject);

        this.heartbeatTimer = setInterval(() => this.heartbeat(), this.settings.heartbeatInterval);
        this.heartbeatTimer.unref?.();
    }

    /**
     * Stops listening and drops every session and scheduler.
     */
    async stop() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        if (this._onSpaceSync) {
            this.emitter.off(EVENTS.SpaceSync, this._onSpaceSync);
            this.emitter.off(EVENTS.Disconnect, this._onDisconnect);
            this.emitter.off(EVENTS.Reject, this._onReject);
            this._onSpaceSync = null;
            this._onDisconnect = null;
            this._onReject = null;
        }

        this.delivery.stop();
        this.sessions.clear();
        this.schedulers.clear();
    }

    /**
     * @param {string} peerPublicKey
     * @param {string} topic
     * @returns {Object|undefined} The session entry.
     */
    getSession(peerPublicKey, topic) {
        return this.sessions.get(NegentropySyncManager.sessionKey(peerPublicKey, topic));
    }

    /**
     * Returns (and lazily creates) the request scheduler of a topic.
     * @param {string} topic
     * @returns {MessageRequestScheduler}
     */
    getScheduler(topic) {
        if (!this.schedulers.has(topic)) {
            const scheduler = new MessageRequestScheduler({
                sessionManager: this.sessionManager,
                topic: topic,
                request: (publicKey, messageIds, assignmentKey) =>
                    this.sendContentRequest(topic, publicKey, messageIds, assignmentKey),
                cancel: (publicKey, assignmentKey) =>
                    this.sendContentCancel(topic, publicKey, assignmentKey),
            });

            this.schedulers.set(topic, scheduler);
        }

        return this.schedulers.get(topic);
    }

    /**
     * Marks messages of a space as delivered (e.g. received through gossip),
     * freeing their providers for the next batch.
     * @param {string} topic
     * @param {Iterable<string>} messageIds
     */
    markDelivered(topic, messageIds) {
        const scheduler = this.schedulers.get(topic);
        if (!scheduler) return;

        scheduler.markDelivered(messageIds);
        scheduler.assign();
    }

    /**
     * Resolves the local space record of a topic.
     * @param {string} topic
     * @returns {Promise<{ spaceId: number, space: Object }|null>}
     */
    async resolveSpace(topic) {
        const topicMap = await getTopicToSpaceMap(this.db);
        const spaceId = topicMap.get(topic);
        if (!spaceId) return null;

        const space = await getSpace(this.db, spaceId);
        return space ? { spaceId, space } : null;
    }

    /**
     * `SpaceSync` event handler: starts a session when the local node is the initiator.
     * @param {Object} context
     * @param {Object} context.info - Hyperswarm info of the sender.
     * @param {Object} context.message - The SpaceSync message (payload is the space).
     * @param {string} context.action - SpaceSyncHandler.STATES value.
     */
    async onSpaceSync({ info, message, action }) {
        const peerPublicKey = hex(info.publicKey);
        const topic = getSpaceTopicHash(message.payload);
        const { publicKey } = this.credentials;

        // on a first encounter, only the newcomer is notified: it always initiates.
        const isFirstEncounter = action === SpaceSyncHandler.STATES.FIRST_ENCOUNTER;

        if (!isFirstEncounter && !isReconciliationInitiator(topic, publicKey, peerPublicKey)) {
            return;
        }

        await this.startSession(peerPublicKey, topic);
    }

    /**
     * Starts a reconciliation session as initiator, unless one is already running or done.
     * @param {string} peerPublicKey
     * @param {string} topic
     * @returns {Promise<Object|null>} The session entry, or null if the session cannot start.
     */
    async startSession(peerPublicKey, topic) {
        const key = NegentropySyncManager.sessionKey(peerPublicKey, topic);
        if (this.sessions.has(key)) return this.sessions.get(key);

        const resolved = await this.resolveSpace(topic);
        if (!resolved) return null;
        if (!publicKeyIsAllowedToRead(peerPublicKey, resolved.space)) return null;

        // re-check, another trigger may have started the session meanwhile
        if (this.sessions.has(key)) return this.sessions.get(key);

        const session = this.createSession({
            peerPublicKey,
            topic,
            spaceId: resolved.spaceId,
            role: NegentropyRole.INITIATOR,
            sessionId: hex(randomNonce()),
        });

        try {
            const ranges = await session.sync.initiate();
            await this.send(session, ranges);
        }
        catch (error) {
            logger.warn('Failed to initiate reconciliation', { peerPublicKey, topic, error });
            this.dropSession(session);
            return null;
        }

        return session;
    }

    /**
     * Handles a validated NegentropySync message from a peer allowed to read the space.
     * Called by `NegentropySyncHandler`.
     * @param {Object} socket - Socket of the sender.
     * @param {Object} message - NegentropySync message.
     * @param {number} spaceId - Local id of the space.
     */
    async handleMessage(socket, message, spaceId) {
        const peerPublicKey = message.publicKey;
        const { topic } = message;
        const { sessionId, ranges } = message.payload;

        let session = this.getSession(peerPublicKey, topic);

        if (session && session.sessionId !== sessionId) {
            const isOwnActiveSession = session.role === NegentropyRole.INITIATOR && !session.sync.isDone;
            const keepOwnSession = isReconciliationInitiator(topic, this.credentials.publicKey, peerPublicKey);

            // both peers initiated at the same time: the rule decides which session survives
            if (isOwnActiveSession && keepOwnSession) {
                await this.messageManager.reject(socket, message, MESSAGES.NEGENTROPY_SESSION_CONFLICT_MESSAGE);
                return;
            }

            // a new session from the peer replaces ours (lost the conflict, or an old session)
            this.dropSession(session);
            session = null;
        }

        if (!session) {
            // a closing message of a session we no longer know about
            if (ranges.length === 0) return;

            session = this.createSession({
                peerPublicKey,
                topic,
                spaceId,
                role: NegentropyRole.RESPONDER,
                sessionId,
            });
        }

        session.lastActivity = now();

        let reply = null;
        try {
            reply = await session.sync.reconcile(ranges);
        }
        catch (error) {
            logger.warn('Reconciliation failed', { peerPublicKey, topic, error });
            this.dropSession(session);
            await this.messageManager.reject(socket, message, MESSAGES.NEGENTROPY_SYNC_FAILED_MESSAGE);
            return;
        }

        if (reply !== null) {
            await this.send(session, reply);
        }

        if (session.sync.isDone) {
            await this.complete(session);
        }
    }

    /**
     * Registers the finished session's peer as provider of the missing messages.
     * @param {Object} session
     */
    async complete(session) {
        const need = await session.sync.resolveNeeds();
        const scheduler = this.getScheduler(session.topic);

        scheduler.addProvider(session.peerPublicKey, need);

        this.emitter.emit(EVENTS.NegentropySyncComplete, {
            publicKey: session.peerPublicKey,
            topic: session.topic,
            role: session.role,
            have: [...session.sync.have],
            need: need,
        });

        scheduler.assign();
    }

    /**
     * Provider side: serves a validated `NegentropyContentRequest`.
     * Called by `NegentropyContentRequestHandler`. Resolves when the delivery is over,
     * the handler does not wait for it.
     * @param {Object} socket - Socket of the requester.
     * @param {Object} message - NegentropyContentRequest message.
     * @param {number} spaceId - Local id of the space.
     * @returns {Promise<void>}
     */
    serveContentRequest(socket, message, spaceId) {
        const { assignmentKey, messageIds } = message.payload;

        return this.delivery.start({
            socket,
            peerPublicKey: message.publicKey,
            topic: message.topic,
            spaceId,
            assignmentKey,
            messageIds,
        });
    }

    /**
     * Handles a validated `NegentropyContentCancel`, in either direction:
     * - as provider: the requester gave the assignment up, stop (or skip some ids).
     * - as requester: the provider cannot deliver (some of) the ids, withdraw them.
     * Assignment keys are random, so a key matches at most one side.
     * @param {Object} message - NegentropyContentCancel message.
     * @returns {{ role: 'provider'|'requester'|null, messageIds: string[] }}
     */
    handleContentCancel(message) {
        const peerPublicKey = message.publicKey;
        const { topic } = message;
        const { assignmentKey, messageIds = null } = message.payload;

        if (this.delivery.cancel(peerPublicKey, topic, assignmentKey, messageIds)) {
            return { role: 'provider', messageIds: messageIds ?? [] };
        }

        const scheduler = this.schedulers.get(topic);
        if (!scheduler) return { role: null, messageIds: [] };

        const withdrawn = scheduler.withdraw(peerPublicKey, assignmentKey, messageIds);
        if (withdrawn.length === 0) return { role: null, messageIds: [] };

        scheduler.assign();
        return { role: 'requester', messageIds: withdrawn };
    }

    /**
     * Requester side: accepts a validated `NegentropyContentDelivery` (one message).
     * Called by `NegentropyContentDeliveryHandler`.
     *
     * - A delivery for an unknown or reclaimed assignment, or of an id that is not part of
     *   it, is dropped quietly (a late delivery is a normal race, not misbehaviour).
     * - The message must be signed by its author, and the author must be allowed to
     *   broadcast in the space.
     * - The canonical payload string is stored as received: nothing is parsed or
     *   re-serialized, and the message id is computed once.
     * - A forged message penalizes the provider and takes its assignment back.
     *
     * @param {Object} message - NegentropyContentDelivery message.
     * @param {number} spaceId - Local id of the space.
     * @param {Object} space - Local space record.
     * @returns {Promise<{ messageId: string|null, status: 'stored'|'duplicate'|'ignored'|'refused'|'forged' }>}
     */
    async acceptContentDelivery(message, spaceId, space) {
        const peerPublicKey = message.publicKey;
        const { topic } = message;
        const { assignmentKey, content } = message.payload;

        const scheduler = this.schedulers.get(topic);
        if (!scheduler) return { messageId: null, status: 'ignored' };

        const messageId = computeDeliveredMessageId(content);
        if (!scheduler.expectsDelivery(peerPublicKey, assignmentKey, messageId)) {
            return { messageId, status: 'ignored' };
        }

        // nobody can deliver it in an acceptable way: resolve it instead of retrying
        if (!publicKeyIsAllowedToBroadcast(content.publicKey, space)) {
            scheduler.markDelivered([messageId]);
            scheduler.assign();
            return { messageId, status: 'refused' };
        }

        if (!(await verifyDeliveredMessage(topic, content))) {
            if (scheduler.getAssignment(peerPublicKey, assignmentKey)) {
                logger.warn('Provider delivered a message with an invalid signature', { peerPublicKey, topic });
                scheduler.releaseProvider(peerPublicKey, { penalize: true, notify: true });
                scheduler.assign();
            }

            return { messageId, status: 'forged' };
        }

        const row = buildMessageRecordPayload({
            message: {
                type: content.type,
                publicKey: content.publicKey,
                timestamp: content.timestamp,
                nonce: content.nonce,
                signature: content.signature,
            },
            spaceId,
            senderPublicKey: peerPublicKey,
            timestamp: now(),
            canonicalPayload: content.canonicalPayload,
            messageId,
        });

        const [inserted] = await insertMessageRecords(this.db, [row]);

        // an already stored message counts as delivered too: the local node has it
        scheduler.markDelivered([messageId]);

        if (inserted) {
            this.emitter.emit(EVENTS.NegentropyContentDelivered, {
                publicKey: peerPublicKey,
                topic,
                spaceId,
                messageId,
            });
        }

        scheduler.assign();
        return { messageId, status: inserted ? 'stored' : 'duplicate' };
    }

    /**
     * `Disconnect` event handler: drops the peer's sessions, stops serving it and
     * reassigns its requests.
     * @param {{ publicKey: string }} context
     */
    onDisconnect({ publicKey }) {
        for (const session of [...this.sessions.values()]) {
            if (session.peerPublicKey === publicKey) this.dropSession(session);
        }

        this.delivery.abortPeer(publicKey);

        for (const scheduler of this.schedulers.values()) {
            scheduler.removeProvider(publicKey);
            scheduler.assign();
        }
    }

    /**
     * `Reject` event handler: a peer refused our last session message.
     * @param {{ fromPublicKey: string, linkedMessageNonce: string }} context
     */
    onReject({ fromPublicKey, linkedMessageNonce }) {
        for (const session of [...this.sessions.values()]) {
            if (session.peerPublicKey === fromPublicKey && session.lastSentNonce === linkedMessageNonce) {
                this.dropSession(session);
            }
        }
    }

    /**
     * Housekeeping: drops idle sessions and reassigns stalled requests.
     */
    async heartbeat() {
        if (this._heartbeatRunning) return;
        this._heartbeatRunning = true;

        try {
            const idleBefore = now() - this.settings.sessionTimeout;

            for (const session of [...this.sessions.values()]) {
                if (!session.sync.isDone && session.lastActivity <= idleBefore) {
                    logger.warn('Reconciliation session timed out', {
                        peerPublicKey: session.peerPublicKey,
                        topic: session.topic
                    });
                    this.dropSession(session);
                }
            }

            for (const scheduler of this.schedulers.values()) {
                scheduler.reclaimStalled();
                scheduler.assign();
            }
        }
        catch (error) {
            logger.warn(error);
        }
        finally {
            this._heartbeatRunning = false;
        }
    }

    /** @private */
    createSession({ peerPublicKey, topic, spaceId, role, sessionId }) {
        const session = {
            sync: new NegentropySync({
                session: this.sessionManager,
                spaceId,
                topic,
                peerPublicKey,
                role,
            }),
            sessionId,
            peerPublicKey,
            topic,
            spaceId,
            role,
            lastActivity: now(),
            lastSentNonce: null,
        };

        this.sessions.set(NegentropySyncManager.sessionKey(peerPublicKey, topic), session);
        return session;
    }

    /** @private */
    dropSession(session) {
        const key = NegentropySyncManager.sessionKey(session.peerPublicKey, session.topic);
        if (this.sessions.get(key) === session) {
            this.sessions.delete(key);
        }
    }

    /**
     * Sends a scheduler assignment to its provider.
     * @private
     */
    async sendContentRequest(topic, publicKey, messageIds, assignmentKey) {
        const sockets = this.socketManager.getConnectedSockets({ peers: [publicKey] });
        if (sockets.length === 0) {
            throw new Error('peer is not connected');
        }

        const credentials = this.credentials;
        const message = await createNegentropyContentRequestMessage({
            topic,
            assignmentKey,
            messageIds,
            publicKey: credentials.publicKey,
            secretKey: credentials.secretKey,
        });

        await this.messageManager.sendMessageToSocket(message, sockets[0]);
    }

    /**
     * Tells a provider to stop delivering a reclaimed assignment.
     * @private
     */
    async sendContentCancel(topic, publicKey, assignmentKey) {
        const sockets = this.socketManager.getConnectedSockets({ peers: [publicKey] });
        if (sockets.length === 0) return;

        const credentials = this.credentials;
        const message = await createNegentropyContentCancelMessage({
            topic,
            assignmentKey,
            publicKey: credentials.publicKey,
            secretKey: credentials.secretKey,
        });

        await this.messageManager.sendMessageToSocket(message, sockets[0]);
    }

    /**
     * Sends the session ranges to the peer.
     * @private
     */
    async send(session, ranges) {
        const sockets = this.socketManager.getConnectedSockets({ peers: [session.peerPublicKey] });
        if (sockets.length === 0) {
            throw new Error('peer is not connected');
        }

        const { publicKey, secretKey } = this.credentials;
        const message = await createNegentropySyncMessage({
            topic: session.topic,
            sessionId: session.sessionId,
            ranges,
            publicKey,
            secretKey,
        });

        session.lastSentNonce = message.nonce;
        session.lastActivity = now();

        await this.messageManager.sendMessageToSocket(message, sockets[0]);
    }
}
