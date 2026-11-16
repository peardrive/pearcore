// @ts-nocheck
import * as EVENTS from '../../src/constants/events.constants.js';
import * as MESSAGES from '../../src/constants/messages.constants.js';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  createMessageRecord,
  queryMessageRecord,
} from '../../src/utils/message.utils.js';
import { now } from '../../src/utils/general.utils.js';
import { buildTestSpacePayload } from '../general.utils.js';
import { MockCoreFactory } from '../mock.factory.js';
import {
  collectMessages,
  connectProtocolNodes,
  deliverMessage,
} from '../protocol.utils.js';
import {
  createBaseMessage,
  createNegentropyContentDeliveryMessage,
  createNegentropyContentRequestMessage,
  createNegentropySyncMessage,
  createSpaceMessage,
  encryptPayload,
  toDeliverableMessage,
} from '../../src/utils/protocol.utils.js';
import {
  createSpaceForPublicKey,
  getSpace,
  getSpaceTopicHash,
  upsertSpace,
} from '../../src/utils/space.utils.js';
import { hex, randomNonce } from '../../src/utils/crypto.utils.js';
import type { SignedSpace } from '../../src/utils/space.utils.js';

async function getExistingSpace(db: any, spaceId: number) {
  const space = await getSpace(db, spaceId);
  if (!space) throw new Error(`Space ${spaceId} was not found`);
  return space;
}

/**
 * In this test subject we use 4 factory cores with different purposes:
 *
 * 1. primary and secondary nodes are the ones that 'communicate' and handle messages from each other.
 * 2. standby node is allowed to receive and read messages, but does not communicate. it only receives broadcast messages.
 * 3. outlier node is subscribed to the common topic, but is not allowed for read or broadcast.
 *    We consider outlier receiving any message from the space, an exception that should be avoided.
 *
 * Nodes run on the in-memory peer network: the deterministic message is injected
 * into the receiver over the real link and every reply is observed as the
 * protocol message the sender receives (`EVENTS.General`). Assertions are scoped
 * by message type and sender, so handshake chatter and duplicate-nonce
 * rejections stay out of them.
 */
