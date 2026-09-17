import { describe, it, expect, beforeEach } from "vitest";
import * as EVENTS from '../../src/constants/events.constants.js';
import * as MESSAGES from '../../src/constants/messages.constants.js';
import { initializeManagers } from "../../src/managers/initialization.js";
import { createSpaceHashListMessage, createSpaceMessage, createSpaceSyncMessage, encryptPayload } from "../../src/utils/protocol.utils.js";
import { buildTestSpacePayload, createFakeP2PConnection, unframeJson } from "../general.utils.js";
import { createSpace, createSpaceForPublicKey, generateSpaceTopic, getSpace, getSpaceTopicHash, querySpace, updateSpaceForPublicKey, upsertSpace } from "../../src/utils/space.utils.js";
import { SpaceSyncHandler } from "../../src/protocols/space.protocol.js";
import { now, stripIds } from "../../src/utils/general.utils.js";
import { hex, randomNonce } from "../../src/utils/crypto.utils.js";
import { createP2PNetwork, createConnections } from '../general.utils.js';
import { saveShareLink } from "../../src/utils/sharelink.utils.js";

/**
 * In this test subject we use 4 virtual nodes with different purposes:
 * 
 * 1. primary and secondary nodes are the ones that 'communicate' and handle messages from each other.
 * 2. standby node is allowed to receive and read messages, but does not communicate. it only receives broadcast messages.
 * 3. outlier node is subscribed to the common topic, but is not allowed for read or broadcast.
 *    We consider outlier receiving any message from the space, an exception that should be avoided.
 */
