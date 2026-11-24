// @ts-nocheck
import * as EVENTS from '../../../../src/constants/events.constants.js';
import * as MESSAGES from '../../../../src/constants/messages.constants.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestSpacePayload } from '../../../helpers/general.utils.js';
import { MockCoreFactory } from '../../../helpers/mock.factory.js';
import {
  collectMessages,
  connectProtocolNodes,
  deliverMessage,
} from '../../../helpers/protocol.utils.js';
import {
  createSpaceHashListMessage,
  createSpaceSyncMessage,
} from '../../../../src/utils/protocol.utils.js';
import {
  createSpaceForPublicKey,
  getSpace,
  getSpaceTopicHash,
  getTopicToSpaceMap,
  updateSpaceForPublicKey,
  upsertSpace,
} from '../../../../src/utils/space.utils.js';
import { SpaceSyncHandler } from '../../../../src/protocols/space/sync.handler.js';
import { now, stripIds } from '../../../../src/utils/general.utils.js';
import { hex, randomNonce } from '../../../../src/utils/crypto.utils.js';
import { saveShareLink } from '../../../../src/utils/sharelink.utils.js';
import type { SpaceInput } from '../../../../src/utils/space.utils.js';

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
 * The nodes run on the in-memory peer network. Messages are injected over the
 * real link and every reply is observed as the protocol message the peer
 * receives (`EVENTS.General`), not as a socket buffer.
 */