describe('Message Protocols', () => {
  let factory: MockCoreFactory;
  let cores: any[];
  let primary: any;
  let primaryDB: any;
  let secondary: any;
  let secondaryDB: any;
  let standby: any;
  let standbyDB: any;
  let outlier: any;
  let spaceParams: Awaited<ReturnType<typeof buildTestSpacePayload>>;
  let spaceTopicHash: string;
  let inboxes: Map<string, ReturnType<typeof collectMessages>>;

  const inboxOf = (core: any) => inboxes.get(core.name)!;

  /** Connects all four cores through the shared topic and waits for the handshake. */
  const connect = () => connectProtocolNodes(factory, spaceTopicHash, cores);

  /** Attaches the message collectors of every core. */
  const collect = () => {
    inboxes = new Map(cores.map((core) => [core.name, collectMessages(core)]));
  };

  beforeEach(async () => {
    factory = new MockCoreFactory();
    await factory.init();

    cores = await factory.createMultipleCores(4);
    const names = ['primary', 'secondary', 'standby', 'outlier'];
    cores.forEach((core, index) => {
      core.name = names[index];
    });
    [primary, secondary, standby, outlier] = cores;

    spaceParams = await buildTestSpacePayload({
      spaceName: 'TestSpace',
      publicKey: primary.publicKey,
      permissionRead: 0,
      permissionBroadcast: 0,
      readWhitelist: [
        primary.publicKey,
        secondary.publicKey,
        standby.publicKey,
      ],
      broadcastWhitelist: [secondary.publicKey],
    });

    spaceTopicHash = getSpaceTopicHash(spaceParams);

    primaryDB = primary.managers.session.getDatabase().db;
    secondaryDB = secondary.managers.session.getDatabase().db;
    standbyDB = standby.managers.session.getDatabase().db;
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  describe('SpaceMessageHandler', () => {
    it('should exist within the protocol map', () => {
      expect(
        primary.managers.message.protocolHandlers.has(EVENTS.SpaceMessage),
      ).toBe(true);
    });

    it('should broadcast message from allowed publicKey', async () => {
      const { spaceId } = await createSpaceForPublicKey(
        primaryDB,
        spaceParams,
        primary.secretKey,
      );
      const space = await getExistingSpace(primaryDB, spaceId);
      // standby learns the space, so it can receive the broadcast
      await upsertSpace(standbyDB, space as unknown as SignedSpace);

      await connect();
      collect();

      const content = { data: 'hello world' };
      const nonce = hex(randomNonce());
      const encryptedContent = await encryptPayload({
        payload: content,
        spaceSecret: space.secret!,
        nonce: nonce,
      });

      const message = await createSpaceMessage({
        topic: spaceTopicHash,
        messagePayload: encryptedContent,
        publicKey: primary.publicKey,
        secretKey: primary.secretKey,
        nonce: nonce,
      });

      let eventContext: any = null;
      primary.emitter.on(EVENTS.SpaceMessage, (context: any) => {
        eventContext = context;
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      expect(eventContext.content).toEqual(content);

      // the sender receives nothing back
      expect(inboxOf(secondary).of(EVENTS.SpaceMessage, primary)).toEqual([]);

      // standby received the broadcast byte for byte
      const standbyMessages = inboxOf(standby).of(
        EVENTS.SpaceMessage,
        primary,
      );
      expect(standbyMessages).toHaveLength(1);
      expect(standbyMessages[0].message).toEqual(message);

      // outlier should not receive the message
      expect(inboxOf(outlier).of(EVENTS.SpaceMessage)).toEqual([]);
    });
  });

  describe('NegentropySyncHandler', () => {
    const sessionId = 'c'.repeat(24);
    const wholeRangeIdList = [
      { upperBound: null, mode: EVENTS.NegentropyModeOptions.ID_LIST, ids: [] },
    ];

    const createSyncMessage = (
      node: any,
      ranges: typeof wholeRangeIdList = wholeRangeIdList,
    ) =>
      createNegentropySyncMessage({
        topic: spaceTopicHash,
        sessionId: sessionId,
        ranges: ranges,
        publicKey: node.publicKey,
        secretKey: node.secretKey,
      });

    it('should exist within the protocol map', () => {
      expect(
        primary.managers.message.protocolHandlers.has(EVENTS.NegentropySync),
      ).toBe(true);
    });

    it('should reject relayed messages', async () => {
      await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
      await connect();
      collect();

      const message = await createSyncMessage(standby);

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const replies = inboxOf(secondary).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        MESSAGES.NO_RELAY_MESSAGE,
      );
    });

    it('should reject invalid payloads', async () => {
      await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
      await connect();
      collect();

      const message = await createBaseMessage({
        type: EVENTS.NegentropySync,
        topic: spaceTopicHash,
        payload: { sessionId: 'xyz', ranges: [] },
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const replies = inboxOf(secondary).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        'sessionId should be 24 character hex string',
      );
    });

    it('should reject messages for an unknown space', async () => {
      await connect();
      collect();

      const message = await createSyncMessage(secondary);

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const replies = inboxOf(secondary).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        MESSAGES.SPACE_NOT_FOUND_MESSAGE,
      );
      expect(primary.managers.sync.sessions.size).toBe(0);
    });

    it('should not answer a peer that cannot read the space', async () => {
      await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
      await connect();
      collect();

      const message = await createSyncMessage(outlier);

      await deliverMessage(primary, outlier, message);
      await factory.settle();

      const replies = inboxOf(outlier).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE,
      );
      expect(primary.managers.sync.sessions.size).toBe(0);
    });

    it('should reconcile with a peer allowed to read the space', async () => {
      const { spaceId } = await createSpaceForPublicKey(
        primaryDB,
        spaceParams,
        primary.secretKey,
      );
      const space = await getExistingSpace(primaryDB, spaceId);
      // the responder needs the space record to process the closing reply
      await upsertSpace(secondaryDB, space as unknown as SignedSpace);

      await connect();
      collect();

      const message = await createSyncMessage(secondary);

      let eventContext: any = null;
      primary.emitter.on(EVENTS.NegentropySync, (context: any) => {
        eventContext = context;
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      // both sides hold no message: the session ends right away
      const replies = inboxOf(secondary).of(EVENTS.NegentropySync, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload).toEqual({ sessionId, ranges: [] });
      expect(eventContext.message).toEqual(message);

      const session = primary.managers.sync.getSession(
        secondary.publicKey,
        spaceTopicHash,
      );
      expect(session.sessionId).toBe(sessionId);
      expect(session.sync.isDone).toBe(true);
    });
  });

  /**
   * primary (provider) serves standby (requester) messages authored by secondary.
   * The exchange runs over the real in-memory link: the scheduler sends the
   * request through the transport and every delivery is received and stored by
   * the requester's message pipeline.
   */
  describe('Negentropy message delivery', () => {
    const MESSAGE_COUNT = 5;

    let primarySpaceId: number;
    let standbySpaceId: number;
    let storedIds: string[];

    beforeEach(async () => {
      ({ spaceId: primarySpaceId } = await createSpaceForPublicKey(
        primaryDB,
        spaceParams,
        primary.secretKey,
      ));
      ({ spaceId: standbySpaceId } = await createSpaceForPublicKey(
        standbyDB,
        spaceParams,
        standby.secretKey,
      ));

      // connect before storing any history: the handshake then finds two empty
      // histories and the message exchange stays under the test's control
      await connect();
      collect();

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
    });

    it('should register the delivery handlers', () => {
      for (const type of [
        EVENTS.NegentropyContentRequest,
        EVENTS.NegentropyContentDelivery,
        EVENTS.NegentropyContentCancel,
      ]) {
        expect(primary.managers.message.protocolHandlers.has(type)).toBe(true);
      }
    });

    it('should deliver requested messages and store them byte-identical', async () => {
      const scheduler = standby.managers.sync.getScheduler(spaceTopicHash);
      const delivered: string[] = [];
      standby.emitter.on(
        EVENTS.NegentropyContentDelivered,
        (context: { messageId: string }) => delivered.push(context.messageId),
      );

      scheduler.addProvider(primary.publicKey, storedIds);
      scheduler.assign();

      await vi.waitFor(() => expect(scheduler.isComplete()).toBe(true));
      await factory.settle();

      expect(delivered.sort()).toEqual([...storedIds].sort());

      // one message per received frame
      const deliveries = inboxOf(standby).of(
        EVENTS.NegentropyContentDelivery,
        primary,
      );
      expect(deliveries).toHaveLength(MESSAGE_COUNT);
      expect(
        deliveries.every(
          (frame: any) =>
            typeof frame.message.payload.content.canonicalPayload === 'string',
        ),
      ).toBe(true);

      const theirs = await queryMessageRecord(primaryDB, {
        spaceId: primarySpaceId,
      });
      const ours = await queryMessageRecord(standbyDB, {
        spaceId: standbySpaceId,
      });
      expect(ours).toHaveLength(MESSAGE_COUNT);

      for (const record of ours) {
        const original = theirs.find(
          (row: any) => row.messageId === record.messageId,
        )!;

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
      const scheduler = standby.managers.sync.getScheduler(spaceTopicHash);

      scheduler.addProvider(primary.publicKey, [...storedIds, missingId]);
      scheduler.assign();

      await vi.waitFor(() => expect(scheduler.isComplete()).toBe(true));
      await factory.settle();

      // the provider reported the missing id right away
      const cancels = inboxOf(standby).of(
        EVENTS.NegentropyContentCancel,
        primary,
      );
      expect(cancels).toHaveLength(1);
      expect(cancels[0].message.payload.messageIds).toEqual([missingId]);

      expect(scheduler.isComplete()).toBe(true);
      expect(scheduler.providers.has(missingId)).toBe(false);
      expect(scheduler.penalties.has(primary.publicKey)).toBe(false);
      expect(
        await queryMessageRecord(standbyDB, { spaceId: standbySpaceId }),
      ).toHaveLength(MESSAGE_COUNT);
    });

    it('should quietly drop a payload for an unknown assignment', async () => {
      const [record] = await queryMessageRecord(primaryDB, {
        spaceId: primarySpaceId,
      });
      const payload = await createNegentropyContentDeliveryMessage({
        topic: spaceTopicHash,
        assignmentKey: hex(randomNonce()),
        content: toDeliverableMessage(record),
        publicKey: primary.publicKey,
        secretKey: primary.secretKey,
      });

      await deliverMessage(standby, primary, payload);
      await factory.settle();

      // no rejection: a late delivery is a normal race
      expect(inboxOf(primary).of(EVENTS.NegentropyContentCancel, standby)).toEqual([]);
      expect(inboxOf(primary).of(EVENTS.Reject, standby)).toEqual([]);
      expect(
        await queryMessageRecord(standbyDB, { spaceId: standbySpaceId }),
      ).toHaveLength(0);
    });

    it('should penalize and cancel a provider that forges a message', async () => {
      const scheduler = standby.managers.sync.getScheduler(spaceTopicHash);
      // the request is deliberately not routed: primary answers by hand
      scheduler.setRequestHandler(async () => {});
      scheduler.addProvider(primary.publicKey, storedIds.slice(0, 1));
      scheduler.assign();

      const { assignmentKey } = scheduler.assignments.get(primary.publicKey);
      const [record] = await queryMessageRecord(primaryDB, {
        spaceId: primarySpaceId,
        messageId: storedIds[0],
      });
      const forged = {
        ...toDeliverableMessage(record),
        signature: 'a'.repeat(128),
      };

      const payload = await createNegentropyContentDeliveryMessage({
        topic: spaceTopicHash,
        assignmentKey,
        content: forged,
        publicKey: primary.publicKey,
        secretKey: primary.secretKey,
      });

      await deliverMessage(standby, primary, payload);
      await factory.settle();

      expect(
        await queryMessageRecord(standbyDB, { spaceId: standbySpaceId }),
      ).toHaveLength(0);
      expect(scheduler.penalties.get(primary.publicKey)).toBe(1);

      // the requester told the provider to stop delivering the assignment
      const cancels = inboxOf(primary).of(EVENTS.NegentropyContentCancel, standby);
      expect(cancels).toHaveLength(1);
      expect(cancels[0].message.payload).toEqual({ assignmentKey });
    });

    it('should reject requests from a peer that cannot read the space', async () => {
      const request = await createNegentropyContentRequestMessage({
        topic: spaceTopicHash,
        assignmentKey: hex(randomNonce()),
        messageIds: storedIds,
        publicKey: outlier.publicKey,
        secretKey: outlier.secretKey,
      });

      await deliverMessage(primary, outlier, request);
      await factory.settle();

      const replies = inboxOf(outlier).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.reason).toBe(
        MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE,
      );
    });
  });
});
