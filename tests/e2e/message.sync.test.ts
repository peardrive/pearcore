// @ts-nocheck
import * as EVENTS from '../../src/constants/events.constants.js';
import * as MESSAGES from '../../src/constants/messages.constants.js';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { CoreFactory } from '../factory.js';
import { NegentropySyncManager } from '../../src/managers/negentropy/negentropy.manager.js';
import { getTopicToSpaceMap } from '../../src/utils/space.utils.js';
import {
  createMessageRecord,
  queryMessageRecord,
} from '../../src/utils/message.utils.js';
import {
  createSpaceMessage,
  encryptPayload,
} from '../../src/utils/protocol.utils.js';
import { hex, randomNonce } from '../../src/utils/crypto.utils.js';
import { now } from '../../src/utils/general.utils.js';

/**
 * Full message sync over the real transport:
 * space discovery -> reconciliation (NegentropySync) -> scheduler assignments ->
 * content requests -> one-message deliveries -> verified, stored rows.
 *
 * Every node is a real `CoreFactory` core: real account, database, managers and
 * Hyperswarm transport over a local bootstrap node. Only the transport is local,
 * so the suites assert what the protocol guarantees rather than its framing:
 * identical histories, exactly-once delivery, provider split, disconnect recovery,
 * no rejections and no throttling.
 */
