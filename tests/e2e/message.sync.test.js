import * as EVENTS from '../../src/constants/events.constants.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { buildTestSpacePayload, cleanup, createP2PNetwork, getMockSocket, unframeJson } from '../general.utils.js';
import { createSpaceForPublicKey, getSpace, getSpaceTopicHash } from '../../src/utils/space.utils.js';
import { createMessageRecord, queryMessageRecord } from '../../src/utils/message.utils.js';
import { createSpaceMessage, encryptPayload } from '../../src/utils/protocol.utils.js';
import { hex, randomNonce } from '../../src/utils/crypto.utils.js';
import { now } from '../../src/utils/general.utils.js';

/**
 * In-memory network for end-to-end tests.
 *
 * Every direction of a link has its own mock socket, registered in the sender's socket
 * manager. Frames written to it are queued and handled one at a time (FIFO) by the
 * receiver's real message pipeline (`handleIncomingMessage`): size check, signature,
 * throttle, protocol handlers. Every handled frame is logged for assertions.
 */
class VirtualNetwork {
    constructor(topic) {
        this.topic = topic;
        /** @type {Array<{ from: Object, to: Object, raw: string }>} */
        this.queue = [];
        /** @type {Array<{ from: string, to: string, type: string, message: Object }>} */
        this.frames = [];
        /** `${from}>${to}` -> { socket, up } */
        this.links = new Map();
        this.nodes = new Set();
    }

    static linkKey(from, to) {
        return `${from.publicKey}>${to.publicKey}`;
    }

    /** Connects two nodes in both directions. */
    connect(a, b) {
        this.attach(a, b);
        this.attach(b, a);
    }

    /** @private */
    attach(from, to) {
        const socket = getMockSocket(`${from.name}>${to.name}`);
        const key = VirtualNetwork.linkKey(from, to);

        socket.write.mockImplementation(buffer => {
            if (this.links.get(key).up) {
                this.queue.push({ from, to, raw: unframeJson(buffer) });
            }
            return true;
        });

        from.manager.sockets.addSocket(socket, to.publicKey, [this.topic]);
        this.links.set(key, { socket, up: true });
        this.nodes.add(from);
        this.nodes.add(to);
    }

    /** The socket `from` uses to talk to `to`. */
    socketOf(from, to) {
        return this.links.get(VirtualNetwork.linkKey(from, to)).socket;
    }

    /** Cuts a link in both directions; frames still in flight are lost. */
    cut(a, b) {
        for (const [from, to] of [[a, b], [b, a]]) {
            const link = this.links.get(VirtualNetwork.linkKey(from, to));
            link.up = false;
            link.socket.destroyed = true;
        }

        this.queue = this.queue.filter(({ from, to }) =>
            !((from === a && to === b) || (from === b && to === a)));
    }

    /** @private */
    async deliverNext() {
        const { from, to, raw } = this.queue.shift();
        const message = JSON.parse(raw);
        this.frames.push({ from: from.name, to: to.name, type: message.type, message });

        // `to` receives the frame on its own socket towards `from`
        await to.manager.message.handleIncomingMessage(this.socketOf(to, from), raw, from.info);
    }

    /** True when nothing is queued and no node is serving a delivery. */
    isIdle() {
        if (this.queue.length > 0) return false;
        return Array.from(this.nodes).every(node => node.manager.sync.delivery.tasks.size === 0);
    }

    /**
     * Delivers frames until the network is quiet (or `until` returns true).
     * Background work (delivery tasks, scheduler requests) gets a few event-loop turns
     * to produce new frames before the network is considered quiet.
     * @param {Object} [options]
     * @param {() => boolean} [options.until] - Stop early once this returns true.
     * @param {number} [options.timeout=8000] - Fails if the network never settles.
     */
    async settle({ until = null, timeout = 8000 } = {}) {
        const deadline = Date.now() + timeout;
        let quietTurns = 0;

        while (quietTurns < 3) {
            if (Date.now() > deadline) throw new Error('network did not settle');

            if (this.queue.length > 0) {
                quietTurns = 0;
                await this.deliverNext();
                if (until?.()) return;
                continue;
            }

            await new Promise(resolve => setImmediate(resolve));
            quietTurns = this.isIdle() ? quietTurns + 1 : 0;
        }
    }

    /** Frames of a type, optionally on one directed link (by node name). */
    framesOf(type, { from = null, to = null } = {}) {
        return this.frames.filter(frame =>
            frame.type === type &&
            (from === null || frame.from === from) &&
            (to === null || frame.to === to));
    }

    /** Number of frames per directed link: { 'alice>bob': 123 } */
    countPerLink() {
        const counts = {};
        for (const { from, to } of this.frames) {
            counts[`${from}>${to}`] = (counts[`${from}>${to}`] ?? 0) + 1;
        }
        return counts;
    }
}

