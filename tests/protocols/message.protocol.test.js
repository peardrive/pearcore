import * as EVENTS from '../../src/constants/events.constants.js';
import * as MESSAGES from '../../src/constants/messages.constants.js';
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createMessageRecord, queryMessageRecord } from "../../src/utils/message.utils.js";
import { now } from "../../src/utils/general.utils.js";
import { buildTestSpacePayload, cleanup, createP2PNetwork, createConnections, unframeJson } from "../general.utils.js";
import {
    createBaseMessage,
    createNegentropyContentDeliveryMessage,
    createNegentropyContentRequestMessage,
    createNegentropySyncMessage,
    createSpaceMessage,
    encryptPayload,
    toDeliverableMessage
} from "../../src/utils/protocol.utils.js";
import { createSpaceForPublicKey, getSpace, getSpaceTopicHash } from "../../src/utils/space.utils.js";
import { hex, randomNonce } from "../../src/utils/crypto.utils.js";

/**
 * In this test subject we use 4 virtual nodes with different purposes:
 * 
 * 1. primary and secondary nodes are the ones that 'communicate' and handle messages from each other.
 * 2. standby node is allowed to receive and read messages, but does not communicate. it only receives broadcast messages.
 * 3. outlier node is subscribed to the common topic, but is not allowed for read or broadcast.
 *    We consider outlier receiving any message from the space, an exception that should be avoided.
 */
