import * as EVENTS from '../../src/constants/events.constants.js';
import * as MESSAGES from '../../src/constants/messages.constants.js';
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { buildTestSpacePayload, cleanup, createP2PNetwork, createConnections, unframeJson } from "../general.utils.js";
import { createBaseMessage, createNegentropySyncMessage, createSpaceMessage, encryptPayload } from "../../src/utils/protocol.utils.js";
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
            expect(primary.manager.negentropy.sessions.size).toBe(0);
        });

        it('should not answer a peer that cannot read the space', async () => {
            await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
            const message = await createSyncMessage(outlier);

            await primary.manager.message.handleIncomingMessage(outlier.socket, JSON.stringify(message), outlier.info);

            expect(lastReply(outlier).type).toBe(EVENTS.Reject);
            expect(lastReply(outlier).payload.reason).toBe(MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE);
            expect(primary.manager.negentropy.sessions.size).toBe(0);
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

            const session = primary.manager.negentropy.getSession(secondary.publicKey, spaceTopicHash);
            expect(session.sessionId).toBe(sessionId);
            expect(session.sync.isDone).toBe(true);
        });
    });
})