describe('Space Protocols', () => {
    let primary;
    let primaryDB;
    let secondary;
    let secondaryDB;
    let standby;
    let outlier;
    let spaceParams;
    let spaceTopicHash;

    beforeEach(async () => {
        [primary, secondary, standby, outlier] = await createP2PNetwork(4);

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
        secondaryDB = secondary.manager.session.getDatabase().db;
    })

    describe('SpaceHashListHandler', () => {
        let message;

        beforeEach(async () => {
            message = await createSpaceHashListMessage({
                hashList: [spaceTopicHash],
                publicKey: primary.publicKey,
                secretKey: primary.secretKey
            });
        })

        it('should exist within the protocol map', () => {
            const managers = initializeManagers();
            expect(managers.message).toBeDefined();
            expect(managers.message.protocolHandlers.has(EVENTS.SpaceHashList)).toBe(true);
        })

        it('should handle valid SpaceHashList message', async () => {
            let eventContext = null;
            primary.manager.emitter.on(EVENTS.SpaceHashList, ({ message }) => {
                eventContext = message;
            })

            await primary.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(message), primary.info);
            const socketState = primary.manager.sockets.getSnapShot({ sortByPeers: true });

            expect(primary.socket.write.mock.calls.length).toBe(0); // no message reply back
            expect(socketState[primary.publicKey]).toEqual([spaceTopicHash]);
            expect(eventContext).toEqual(message);
        });

        it('should handle repeated SpaceHashList topic updates', async () => {
            await primary.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(message), primary.info);
            const socketState = primary.manager.sockets.getSnapShot({ sortByPeers: true });

            expect(primary.socket.write.mock.calls.length).toBe(0); // no message reply back
            expect(socketState[primary.publicKey]).toEqual([spaceTopicHash]);

            const secondSpaceTopicHash = 'b'.repeat(64);
            const secondaryMessage = await createSpaceHashListMessage({
                hashList: [secondSpaceTopicHash], //different topic
                publicKey: primary.publicKey,
                secretKey: primary.secretKey
            });

            await primary.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(secondaryMessage), primary.info);
            const updatedSocketState = primary.manager.sockets.getSnapShot({ sortByPeers: true });

            expect(primary.socket.write.mock.calls.length).toBe(0); // no message reply back
            expect(updatedSocketState[primary.publicKey]).toEqual([secondSpaceTopicHash]);
        });

        it('should reject invalid spaceHashList message', async () => {
            const message = await createSpaceHashListMessage({
                hashList: { data: 123 }, // non-Array hash list
                publicKey: primary.publicKey,
                secretKey: primary.secretKey
            });

            await primary.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(message), primary.info);
            const callStack = primary.socket.write.mock.calls
            expect(callStack.length).toBe(1);

            const response = JSON.parse(unframeJson(callStack[0][0]));
            expect(response.type).toEqual(EVENTS.Reject);
            expect(response.topic).toEqual(EVENTS.noTopic);
            expect(response.payload.linkedMessageNonce).toEqual(message.nonce);
            expect(response.payload.reason).toEqual('SpaceHashList payload should be an array');
        });

        it('should reject relayed spaceHashList message', async () => {
            await primary.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(message), secondary.info);
            const callStack = primary.socket.write.mock.calls
            expect(callStack.length).toBe(1);

            const response = JSON.parse(unframeJson(callStack[0][0]));
            expect(response.type).toEqual(EVENTS.Reject);
            expect(response.topic).toEqual(EVENTS.noTopic);
            expect(response.payload.linkedMessageNonce).toEqual(message.nonce);
            expect(response.payload.reason).toEqual(MESSAGES.NO_RELAY_MESSAGE);
        });

        it('should send back SpaceSync message for common space topic', async () => {
            const { spaceId } = await createSpaceForPublicKey(primaryDB, {
                spaceName: 'test',
                publicKey: primary.publicKey
            }, primary.secretKey);

            const space = await getSpace(primaryDB, spaceId);
            const topicHash = getSpaceTopicHash(space);
            const message = await createSpaceHashListMessage({
                hashList: [topicHash],
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            await primary.manager.message.handleIncomingMessage(
                secondary.socket,
                JSON.stringify(message),
                secondary.info
            );

            const callStack = secondary.socket.write.mock.calls
            const response = JSON.parse(unframeJson(callStack[0][0]));
            expect(response.payload).toEqual(stripIds(space));
        });
    })

    describe('SpaceSyncHandler', () => {
        let newerSpaceParams;

        beforeEach(() => {
            newerSpaceParams = {
                spaceName: spaceParams.spaceName,
                publicKey: spaceParams.publicKey,
                nonce: spaceParams.nonce,
                timestamp: now() // newer space timestamp
            };
        })

        it('should handle FIRST_ENCOUNTER space sync scenario', async () => {
            const { spaceId } = await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
            const space = await getSpace(primaryDB, spaceId);
            await saveShareLink(secondaryDB, spaceParams);

            const message = await createSpaceSyncMessage({
                topic: spaceTopicHash,
                space: stripIds(space),
                publicKey: primary.publicKey,
                secretKey: primary.secretKey
            });

            let actionContext = null;
            secondary.manager.emitter.on(EVENTS.SpaceSync, ({ message, action }) => { actionContext = action; });

            await secondary.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(message), primary.info);
            expect(actionContext).toBe(SpaceSyncHandler.STATES.FIRST_ENCOUNTER);

            // no reply back to the sender.
            // const primaryCallStack = primary.socket.write.mock.calls;
            // expect(primaryCallStack.length).toBe(0);

            // standby should receive message from first encounter
            const standbyCallStack = standby.socket.write.mock.calls;
            expect(standbyCallStack.length).toBe(1);

            const standbyReceivedMessage = JSON.parse(unframeJson(standbyCallStack[0][0]));
            expect(standbyReceivedMessage).toEqual(message);

            // outlier should not receive message
            const outlierCallStack = outlier.socket.write.mock.calls;
            expect(outlierCallStack.length).toBe(0);
        });

        it('should handle INDENTICAL space sync scenario', async () => {
            const { spaceId } = await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
            const space = await getSpace(primaryDB, spaceId);

            // add space information to the second node to trigger INDETICAL scenario
            await upsertSpace(secondaryDB, space);

            const message = await createSpaceSyncMessage({
                topic: spaceTopicHash,
                space: stripIds(space),
                publicKey: primary.publicKey,
                secretKey: primary.secretKey
            });

            let actionContext = null;
            secondary.manager.emitter.on(EVENTS.SpaceSync, ({ message, action }) => { actionContext = action; });

            await secondary.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(message), primary.info);

            expect(actionContext).toBe(SpaceSyncHandler.STATES.IDENTICAL);

            // no response for identical spaces.
            // const primaryCallStack = primary.socket.write.mock.calls;
            // expect(primaryCallStack.length).toBe(0);

            // standby should not receive broadcast message in identical situation
            const standbyCallStack = standby.socket.write.mock.calls;
            expect(standbyCallStack.length).toBe(0);

            // outlier should not receive message
            const outlierCallStack = outlier.socket.write.mock.calls;
            expect(outlierCallStack.length).toBe(0);
        });

        it('should handle LOCAL_SPACE_REQUIRE_UPDATE space sync scenario', async () => {
            const { spaceId } = await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
            const space = await getSpace(primaryDB, spaceId);

            // add space information to the second node to trigger INDETICAL scenario
            const { spaceId: secondarySpaceId } = await upsertSpace(secondaryDB, space);
            // update the space from the primary to maintain newer timestamp
            await updateSpaceForPublicKey(
                primaryDB,
                spaceId,
                { ...space, ...newerSpaceParams }, 
                primary.secretKey
            );

            const updatedSpace = await getSpace(primaryDB, spaceId);
            const secondarySpace = await getSpace(secondaryDB, secondarySpaceId);

            // ensure that the primary space has newer timestamp and both 
            // nodes already have the original space stored
            expect(secondarySpace).toBeDefined();
            expect(updatedSpace.timestamp).toBeGreaterThan(secondarySpace.timestamp);

            const message = await createSpaceSyncMessage({
                topic: spaceTopicHash,
                space: stripIds(updatedSpace),
                publicKey: primary.publicKey,
                secretKey: primary.secretKey
            });

            let actionContext = null;
            secondary.manager.emitter.on(EVENTS.SpaceSync, ({ message, action }) => { actionContext = action; });

            await secondary.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(message), primary.info);

            expect(actionContext).toBe(SpaceSyncHandler.STATES.LOCAL_SPACE_REQUIRE_UPDATE);

            // stored space from the secondary should now be updated
            const updatedSecondarySpace = await getSpace(secondaryDB, secondarySpaceId);
            expect(stripIds(updatedSecondarySpace)).toEqual(stripIds(updatedSpace));

            // standby should receive message for update
            const standbyCallStack = standby.socket.write.mock.calls;
            expect(standbyCallStack.length).toBe(1);

            const standbyReceivedMessage = JSON.parse(unframeJson(standbyCallStack[0][0]));
            expect(standbyReceivedMessage).toEqual(message);

            // outlier should not receive message
            const outlierCallStack = outlier.socket.write.mock.calls;
            expect(outlierCallStack.length).toBe(0);
        });

        it('should handle PEER_REQUIRE_UPDATE space sync scenario', async () => {
            const { spaceId } = await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
            const space = await getSpace(primaryDB, spaceId);
            const spaceTopic = generateSpaceTopic(space.spaceName, space.publicKey, space.nonce);

            // add space information to the second node to trigger INDETICAL scenario
            const { spaceId: secondarySpaceId } = await upsertSpace(secondaryDB, space);
            // update the space from the primary to maintain newer timestamp
            await updateSpaceForPublicKey(
                primaryDB, 
                spaceId, 
                { ...space, ...newerSpaceParams }, 
                primary.secretKey
            );

            const primaryUpdatedSpace = await getSpace(primaryDB, spaceId);
            const secondarySpace = await getSpace(secondaryDB, secondarySpaceId);

            // ensure that the primary space has newer timestamp and both 
            // nodes already have the original space stored
            expect(secondarySpace).toBeDefined();
            expect(primaryUpdatedSpace.timestamp).toBeGreaterThan(secondarySpace.timestamp);

            const message = await createSpaceSyncMessage({
                topic: spaceTopic,
                space: stripIds(secondarySpace),
                publicKey: secondary.publicKey,
                secretKey: secondary.secretKey
            });

            let actionContext = null;
            primary.manager.emitter.on(EVENTS.SpaceSync, ({ message, action }) => { actionContext = action; });

            await primary.manager.message.handleIncomingMessage(secondary.socket, JSON.stringify(message), secondary.info);

            expect(actionContext).toBe(SpaceSyncHandler.STATES.PEER_REQUIRE_UPDATE);

            // this response is an attemp update sender's space record with the new data
            const secondaryReceivedMessage = JSON.parse(unframeJson(secondary.socket.write.mock.calls[0][0]));
            expect(secondaryReceivedMessage.type).toEqual(EVENTS.SpaceSync);
            expect(secondaryReceivedMessage.topic).toEqual(message.topic);
            expect(secondaryReceivedMessage.payload).toEqual(primaryUpdatedSpace);

            expect(standby.socket.write.mock.calls.length).toBe(0);

            // send primary response back to secondary to update the space data
            await secondary.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(secondaryReceivedMessage), primary.info);
            const updatedSecondarySpace = await getSpace(secondaryDB, secondarySpaceId);
            expect(stripIds(updatedSecondarySpace)).toEqual(stripIds(primaryUpdatedSpace));

            // standby should receive message from secondary
            const standbyCallStack = standby.socket.write.mock.calls;
            expect(standbyCallStack.length).toBe(1);

            const standbyReceivedMessage = JSON.parse(unframeJson(standbyCallStack[0][0]));
            expect(standbyReceivedMessage).toEqual(secondaryReceivedMessage);

            // outlier should not receive message
            const outlierCallStack = outlier.socket.write.mock.calls;
            expect(outlierCallStack.length).toBe(0);
        });
    })

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
})