describe('Message sync (end-to-end)', () => {
  let factory: CoreFactory;
  let cores: any[];
  let coreByName: Map<string, any>;
  /** Space topic hash shared by every node. */
  let topic: string;
  /** Space secret used for the encrypted messages. */
  let spaceSecret: string;
  /** core name -> local space id */
  let spaceIds: Map<string, number>;
  /** core name -> NegentropyContentDelivered contexts of the receiving core. */
  let deliveries: Map<string, any[]>;
  /** core name -> NegentropySyncComplete contexts. */
  let syncCompletes: Map<string, any[]>;
  /** core name -> Reject contexts. */
  let rejections: Map<string, any[]>;
  /** nonce -> type of every message a core sent during the sync phase. */
  let sentTypes: Map<string, string>;

  const dbOf = (core: any) => core.managers.session.getDatabase().db;
  const spaceIdOf = (core: any) => spaceIds.get(core.name)!;
  const deliveredTo = (core: any) => deliveries.get(core.name)!;
  const deliveredIds = (core: any) =>
    deliveredTo(core).map((entry) => entry.messageId);

  /** provider public key -> number of messages it delivered to `core`. */
  const providerCounts = (core: any) => {
    const counts: Record<string, number> = {};
    for (const { publicKey } of deliveredTo(core)) {
      counts[publicKey] = (counts[publicKey] ?? 0) + 1;
    }
    return counts;
  };

  /** Sessions that are still reconciling plus running delivery tasks. */
  const pendingSync = (core: any) =>
    [...core.managers.sync.sessions.values()].filter(
      (session: any) => !session.sync.isDone,
    ).length + core.managers.sync.delivery.tasks.size;

  const waitForQuiet = async (list: any[], timeout = 60000) => {
    await vi.waitFor(
      () => {
        for (const core of list) {
          expect(pendingSync(core), `${core.name} is still syncing`).toBe(0);
        }
      },
      { timeout, interval: 100 },
    );
  };

  const historyOf = async (core: any) => {
    const rows = await queryMessageRecord(dbOf(core), {
      spaceId: spaceIdOf(core),
      limit: 1000,
    });
    return new Map(rows.map((row: any) => [row.messageId, row]));
  };

  const waitForHistory = async (core: any, size: number, timeout = 90000) => {
    await vi.waitFor(
      async () => {
        expect((await historyOf(core)).size).toBe(size);
      },
      { timeout, interval: 250 },
    );
  };

  /** Both nodes hold the same messages, byte for byte. */
  const expectSameHistory = async (a: any, b: any) => {
    const historyA = await historyOf(a);
    const historyB = await historyOf(b);

    expect(Array.from(historyB.keys()).sort()).toEqual(
      Array.from(historyA.keys()).sort(),
    );

    for (const [messageId, row] of historyA) {
      const other = historyB.get(messageId);
      expect(other.payload).toBe(row.payload);
      expect(other.signature).toBe(row.signature);
      expect(other.nonce).toBe(row.nonce);
      expect(other.ownerPublicKey).toBe(row.ownerPublicKey);
      expect(other.messageTimestamp).toBe(row.messageTimestamp);
    }
  };

  const expectWithinLimits = (list: any[]) => {
    for (const core of list) {
      // a space record can be relayed more than once while peers are discovering each
      // other; a duplicate space message is rejected deterministically. Message sync
      // itself must never be rejected.
      const syncRejections = rejections
        .get(core.name)!
        .filter((context) =>
          sentTypes.get(context.linkedMessageNonce)?.startsWith('Negentropy'),
        );
      expect(
        syncRejections,
        `${core.name} had a sync message rejected`,
      ).toEqual([]);

      for (const context of rejections.get(core.name)!) {
        expect(
          context.message.payload.reason,
          `${core.name} hit the message rate limit`,
        ).not.toBe(MESSAGES.MESSAGE_RATE_LIMIT_EXCEEDED);
      }

      for (const [peer, record] of Object.entries(
        core.managers.throttle.getSnapShot(),
      )) {
        expect(
          (record as any).isThrottled,
          `${core.name} throttled ${peer}`,
        ).toBe(false);
      }
    }
  };

  const recordEvents = (core: any) => {
    const name = core.name;

    deliveries.set(name, []);
    syncCompletes.set(name, []);
    rejections.set(name, []);

    core.emitter.on(EVENTS.NegentropyContentDelivered, (context: any) =>
      deliveries.get(name)!.push(context),
    );
    core.emitter.on(EVENTS.NegentropySyncComplete, (context: any) =>
      syncCompletes.get(name)!.push(context),
    );
    core.emitter.on(EVENTS.Reject, (context: any) =>
      rejections.get(name)!.push(context),
    );
  };

  /**
   * The space handshake relays space records between peers; space messages carry a
   * deterministic nonce, so a relayed copy can legitimately be rejected as a duplicate.
   * Message sync starts after the handshake, so rejections are only asserted from here on.
   */
  const beginSyncPhase = () => {
    for (const list of rejections.values()) list.length = 0;
  };

  /**
   * Creates `count` authenticated cores that join the same space. Peers discover
   * each other through the space topic, so no connection is dialed twice.
   */
  const setup = async (count: number) => {
    factory = new CoreFactory();
    await factory.init();

    cores = await factory.createMultipleCores(count);
    const names = count === 2 ? ['alice', 'bob'] : ['alice', 'bob', 'carol'];
    cores.forEach((core, index) => {
      core.name = names[index];
    });
    coreByName = new Map(cores.map((core) => [core.name, core]));

    deliveries = new Map();
    syncCompletes = new Map();
    rejections = new Map();
    sentTypes = new Map();
    for (const core of cores) {
      recordEvents(core);

      const manager = core.managers.message;
      const original = manager.sendMessageToSocket.bind(manager);
      manager.sendMessageToSocket = (message: any, socket: any) => {
        sentTypes.set(message.nonce, message.type);
        return original(message, socket);
      };
    }

    const [primary] = cores;
    const keys = cores.map((core) => core.publicKey);

    const space = await primary.space.create({
      spaceName: 'SyncSpace',
      permissionRead: 0,
      permissionBroadcast: 0,
      readWhitelist: keys,
      broadcastWhitelist: keys,
    });

    topic = space.topicHash;
    spaceSecret = space.secret;

    for (const core of cores.slice(1)) {
      await core.space.join(space.sharelink);
    }

    // peers find each other through the space topic (real discovery): dialing the
    // same peer twice would open two connections and duplicate deterministically
    // nonced handshake messages

    // the newcomer learns the space from the creator (sharelink -> space record)
    await vi.waitFor(
      async () => {
        for (const core of cores) {
          const map = await getTopicToSpaceMap(dbOf(core));
          expect(map.has(topic), `${core.name} has no space record`).toBe(true);
        }
      },
      { timeout: 30000, interval: 200 },
    );

    // every pair must have both directions up, handshake included
    await vi.waitFor(
      () => {
        for (const core of cores) {
          for (const peer of cores) {
            if (peer === core) continue;

            const sockets = core.managers.sockets.getConnectedSockets({
              peers: [peer.publicKey],
            });
            expect(
              sockets.length,
              `${core.name} is not connected to ${peer.name}`,
            ).toBeGreaterThan(0);

            const info = core.managers.sockets.getPeerInfoBySocket(sockets[0]);
            expect(
              info.topics,
              `${core.name} and ${peer.name} did not handshake`,
            ).toContain(topic);
          }
        }
      },
      { timeout: 60000, interval: 200 },
    );

    spaceIds = new Map();
    for (const core of cores) {
      const map = await getTopicToSpaceMap(dbOf(core));
      spaceIds.set(core.name, map.get(topic)!);
    }

    // let the space handshake (and the empty first exchange) finish
    await waitForQuiet(cores);
  };

  /**
   * Starts a fresh reconciliation between two peers, as a reconnect would: the
   * finished session of the pair is dropped on both sides first.
   */
  const startSync = async (from: any, to: any) => {
    for (const [core, peer] of [
      [from, to],
      [to, from],
    ]) {
      core.managers.sync.sessions.delete(
        NegentropySyncManager.sessionKey(peer.publicKey, topic),
      );
    }

    const session = await from.managers.sync.startSession(to.publicKey, topic);
    expect(session, `${from.name} could not start a session`).not.toBeNull();
    return session;
  };

  /** Creates an authored space message (optionally encrypted with the space secret). */
  const authorMessage = async (
    author: any,
    index: number,
    { encrypted = false } = {},
  ) => {
    const content = {
      text: `#${index} from ${author.name}: "quotes", \\ and 🍐`,
      index,
    };

    if (!encrypted) {
      return createSpaceMessage({
        topic,
        messagePayload: content,
        publicKey: author.publicKey,
        secretKey: author.secretKey,
      });
    }

    const nonce = hex(randomNonce());
    const cipher = await encryptPayload({
      payload: content,
      spaceSecret: spaceSecret,
      nonce,
    });

    return createSpaceMessage({
      topic,
      messagePayload: cipher,
      publicKey: author.publicKey,
      secretKey: author.secretKey,
      nonce,
    });
  };

  /** Stores the same messages in the history of every given node. */
  const store = async (holders: any[], messages: any[]) => {
    const ids = [];

    for (const message of messages) {
      for (const holder of holders) {
        const { messageId } = await createMessageRecord(dbOf(holder), {
          message,
          spaceId: spaceIdOf(holder),
          senderPublicKey: message.publicKey,
          broadcastTimestamp: now(),
        });

        if (holder === holders[0]) ids.push(messageId);
      }
    }

    return ids;
  };

  /** `count` messages authored by `author`, every other one encrypted, stored at `holders`. */
  const seed = async (
    author: any,
    holders: any[],
    count: number,
    offset = 0,
  ) => {
    const messages = [];
    for (let index = offset; index < offset + count; index++) {
      messages.push(
        await authorMessage(author, index, { encrypted: index % 2 === 1 }),
      );
    }

    return store(holders, messages);
  };

  afterEach(async () => {
    await factory?.cleanup();
  });

  it(
    'should converge two peers with diverging histories',
    async () => {
      await setup(2);
      beginSyncPhase();
      const alice = coreByName.get('alice');
      const bob = coreByName.get('bob');

      const shared = await seed(alice, [alice, bob], 40);
      const aliceOnly = await seed(alice, [alice], 100, 1000);
      const bobOnly = await seed(bob, [bob], 100, 2000);

      await startSync(alice, bob);

      const total = shared.length + aliceOnly.length + bobOnly.length;
      await waitForHistory(bob, total);
      await waitForHistory(alice, total);
      await waitForQuiet([alice, bob]);

      await expectSameHistory(alice, bob);

      // each message crossed the link exactly once
      expect(deliveredTo(bob)).toHaveLength(aliceOnly.length);
      expect(new Set(deliveredIds(bob)).size).toBe(aliceOnly.length);
      expect(
        deliveredTo(bob).every((entry) => entry.publicKey === alice.publicKey),
      ).toBe(true);

      expect(deliveredTo(alice)).toHaveLength(bobOnly.length);
      expect(new Set(deliveredIds(alice)).size).toBe(bobOnly.length);
      expect(
        deliveredTo(alice).every((entry) => entry.publicKey === bob.publicKey),
      ).toBe(true);

      expect(alice.managers.sync.getScheduler(topic).isComplete()).toBe(true);
      expect(bob.managers.sync.getScheduler(topic).isComplete()).toBe(true);
      expectWithinLimits([alice, bob]);
    },
    120_000,
  );

  it(
    'should do nothing on a second sync once peers are converged',
    async () => {
      await setup(2);
      beginSyncPhase();
      const alice = coreByName.get('alice');
      const bob = coreByName.get('bob');

      await seed(alice, [alice], 60);
      await seed(bob, [bob], 60, 1000);

      await startSync(alice, bob);
      await waitForHistory(alice, 120);
      await waitForHistory(bob, 120);
      await waitForQuiet([alice, bob]);

      const firstRoundDeliveries =
        deliveredTo(alice).length + deliveredTo(bob).length;
      expect(firstRoundDeliveries).toBe(120);

      const completesBefore = new Map(
        [alice, bob].map((core) => [
          core.name,
          syncCompletes.get(core.name)!.length,
        ]),
      );
      const completeCount = () =>
        syncCompletes.get('alice')!.length + syncCompletes.get('bob')!.length;
      const completesBeforeTotal = completeCount();

      // a new session (e.g. after a reconnect)
      await startSync(bob, alice);

      await vi.waitFor(
        () => {
          expect(completeCount()).toBeGreaterThan(completesBeforeTotal);
        },
        { timeout: 30000, interval: 100 },
      );

      await waitForQuiet([alice, bob]);

      // the session ran, found nothing to exchange and delivered nothing
      const newCompletes = [alice, bob].flatMap((core) =>
        syncCompletes
          .get(core.name)!
          .slice(completesBefore.get(core.name)),
      );
      expect(newCompletes.length).toBeGreaterThan(0);
      for (const context of newCompletes) {
        expect(context.need).toEqual([]);
      }

      expect(
        deliveredTo(alice).length + deliveredTo(bob).length,
      ).toBe(firstRoundDeliveries);
      expect((await historyOf(alice)).size).toBe(120);
      expect((await historyOf(bob)).size).toBe(120);
      await expectSameHistory(alice, bob);
      expectWithinLimits([alice, bob]);
    },
    120_000,
  );

  it(
    'should split a newcomer sync between two providers and deliver every message once',
    async () => {
      await setup(3);
      beginSyncPhase();
      const alice = coreByName.get('alice');
      const bob = coreByName.get('bob');
      const carol = coreByName.get('carol');

      const history = [
        ...(await seed(alice, [alice, bob], 100)),
        ...(await seed(bob, [alice, bob], 100, 1000)),
      ];

      await startSync(carol, alice);
      await startSync(carol, bob);

      await waitForHistory(carol, history.length);
      await waitForQuiet([alice, bob, carol]);

      await expectSameHistory(alice, carol);
      await expectSameHistory(bob, carol);

      // every message crossed exactly once
      expect(deliveredTo(carol)).toHaveLength(history.length);
      expect(new Set(deliveredIds(carol)).size).toBe(history.length);

      // both providers took a share of the work
      const counts = providerCounts(carol);
      expect(counts[alice.publicKey]).toBeGreaterThan(0);
      expect(counts[bob.publicKey]).toBeGreaterThan(0);
      expect(
        (counts[alice.publicKey] ?? 0) + (counts[bob.publicKey] ?? 0),
      ).toBe(history.length);

      expect(carol.managers.sync.getScheduler(topic).isComplete()).toBe(true);
      expectWithinLimits([alice, bob, carol]);
    },
    180_000,
  );

  it(
    'should finish from the remaining provider when one disconnects mid-delivery',
    async () => {
      await setup(3);
      beginSyncPhase();
      const alice = coreByName.get('alice');
      const bob = coreByName.get('bob');
      const carol = coreByName.get('carol');

      const history = await seed(alice, [alice, bob], 160);

      // the link must not come back: stop discovery before cutting the socket
      await carol.managers.connection.leave(topic);
      await bob.managers.connection.leave(topic);

      // cut the link on bob's first delivery, i.e. in the middle of his batch
      let cut = false;
      const cutOnDelivery = (context: any) => {
        if (cut || context.publicKey !== bob.publicKey) return;

        cut = true;
        carol.emitter.off(EVENTS.NegentropyContentDelivered, cutOnDelivery);

        const [socket] = carol.managers.sockets.getConnectedSockets({
          peers: [bob.publicKey],
        });
        if (socket) carol.managers.sockets.removeSocket(socket);
      };
      carol.emitter.on(EVENTS.NegentropyContentDelivered, cutOnDelivery);

      await startSync(carol, alice);
      await startSync(carol, bob);

      await vi.waitFor(() => expect(cut).toBe(true), {
        timeout: 90000,
        interval: 50,
      });

      await waitForHistory(carol, history.length);
      await waitForQuiet([alice, bob, carol]);

      await expectSameHistory(alice, carol);
      expect(new Set(deliveredIds(carol)).size).toBe(history.length);

      // bob was interrupted mid-batch; alice served the remainder
      const counts = providerCounts(carol);
      expect(counts[bob.publicKey]).toBeGreaterThan(0);
      expect(counts[bob.publicKey]).toBeLessThan(history.length);
      expect(counts[alice.publicKey]).toBeGreaterThan(0);

      const scheduler = carol.managers.sync.getScheduler(topic);
      expect(scheduler.isComplete()).toBe(true);
      // a disconnect is not misbehaviour
      expect(scheduler.penalties.has(bob.publicKey)).toBe(false);

      expectWithinLimits([alice, bob, carol]);
    },
    180_000,
  );
});