describe('Message Protocols', () => {
    let nodes;
    let primary;
    let primaryDB;
    let secondary;
    let standby;
    let outlier;
    let spaceParams;
    let spaceTopicHash;

    beforeEach(async () => {
        nodes = await createP2PNetwork(4);
        [primary, secondary, standby, outlier] = nodes;

        spaceParams = await buildTestSpacePayload({
            spaceName: 'TestSpace',
            publicKey: primary.publicKey,
            permissionRead: 0,
            permissionBroadcast: 0,
            readWhitelist: [primary.publicKey, secondary.publicKey, standby.publicKey],
            broadcastWhitelist: [secondary.publicKey],
        });

        spaceTopicHash = getSpaceTopicHash(spaceParams);
        createConnections(spaceTopicHash, [primary, secondary, standby, outlier]);

        primaryDB = primary.manager.session.getDatabase().db;
    })

    afterEach(async () => {
        for (const node of nodes) {
            const { sqlite } = node.manager.session.getDatabase();
            await sqlite.close();

            await cleanup(node.manager.root);
        }
    });

    describe('SpaceMessageHandler', () => {
        it('should broadcast message from allowed publicKey', async () => {
            const { spaceId } = await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
            const space = await getSpace(primaryDB, spaceId);
            
            const content = { data: 'hello world' };
            const nonce = hex(randomNonce());
            const encryptedContent = await encryptPayload({
                payload: content,
                spaceSecret: space.secret,
                nonce: nonce
            });

            const message = await createSpaceMessage({
                topic: spaceTopicHash,
                messagePayload: encryptedContent,
                publicKey: primary.publicKey,
                secretKey: primary.secretKey,
                nonce: nonce
            });

            let eventContext = null;
            primary.manager.emitter.on(EVENTS.SpaceMessage, (context) => {
                eventContext = context;
            })

            await primary.manager.message.handleIncomingMessage(secondary.socket, JSON.stringify(message), secondary.info);

            expect(eventContext.content).toEqual(content);

            expect(secondary.socket.write.mock.calls.length).toBe(0);

            const standbyCallStack = standby.socket.write.mock.calls;
            expect(standbyCallStack.length).toBe(1);

            const standbyReceivedMessage = JSON.parse(unframeJson(standbyCallStack[0][0]));
            expect(standbyReceivedMessage).toEqual(message);

            const outlierCallStack = outlier.socket.write.mock.calls;
            expect(outlierCallStack.length).toBe(0);
        })
    })

    describe('NegentropySyncHandler', () => {
        const sessionId = 'c'.repeat(24);
        const wholeRangeIdList = [{ upperBound: null, mode: EVENTS.NegentropyModeOptions.ID_LIST, ids: [] }];

        const createSyncMessage = (node, ranges = wholeRangeIdList) => createNegentropySyncMessage({
            topic: spaceTopicHash,
            sessionId: sessionId,
            ranges: ranges,
            publicKey: node.publicKey,
            secretKey: node.secretKey,
        });

        const lastReply = (node) => {
            const calls = node.socket.write.mock.calls;
            return JSON.parse(unframeJson(calls[calls.length - 1][0]));
        };

        it('should exist within the protocol map', () => {
            expect(primary.manager.message.protocolHandlers.has(EVENTS.NegentropySync)).toBe(true);
        });

        it('should reject relayed messages', async () => {
            await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
            const message = await createSyncMessage(standby);

            await primary.manager.message.handleIncomingMessage(secondary.socket, JSON.stringify(message), secondary.info);

            expect(lastReply(secondary).type).toBe(EVENTS.Reject);
            expect(lastReply(secondary).payload.reason).toBe(MESSAGES.NO_RELAY_MESSAGE);
        });

        it('should reject invalid payloads', async () => {
            await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
            const message = await createBaseMessage({
                type: EVENTS.NegentropySync,
                topic: spaceTopicHash,
                payload: { sessionId: 'xyz', ranges: [] },
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey,
            });

            await primary.manager.message.handleIncomingMessage(secondary.socket, JSON.stringify(message), secondary.info);

            expect(lastReply(secondary).type).toBe(EVENTS.Reject);
            expect(lastReply(secondary).payload.reason).toBe('sessionId should be 24 character hex string');
        });

        it('should reject messages for an unknown space', async () => {
            const message = await createSyncMessage(secondary);

            await primary.manager.message.handleIncomingMessage(secondary.socket, JSON.stringify(message), secondary.info);

            expect(lastReply(secondary).payload.reason).toBe(MESSAGES.SPACE_NOT_FOUND_MESSAGE);
            expect(primary.manager.sync.sessions.size).toBe(0);
        });

        it('should not answer a peer that cannot read the space', async () => {
            await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
            const message = await createSyncMessage(outlier);

            await primary.manager.message.handleIncomingMessage(outlier.socket, JSON.stringify(message), outlier.info);

            expect(lastReply(outlier).type).toBe(EVENTS.Reject);
            expect(lastReply(outlier).payload.reason).toBe(MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE);
            expect(primary.manager.sync.sessions.size).toBe(0);
        });

        it('should reconcile with a peer allowed to read the space', async () => {
            await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
            const message = await createSyncMessage(secondary);

            let eventContext = null;
            primary.manager.emitter.on(EVENTS.NegentropySync, context => { eventContext = context; });

            await primary.manager.message.handleIncomingMessage(secondary.socket, JSON.stringify(message), secondary.info);

            // both sides hold no message: the session ends right away
            const reply = lastReply(secondary);
            expect(reply.type).toBe(EVENTS.NegentropySync);
            expect(reply.payload).toEqual({ sessionId, ranges: [] });
            expect(eventContext.message).toEqual(message);

            const session = primary.manager.sync.getSession(secondary.publicKey, spaceTopicHash);
            expect(session.sessionId).toBe(sessionId);
            expect(session.sync.isDone).toBe(true);
        });
    });

    /**
     * primary (provider) serves standby (requester) messages authored by secondary.
     * Frames are routed by hand: whatever a node writes to `X.socket` is handled by X.
     */
    describe('Negentropy message delivery', () => {
        const MESSAGE_COUNT = 5;

        let standbyDB;
        let primarySpaceId;
        let standbySpaceId;
        let storedIds;
        let frameLog;
        let cursors;

        /** Frames written to `node.socket` since the last call. */
        const drain = node => {
            const calls = node.socket.write.mock.calls;
            const from = cursors.get(node) ?? 0;
            cursors.set(node, calls.length);
            return calls.slice(from).map(([buffer]) => unframeJson(buffer));
        };

        const settle = () => new Promise(resolve => setTimeout(resolve, 20));

        /** Routes frames both ways until the conversation is over. */
        const exchange = async (requester, provider) => {
            for (let round = 0; round < 50; round++) {
                await settle();

                const toProvider = drain(provider);
                const toRequester = drain(requester);
                const idle = provider.manager.sync.delivery.tasks.size === 0;

                if (toProvider.length === 0 && toRequester.length === 0 && idle) return;

                for (const raw of toProvider) {
                    frameLog.push({ to: 'provider', ...JSON.parse(raw) });
                    await provider.manager.message.handleIncomingMessage(requester.socket, raw, requester.info);
                }

                for (const raw of toRequester) {
                    frameLog.push({ to: 'requester', ...JSON.parse(raw) });
                    await requester.manager.message.handleIncomingMessage(provider.socket, raw, provider.info);
                }
            }

            throw new Error('exchange did not settle');
        };

        const framesOfType = (type, to) => frameLog.filter(frame => frame.type === type && frame.to === to);

        beforeEach(async () => {
            cursors = new Map();
            frameLog = [];
            standbyDB = standby.manager.session.getDatabase().db;

            ({ spaceId: primarySpaceId } = await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey));
            ({ spaceId: standbySpaceId } = await createSpaceForPublicKey(standbyDB, spaceParams, standby.secretKey));


            storedIds = [];
            for (let index = 0; index < MESSAGE_COUNT; index++) {
                const message = await createSpaceMessage({
                    topic: spaceTopicHash,
                    messagePayload: { text: `message "${index}" 🍐`, index },
                    publicKey: secondary.publicKey,
                    secretKey: secondary.secretKey,
                });

                const { messageId } = await createMessageRecord(primaryDB, {
                    message,
                    spaceId: primarySpaceId,
                    senderPublicKey: secondary.publicKey,
                    broadcastTimestamp: now(),
                });

                storedIds.push(messageId);
            }

            // ignore the frames of the setup
            drain(primary);
            drain(standby);
        });

        it('should register the delivery handlers', () => {
            for (const type of [EVENTS.NegentropyContentRequest, EVENTS.NegentropyContentDelivery, EVENTS.NegentropyContentCancel]) {
                expect(primary.manager.message.protocolHandlers.has(type)).toBe(true);
            }
        });

        it('should deliver requested messages and store them byte-identical', async () => {
            const scheduler = standby.manager.sync.getScheduler(spaceTopicHash);
            const delivered = [];
            standby.manager.emitter.on(EVENTS.NegentropyContentDelivered, context => delivered.push(context.messageId));

            scheduler.addProvider(primary.publicKey, storedIds);
            scheduler.assign();
            await exchange(standby, primary);

            expect(scheduler.isComplete()).toBe(true);
            expect(delivered.sort()).toEqual([...storedIds].sort());

            // one message per frame
            const deliveries = framesOfType(EVENTS.NegentropyContentDelivery, 'requester');
            expect(deliveries).toHaveLength(MESSAGE_COUNT);
            expect(deliveries.every(frame => typeof frame.payload.content.canonicalPayload === 'string')).toBe(true);

            const theirs = await queryMessageRecord(primaryDB, { spaceId: primarySpaceId });
            const ours = await queryMessageRecord(standbyDB, { spaceId: standbySpaceId });
            expect(ours).toHaveLength(MESSAGE_COUNT);

            for (const record of ours) {
                const original = theirs.find(row => row.messageId === record.messageId);

                expect(record.payload).toBe(original.payload);
                expect(record.signature).toBe(original.signature);
                expect(record.nonce).toBe(original.nonce);
                expect(record.ownerPublicKey).toBe(secondary.publicKey);
                expect(record.messageTimestamp).toBe(original.messageTimestamp);
                // the immediate sender is the provider
                expect(record.senderPublicKey).toBe(primary.publicKey);
            }
        });

        it('should withdraw ids the provider does not have', async () => {
            const missingId = 'f'.repeat(64);
            const scheduler = standby.manager.sync.getScheduler(spaceTopicHash);

            scheduler.addProvider(primary.publicKey, [...storedIds, missingId]);
            scheduler.assign();
            await exchange(standby, primary);

            const cancels = framesOfType(EVENTS.NegentropyContentCancel, 'requester');
            expect(cancels).toHaveLength(1);
            expect(cancels[0].payload.messageIds).toEqual([missingId]);

            expect(scheduler.isComplete()).toBe(true);
            expect(scheduler.providers.has(missingId)).toBe(false);
            expect(scheduler.penalties.has(primary.publicKey)).toBe(false);
            expect(await queryMessageRecord(standbyDB, { spaceId: standbySpaceId })).toHaveLength(MESSAGE_COUNT);
        });

        it('should quietly drop a payload for an unknown assignment', async () => {
            const [record] = await queryMessageRecord(primaryDB, { spaceId: primarySpaceId });
            const payload = await createNegentropyContentDeliveryMessage({
                topic: spaceTopicHash,
                assignmentKey: hex(randomNonce()),
                content: toDeliverableMessage(record),
                publicKey: primary.publicKey,
                secretKey: primary.secretKey,
            });

            await standby.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(payload), primary.info);

            // no rejection: a late delivery is a normal race
            expect(drain(primary)).toHaveLength(0);
            expect(await queryMessageRecord(standbyDB, { spaceId: standbySpaceId })).toHaveLength(0);
        });

        it('should penalize and cancel a provider that forges a message', async () => {
            const scheduler = standby.manager.sync.getScheduler(spaceTopicHash);
            scheduler.addProvider(primary.publicKey, storedIds.slice(0, 1));
            scheduler.assign();
            await settle();
            drain(primary); // the request is not routed: primary answers by hand

            const { assignmentKey } = scheduler.assignments.get(primary.publicKey);
            const [record] = await queryMessageRecord(primaryDB, { spaceId: primarySpaceId, messageId: storedIds[0] });
            const forged = { ...toDeliverableMessage(record), signature: 'a'.repeat(128) };

            const payload = await createNegentropyContentDeliveryMessage({
                topic: spaceTopicHash,
                assignmentKey,
                content: forged,
                publicKey: primary.publicKey,
                secretKey: primary.secretKey,
            });

            await standby.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(payload), primary.info);
            await settle();

            expect(await queryMessageRecord(standbyDB, { spaceId: standbySpaceId })).toHaveLength(0);
            expect(scheduler.penalties.get(primary.publicKey)).toBe(1);

            const [cancel] = drain(primary).map(raw => JSON.parse(raw));
            expect(cancel.type).toBe(EVENTS.NegentropyContentCancel);
            expect(cancel.payload).toEqual({ assignmentKey });
        });

        it('should reject requests from a peer that cannot read the space', async () => {
            const request = await createNegentropyContentRequestMessage({
                topic: spaceTopicHash,
                assignmentKey: hex(randomNonce()),
                messageIds: storedIds,
                publicKey: outlier.publicKey,
                secretKey: outlier.secretKey,
            });

            await primary.manager.message.handleIncomingMessage(outlier.socket, JSON.stringify(request), outlier.info);
            await settle();

            const replies = drain(outlier).map(raw => JSON.parse(raw));
            expect(replies).toHaveLength(1);
            expect(replies[0].type).toBe(EVENTS.Reject);
            expect(replies[0].payload.reason).toBe(MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE);
        });
    });
})