describe('Space Protocols', () => {
  let factory: MockCoreFactory;
  let cores: any[] = [];
  let primary: any;
  let primaryDB: any;
  let secondary: any;
  let secondaryDB: any;
  let standby: any;
  let standbyDB: any;
  let outlier: any;
  let outlierDB: any;
  let spaceParams: Awaited<ReturnType<typeof buildTestSpacePayload>>;
  let spaceTopicHash: string;
  let inboxes: Map<string, ReturnType<typeof collectMessages>>;

  const inboxOf = (core: any) => inboxes.get(core.name)!;

  /** Local space id of the shared space in a node's database. */
  const spaceIdIn = async (db: any) =>
    (await getTopicToSpaceMap(db)).get(spaceTopicHash);

  /** Expects that the database holds exactly the given space row. */
  const expectConverged = async (db: any, expected: any) => {
    const spaceId = await spaceIdIn(db);
    expect(spaceId).toBeDefined();
    expect(stripIds(await getExistingSpace(db, spaceId!))).toEqual(
      stripIds(expected),
    );
  };

  /** Attaches the message collectors of every core. */
  const collect = () => {
    inboxes = new Map(cores.map((core) => [core.name, collectMessages(core)]));
  };

  /** Records the SpaceSync actions each core observes. */
  const recordActions = () => {
    const actions: Record<string, string[]> = {};
    for (const core of cores) {
      actions[core.name] = [];
      core.emitter.on(EVENTS.SpaceSync, ({ action }: any) =>
        actions[core.name].push(action),
      );
    }
    return actions;
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
    outlierDB = outlier.managers.session.getDatabase().db;
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  describe('SpaceHashListHandler', () => {
    /** Connects the nodes before any space exists, so the handshake is a no-op. */
    const connectEmpty = async () => {
      await connectProtocolNodes(factory, spaceTopicHash, cores);
      collect();
    };

    it('should exist within the protocol map', () => {
      expect(
        primary.managers.message.protocolHandlers.has(EVENTS.SpaceHashList),
      ).toBe(true);
    });

    it('should handle valid SpaceHashList message', async () => {
      await connectEmpty();

      const message = await createSpaceHashListMessage({
        hashList: [spaceTopicHash],
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      let eventContext: unknown = null;
      primary.emitter.on(
        EVENTS.SpaceHashList,
        ({ message }: { message: unknown }) => {
          eventContext = message;
        },
      );

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      // the sender's socket record now carries the announced topics
      const socketState = primary.managers.sockets.getSnapShot({
        sortByPeers: true,
      });
      expect(socketState[secondary.publicKey]).toEqual([spaceTopicHash]);
      expect(eventContext).toEqual(message);

      // no reply: primary knows no spaces yet
      expect(inboxOf(secondary).of(EVENTS.SpaceSync, primary)).toEqual([]);
    });

    it('should handle repeated SpaceHashList topic updates', async () => {
      await connectEmpty();

      const message = await createSpaceHashListMessage({
        hashList: [spaceTopicHash],
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      expect(
        primary.managers.sockets.getSnapShot({ sortByPeers: true })[
          secondary.publicKey
        ],
      ).toEqual([spaceTopicHash]);

      const secondSpaceTopicHash = 'b'.repeat(64);
      const secondaryMessage = await createSpaceHashListMessage({
        hashList: [secondSpaceTopicHash], //different topic
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, secondaryMessage);
      await factory.settle();

      expect(
        primary.managers.sockets.getSnapShot({ sortByPeers: true })[
          secondary.publicKey
        ],
      ).toEqual([secondSpaceTopicHash]);
      expect(inboxOf(secondary).of(EVENTS.SpaceSync, primary)).toEqual([]);
    });

    it('should reject invalid spaceHashList message', async () => {
      await connectEmpty();

      const message = await createSpaceHashListMessage({
        hashList: { data: 123 } as never, // non-Array hash list
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const replies = inboxOf(secondary).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.topic).toEqual(EVENTS.noTopic);
      expect(replies[0].message.payload.linkedMessageNonce).toEqual(
        message.nonce,
      );
      expect(replies[0].message.payload.reason).toEqual(
        'SpaceHashList payload should be an array',
      );
    });

    it('should reject relayed spaceHashList message', async () => {
      await connectEmpty();

      // the link is secondary -> primary, but the message claims to be from primary
      const message = await createSpaceHashListMessage({
        hashList: [spaceTopicHash],
        publicKey: primary.publicKey,
        secretKey: primary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const replies = inboxOf(secondary).of(EVENTS.Reject, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload.linkedMessageNonce).toEqual(
        message.nonce,
      );
      expect(replies[0].message.payload.reason).toEqual(
        MESSAGES.NO_RELAY_MESSAGE,
      );
    });

    it('should send back SpaceSync message for common space topic', async () => {
      await connectEmpty();

      const { spaceId } = await createSpaceForPublicKey(
        primaryDB,
        {
          spaceName: 'test',
          publicKey: primary.publicKey,
        } as never,
        primary.secretKey,
      );

      const space = await getExistingSpace(primaryDB, spaceId);
      const topicHash = getSpaceTopicHash(space);
      const message = await createSpaceHashListMessage({
        hashList: [topicHash],
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      });

      await deliverMessage(primary, secondary, message);
      await factory.settle();

      const replies = inboxOf(secondary).of(EVENTS.SpaceSync, primary);
      expect(replies).toHaveLength(1);
      expect(replies[0].message.payload).toEqual(stripIds(space));
    });
  });

  describe('SpaceSyncHandler', () => {
    let newerSpaceParams: Pick<
      SpaceInput,
      'spaceName' | 'publicKey' | 'nonce' | 'timestamp'
    >;

    /**
     * Builds a SpaceSync message with a random nonce.
     *
     * `createSpaceSyncMessage` derives its nonce from the space payload, so two
     * peers that know the same space produce the same nonce; a node that already
     * sent that message then rejects the mirror copy as a duplicate. Injecting a
     * message with its own nonce is how a handler branch that the handshake would
     * filter out can still be observed.
     */
    const syncMessage = (space: any, from: any) =>
      createSpaceSyncMessage({
        topic: getSpaceTopicHash(space),
        space: stripIds(space),
        nonce: hex(randomNonce()),
        publicKey: from.publicKey,
        secretKey: from.secretKey,
      });

    /** Connects the nodes before any space exists, so the handshake is a no-op. */
    const connectEmpty = async () => {
      await connectProtocolNodes(factory, spaceTopicHash, cores);
      collect();
    };

    beforeEach(() => {
      newerSpaceParams = {
        spaceName: spaceParams.spaceName,
        publicKey: spaceParams.publicKey,
        nonce: spaceParams.nonce,
        timestamp: now(), // newer space timestamp
      };
    });

    it('should handle FIRST_ENCOUNTER space sync scenario', async () => {
      const { spaceId } = await createSpaceForPublicKey(
        primaryDB,
        spaceParams,
        primary.secretKey,
      );
      const space = await getExistingSpace(primaryDB, spaceId);
      // both receivers know the space only through a sharelink
      await saveShareLink(secondaryDB, spaceParams);
      await saveShareLink(standbyDB, spaceParams);

      const actions = recordActions();
      collect();

      // the handshake announcement converts the sharelinks into space records
      await connectProtocolNodes(factory, spaceTopicHash, cores);

      await expectConverged(secondaryDB, space);
      await expectConverged(standbyDB, space);

      expect(actions.secondary).toContain(
        SpaceSyncHandler.STATES.FIRST_ENCOUNTER,
      );
      expect(actions.standby).toContain(SpaceSyncHandler.STATES.FIRST_ENCOUNTER);

      // the outlier never learns about the space
      await factory.settle();
      expect(await spaceIdIn(outlierDB)).toBeUndefined();
      expect(inboxOf(outlier).of(EVENTS.SpaceSync)).toEqual([]);
    });

    it('should reconcile diverging copies and relay the winner', async () => {
      const { spaceId } = await createSpaceForPublicKey(
        primaryDB,
        spaceParams,
        primary.secretKey,
      );
      const space = await getExistingSpace(primaryDB, spaceId);

      // both readers hold the older copy, the owner holds the updated one
      await upsertSpace(secondaryDB, space as never);
      await upsertSpace(standbyDB, space as never);
      await updateSpaceForPublicKey(
        primaryDB,
        spaceId,
        { ...space, ...newerSpaceParams },
        primary.secretKey,
      );

      const updatedSpace = await getExistingSpace(primaryDB, spaceId);

      const actions = recordActions();
      collect();

      await connectProtocolNodes(factory, spaceTopicHash, cores);

      // the owner learns from the stale announcement, the stale peers learn from
      // the owner and then relay the newer copy onwards
      expect(actions.primary).toContain(
        SpaceSyncHandler.STATES.PEER_REQUIRE_UPDATE,
      );
      expect(actions.secondary).toContain(
        SpaceSyncHandler.STATES.LOCAL_SPACE_REQUIRE_UPDATE,
      );

      await expectConverged(secondaryDB, updatedSpace);
      await expectConverged(standbyDB, updatedSpace);

      // the other reader was told about the newer copy (directly by the owner or
      // relayed by the peer that just adopted it)
      const announcements = inboxOf(standby).of(EVENTS.SpaceSync);
      expect(announcements.length).toBeGreaterThan(0);
      expect(announcements[0].message.payload).toEqual(stripIds(updatedSpace));

      // the outlier never learns about the space
      await factory.settle();
      expect(await spaceIdIn(outlierDB)).toBeUndefined();
      expect(inboxOf(outlier).of(EVENTS.SpaceSync)).toEqual([]);
    });

    it('should handle INDENTICAL space sync scenario', async () => {
      const { spaceId } = await createSpaceForPublicKey(
        primaryDB,
        spaceParams,
        primary.secretKey,
      );
      const space = await getExistingSpace(primaryDB, spaceId);

      // the second node already holds the same record
      await upsertSpace(secondaryDB, space as never);

      const actions = recordActions();
      collect();

      // both peers announce the topic, so their space-sync mirrors are dropped by
      // the duplicate nonce check; the identical branch is therefore exercised
      // with an explicitly injected message that carries its own nonce
      await connectProtocolNodes(factory, spaceTopicHash, cores);
      const message = await syncMessage(space, primary);
      await deliverMessage(secondary, primary, message);
      await factory.settle();

      expect(actions.secondary).toContain(SpaceSyncHandler.STATES.IDENTICAL);

      // identical spaces produce no broadcast and change nothing
      await expectConverged(secondaryDB, space);
      expect(await spaceIdIn(standbyDB)).toBeUndefined();
      expect(await spaceIdIn(outlierDB)).toBeUndefined();
      expect(inboxOf(standby).of(EVENTS.SpaceSync)).toEqual([]);
      expect(inboxOf(outlier).of(EVENTS.SpaceSync)).toEqual([]);
    });
  });
});