/**
 * Full message sync between in-memory nodes:
 * reconciliation (NegentropySync) -> scheduler assignments -> content requests ->
 * one-message deliveries -> verified, stored rows.
 *
 * The load stays below the throttle (`frequencyThrottle` frames per sender, counted over
 * the whole test, so the per-second window cannot trip) and the reconciliation limits.
 */
describe('Message sync (end-to-end)', () => {
    let nodes;
    let network;
    let topic;
    let spaceParams;
    /** node name -> { spaceId, space } */
    let spaces;

    const settings = node => node.manager.session.getMessageConfig();
    const dbOf = node => node.manager.session.getDatabase().db;

    /** Creates an authored space message (optionally encrypted with the space secret). */
    const authorMessage = async (author, index, { encrypted = false } = {}) => {
        const content = { text: `#${index} from ${author.name}: "quotes", \\ and 🍐`, index };

        if (!encrypted) {
            return createSpaceMessage({
                topic,
                messagePayload: content,
                publicKey: author.publicKey,
                secretKey: author.secretKey,
            });
        }

        const nonce = hex(randomNonce());
        const cipher = await encryptPayload({ payload: content, spaceSecret: spaces[author.name].space.secret, nonce });

        return createSpaceMessage({
            topic,
            messagePayload: cipher,
            publicKey: author.publicKey,
            secretKey: author.secretKey,
            nonce,
        });
    };

    /** Stores the same messages in the history of every given node. */
    const store = async (holders, messages) => {
        const ids = [];

        for (const message of messages) {
            for (const holder of holders) {
                const { messageId } = await createMessageRecord(dbOf(holder), {
                    message,
                    spaceId: spaces[holder.name].spaceId,
                    senderPublicKey: message.publicKey,
                    broadcastTimestamp: now(),
                });

                if (holder === holders[0]) ids.push(messageId);
            }
        }

        return ids;
    };

    /** `count` messages authored by `author`, every other one encrypted, stored at `holders`. */
    const seed = async (author, holders, count, offset = 0) => {
        const messages = [];
        for (let index = offset; index < offset + count; index++) {
            messages.push(await authorMessage(author, index, { encrypted: index % 2 === 1 }));
        }

        return store(holders, messages);
    };

    /** messageId -> row */
    const historyOf = async node => {
        const rows = await queryMessageRecord(dbOf(node), { spaceId: spaces[node.name].spaceId, limit: 1000 });
        return new Map(rows.map(row => [row.messageId, row]));
    };

    /** Both nodes hold the same messages, byte for byte. */
    const expectSameHistory = async (a, b) => {
        const historyA = await historyOf(a);
        const historyB = await historyOf(b);

        expect(Array.from(historyB.keys()).sort()).toEqual(Array.from(historyA.keys()).sort());

        for (const [messageId, row] of historyA) {
            const other = historyB.get(messageId);
            expect(other.payload).toBe(row.payload);
            expect(other.signature).toBe(row.signature);
            expect(other.nonce).toBe(row.nonce);
            expect(other.ownerPublicKey).toBe(row.ownerPublicKey);
            expect(other.messageTimestamp).toBe(row.messageTimestamp);
        }
    };

    /** The run never hit the throttle or the reconciliation limits, and nobody was rejected. */
    const expectWithinLimits = () => {
        const { frequencyThrottle, reconciliation } = settings(nodes[0]);

        expect(network.framesOf(EVENTS.Reject)).toEqual([]);

        for (const [link, count] of Object.entries(network.countPerLink())) {
            expect(count, `${link} sent ${count} frames`).toBeLessThan(frequencyThrottle);
        }

        const syncFrames = network.framesOf(EVENTS.NegentropySync);
        for (const frame of syncFrames) {
            expect(frame.message.payload.ranges.length).toBeLessThanOrEqual(reconciliation.maxRanges);
        }

        const roundsPerLink = {};
        for (const { from, to } of syncFrames) {
            roundsPerLink[`${from}>${to}`] = (roundsPerLink[`${from}>${to}`] ?? 0) + 1;
        }
        for (const rounds of Object.values(roundsPerLink)) {
            expect(rounds).toBeLessThanOrEqual(reconciliation.maxRounds);
        }
    };

    /** Message ids carried by the delivery frames sent to `to`. */
    const deliveredTo = to => network.framesOf(EVENTS.NegentropyContentDelivery, { to: to.name })
        .map(frame => frame.message.payload.content.nonce);

    beforeEach(async () => {
        nodes = await createP2PNetwork(3);
        ['alice', 'bob', 'carol'].forEach((name, index) => { nodes[index].name = name; });

        const keys = nodes.map(node => node.publicKey);
        spaceParams = await buildTestSpacePayload({
            spaceName: 'SyncSpace',
            permissionRead: 0,
            permissionBroadcast: 0,
            readWhitelist: keys,
            broadcastWhitelist: keys,
        });

        topic = getSpaceTopicHash(spaceParams);
        network = new VirtualNetwork(topic);
        spaces = {};

        for (const node of nodes) {
            const { spaceId } = await createSpaceForPublicKey(dbOf(node), spaceParams, node.secretKey);
            spaces[node.name] = { spaceId, space: await getSpace(dbOf(node), spaceId) };
        }
    });

    afterEach(async () => {
        for (const node of nodes) {
            await node.manager.sync.stop();

            const { sqlite } = node.manager.session.getDatabase();
            await sqlite.close();
            await cleanup(node.manager.root);
        }
    });

    it('should converge two peers with diverging histories', async () => {
        const [alice, bob] = nodes;
        network.connect(alice, bob);

        const shared = await seed(alice, [alice, bob], 40);
        const aliceOnly = await seed(alice, [alice], 100, 1000);
        const bobOnly = await seed(bob, [bob], 100, 2000);

        await alice.manager.sync.startSession(bob.publicKey, topic);
        await network.settle();

        await expectSameHistory(alice, bob);
        expect((await historyOf(alice)).size).toBe(shared.length + aliceOnly.length + bobOnly.length);

        // each missing message crossed the link exactly once
        expect(deliveredTo(bob)).toHaveLength(aliceOnly.length);
        expect(deliveredTo(alice)).toHaveLength(bobOnly.length);
        expect(new Set(deliveredTo(bob)).size).toBe(aliceOnly.length);

        for (const node of [alice, bob]) {
            expect(node.manager.sync.getScheduler(topic).isComplete()).toBe(true);
        }

        expectWithinLimits();
    });

    it('should do nothing on a second sync once peers are converged', async () => {
        const [alice, bob] = nodes;
        network.connect(alice, bob);

        await seed(alice, [alice], 60);
        await seed(bob, [bob], 60, 1000);

        await alice.manager.sync.startSession(bob.publicKey, topic);
        await network.settle();
        const framesOfFirstSync = network.frames.length;

        // a new session (e.g. after a reconnect)
        alice.manager.sync.sessions.clear();
        bob.manager.sync.sessions.clear();
        await alice.manager.sync.startSession(bob.publicKey, topic);
        await network.settle();

        const secondSync = network.frames.slice(framesOfFirstSync);
        expect(secondSync.length).toBeGreaterThan(0);
        expect(secondSync.every(frame => frame.type === EVENTS.NegentropySync)).toBe(true);
        expectWithinLimits();
    });

    it('should split a newcomer sync between two providers and deliver every message once', async () => {
        const [alice, bob, carol] = nodes;
        network.connect(carol, alice);
        network.connect(carol, bob);

        const history = [
            ...await seed(alice, [alice, bob], 100),
            ...await seed(bob, [alice, bob], 100, 1000),
        ];

        await carol.manager.sync.startSession(alice.publicKey, topic);
        await carol.manager.sync.startSession(bob.publicKey, topic);
        await network.settle();

        await expectSameHistory(alice, carol);
        await expectSameHistory(bob, carol);

        const delivered = deliveredTo(carol);
        expect(delivered).toHaveLength(history.length);
        expect(new Set(delivered).size).toBe(history.length);

        // both providers took a share of the work
        const fromAlice = network.framesOf(EVENTS.NegentropyContentDelivery, { from: 'alice', to: 'carol' }).length;
        const fromBob = network.framesOf(EVENTS.NegentropyContentDelivery, { from: 'bob', to: 'carol' }).length;
        expect(fromAlice).toBeGreaterThan(0);
        expect(fromBob).toBeGreaterThan(0);
        expect(fromAlice + fromBob).toBe(history.length);

        expect(carol.manager.sync.getScheduler(topic).isComplete()).toBe(true);
        expectWithinLimits();
    });

    it('should finish from the remaining provider when one disconnects mid-delivery', async () => {
        const [alice, bob, carol] = nodes;
        network.connect(carol, alice);
        network.connect(carol, bob);

        const history = await seed(alice, [alice, bob], 160);

        await carol.manager.sync.startSession(alice.publicKey, topic);
        await carol.manager.sync.startSession(bob.publicKey, topic);

        // run until bob has delivered something, then pull the plug
        await network.settle({
            until: () => network.framesOf(EVENTS.NegentropyContentDelivery, { from: 'bob' }).length > 0,
        });

        network.cut(carol, bob);
        carol.manager.sync.onDisconnect({ publicKey: bob.publicKey });
        bob.manager.sync.onDisconnect({ publicKey: carol.publicKey });

        await network.settle();

        await expectSameHistory(alice, carol);
        expect((await historyOf(carol)).size).toBe(history.length);

        const scheduler = carol.manager.sync.getScheduler(topic);
        expect(scheduler.isComplete()).toBe(true);
        // a disconnect is not misbehaviour
        expect(scheduler.penalties.has(bob.publicKey)).toBe(false);
        // bob's unfinished batch was picked up by alice
        expect(network.framesOf(EVENTS.NegentropyContentDelivery, { from: 'alice', to: 'carol' }).length)
            .toBeGreaterThan(128);

        expectWithinLimits();
    });
});
