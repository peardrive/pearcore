import { describe, it, beforeEach, afterEach, expect, vi } from "vitest";
import * as EVENTS from '../../src/constants/events.constants.js';

import { createBaseMessage, createSpaceMessage } from "../../src/utils/protocol.utils.js";
import { createSpaceForPublicKey, getSpace, getSpaceTopicHash, getTopicToSpaceMap, upsertSpace } from "../../src/utils/space.utils.js";
import { hash, hex, randomNonce } from "../../src/utils/crypto.utils.js";
import { buildTestSpacePayload, cleanup, createConnections, createP2PNetwork, unframeJson } from "../general.utils.js";
import { SessionManager } from "../../src/managers/session.manager.js";
import { MessageRequestScheduler } from "../../src/managers/negentropy/components/scheduler.js";
import { SpaceSyncHandler } from "../../src/protocols/space.protocol.js";
import {
    NegentropySync,
    NegentropySyncError,
    NegentropyRole,
    NegentropyStates,
} from "../../src/managers/negentropy/components/sync.js";
import {
    computeRangeFingerprint,
    createMessageRecord,
    flushMessageRecords,
    isReconciliationInitiator,
    iterateRangeKeys,
} from "../../src/utils/message.utils.js";


const Mode = EVENTS.NegentropyModeOptions;
const BASE_TIMESTAMP = 1_700_000_000_000;
const ZERO_FINGERPRINT = '0'.repeat(32);

// small values keep the data sets small while still exercising every code path
const TEST_RECONCILIATION_CONFIG = {
    idListThreshold: 8,
    bucketCount: 4,
    maxRanges: 1024,
    maxRounds: 64,
};

const resetSessionForNode = node => {
    node.manager.session.session.set('messaging.reconciliation',
        { ...TEST_RECONCILIATION_CONFIG }
    );
};

/**
 * Creates signed space messages owned by the node.
 * Three consecutive messages share a timestamp so the `(timestamp, messageId)`
 * tie-breaking is always exercised.
 */
const createMessages = async (node, topic, count, offset = 0) => {
    const list = [];

    for (let index = 0; index < count; index++) {
        const position = offset + index;

        const nonce = hex(randomNonce());
        const message = await createSpaceMessage({
            type: EVENTS.SpaceMessage,
            topic: topic,
            nonce: nonce,
            timestamp: BASE_TIMESTAMP + Math.floor(position / 3) * 1000,
            messagePayload: { text: `message #${position}` },
            publicKey: node.publicKey,
            secretKey: node.secretKey,
        });

        list.push(message);
    }
    return list;
};

/**
 * Stores messages into the space history, returns their message IDs. 
*/
const storeMessages = async (db, spaceId, list) => {
    const messageIds = [];

    for (const message of list) {
        const record = await createMessageRecord(db, {
            message: message,
            spaceId: spaceId,
            senderPublicKey: message.publicKey,
            broadcastTimestamp: message.timestamp,
        });

        messageIds.push(record.messageId);
    }
    return messageIds;
};

/**
 * Returns the stored `{ timestamp, messageId }` keys of a space in protocol order.
*/
const listMessageIDs = async (db, spaceId) => {
    const keys = [];

    for await (const batch of iterateRangeKeys(db, { spaceId })) {
        keys.push(...batch);
    }

    return keys;
};

/**
 * return array of message IDs from message record query
 * @param {Array<{ messageId: string }>} keys 
 * @returns {Array<string>}
 */
const idsOf = (keys) => keys.map(key => key.messageId);

/**
 * @param {Iterable} iterable 
 * @returns {Array}
 */
const sorted = (iterable) => [...iterable].sort();

/**
 *  Drives a full exchange between two sync instances through a simulated wire (JSON round-trip).
 */
const runSync = async (initiator, responder, { onRound, maxIterations = 200 } = {}) => {
    const transcript = [];
    let message = await initiator.initiate();
    let receiver = responder;

    while (message) {
        const wire = JSON.stringify(message);
        transcript.push(JSON.parse(wire));

        message = await receiver.reconcile(JSON.parse(wire));
        receiver = receiver === responder ? initiator : responder;

        if (onRound) await onRound(transcript.length);
        if (transcript.length > maxIterations) {
            throw new Error(`runSync() failed due to exceeding maximum allowed iterations (${maxIterations})`);
        }
    }

    return transcript;
};

describe('NegentropySync', () => {
    let primary = null;
    let primaryDB = null;
    let primarySpaceId = null;
    let secondary = null;
    let secondaryDB = null;
    let secondarySpaceId = null;
    let spaceTopicHash = null;
    let history = [];

    // create fresh instance
    const createSync = (node, spaceId, role, params = {}) => new NegentropySync({
        session: node.manager.session,
        spaceId: spaceId,
        topic: spaceTopicHash,
        role: role,
        ...params,
    });

    beforeEach(async () => {
        const nodes = await createP2PNetwork(2);
        primary = nodes[0];
        secondary = nodes[1];

        primaryDB = primary.manager.session.getDatabase().db;
        secondaryDB = secondary.manager.session.getDatabase().db;

        for (const node of [primary, secondary]) {
            node.manager.session.session.set('messaging.reconciliation', { ...TEST_RECONCILIATION_CONFIG });
        }

        // both peers are members of the same space (local space IDs may differ)
        const spaceParams = await buildTestSpacePayload({
            spaceName: 'NegentropySpace',
            publicKey: primary.publicKey,
            permissionRead: 0,
            permissionBroadcast: 0,
            readWhitelist: [primary.publicKey, secondary.publicKey],
            broadcastWhitelist: [primary.publicKey, secondary.publicKey],
        });

        const { spaceId } = await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
        primarySpaceId = spaceId;

        const space = await getSpace(primaryDB, primarySpaceId);

        const secondarySpaceRecord = await upsertSpace(secondaryDB, space);
        secondarySpaceId = secondarySpaceRecord.spaceId;

        spaceTopicHash = getSpaceTopicHash(spaceParams);
        history = await createMessages(primary, spaceTopicHash, 60);
    });

    afterEach(async () => {
        for (const node of [primary, secondary]) {
            const { sqlite } = node.manager.session.getDatabase();

            await sqlite.close();
            await cleanup(node.manager.root);
        }
    });

    describe('init', () => {
        it('should take a snapshot of 0 for an empty space', async () => {
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);

            expect(await sync.init()).toBe(0);
            expect(sync.snapshotRowId).toBe(0);
        });

        it('should freeze the snapshot on the first call', async () => {
            await storeMessages(primaryDB, primarySpaceId, history.slice(0, 5));
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);

            const snapshot = await sync.init();
            expect(snapshot).toBeGreaterThan(0);

            await storeMessages(primaryDB, primarySpaceId, history.slice(5, 10));
            expect(await sync.init()).toBe(snapshot);
        });
    });

    describe('createRangeQueryPayload', () => {
        it('should bind the range to the space, snapshot and batch size', async () => {
            await storeMessages(primaryDB, primarySpaceId, history.slice(0, 2));
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR, { batchSize: 7 });
            await sync.init();

            const [lowerBound] = await listMessageIDs(primaryDB, primarySpaceId);

            expect(sync.createRangeQueryPayload(lowerBound, null)).toEqual({
                spaceId: primarySpaceId,
                lowerBound: lowerBound,
                upperBound: null,
                maxRowId: sync.snapshotRowId,
                batchSize: 7,
            });
        });
    });

    describe('collectRangeDifference', () => {
        const id = (char) => char.repeat(64);
        let sync = null;

        beforeEach(() => {
            sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
        });

        it('should return true for identical sets regardless of order', () => {
            expect(sync.collectRangeDifference([id('a'), id('b')], [id('b'), id('a')])).toBe(true);
            expect(sync.have.size + sync.need.size).toBe(0);
        });

        it('should treat two empty sets as identical', () => {
            expect(sync.collectRangeDifference([], [])).toBe(true);
        });

        it('should record local-only IDs as have and remote-only IDs as need', () => {
            expect(sync.collectRangeDifference([id('a'), id('b')], [id('b'), id('c'), id('c')])).toBe(false);
            expect(sorted(sync.have)).toEqual([id('a')]);
            expect(sorted(sync.need)).toEqual([id('c')]);
        });

        it('should accumulate differences across ranges', () => {
            sync.collectRangeDifference([id('a')], []);
            sync.collectRangeDifference([], [id('b')]);
            sync.collectRangeDifference([id('c')], [id('d')]);

            expect(sorted(sync.have)).toEqual([id('a'), id('c')]);
            expect(sorted(sync.need)).toEqual([id('b'), id('d')]);
        });
    });

    describe('splitRanges', () => {
        it('should describe an empty range as an empty ID list', async () => {
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            await sync.init();

            expect(await sync.splitRanges(null, null)).toEqual([
                { upperBound: null, mode: Mode.ID_LIST, ids: [] },
            ]);
        });

        it('should list IDs in protocol order below the threshold', async () => {
            await storeMessages(primaryDB, primarySpaceId, history.slice(0, TEST_RECONCILIATION_CONFIG.idListThreshold - 1));
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            await sync.init();

            expect(await sync.splitRanges(null, null)).toEqual([
                { upperBound: null, mode: Mode.ID_LIST, ids: idsOf(await listMessageIDs(primaryDB, primarySpaceId)) },
            ]);
        });

        it('should split into bucketCount fingerprints at or above the threshold', async () => {
            await storeMessages(primaryDB, primarySpaceId, history.slice(0, 30));
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            await sync.init();

            const ranges = await sync.splitRanges(null, null);
            expect(ranges).toHaveLength(TEST_RECONCILIATION_CONFIG.bucketCount);
            expect(ranges.every(range => range.mode === Mode.FINGERPRINT)).toBe(true);
            expect(ranges.at(-1).upperBound).toBeNull();

            // the sub-ranges exactly cover the split range
            let lowerBound = null;
            for (const range of ranges) {
                const fingerprint = await computeRangeFingerprint(primaryDB, {
                    spaceId: primarySpaceId,
                    lowerBound: lowerBound,
                    upperBound: range.upperBound,
                });
                expect(range.fingerprint).toBe(fingerprint);
                lowerBound = range.upperBound;
            }
        });

        it('should only consider messages inside the given bounds', async () => {
            await storeMessages(primaryDB, primarySpaceId, history.slice(0, 30));
            const keys = await listMessageIDs(primaryDB, primarySpaceId);
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            await sync.init();

            expect(await sync.splitRanges(keys[10], keys[15])).toEqual([
                { upperBound: keys[15], mode: Mode.ID_LIST, ids: idsOf(keys.slice(10, 15)) },
            ]);
        });

        it('should ignore messages stored after the snapshot', async () => {
            await storeMessages(primaryDB, primarySpaceId, history.slice(0, 3));
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            await sync.init();
            const before = await sync.splitRanges(null, null);

            await storeMessages(primaryDB, primarySpaceId, history.slice(3, 30));
            expect(await sync.splitRanges(null, null)).toEqual(before);
        });

        it('should trust a known total instead of counting again', async () => {
            await storeMessages(primaryDB, primarySpaceId, history.slice(0, 30));
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            await sync.init();

            const [range] = await sync.splitRanges(null, null, 0);
            expect(range.mode).toBe(Mode.ID_LIST);
            expect(range.ids).toHaveLength(30);
        });
    });

    describe('keepBusy', () => {
        it('should reject a concurrent operation and release afterwards', async () => {
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            let release = null;
            const first = sync.keepBusy(() => new Promise(resolve => { release = resolve; }));

            await expect(sync.keepBusy(async () => 'second')).rejects.toMatchObject({ code: 'BUSY' });

            release('first');
            expect(await first).toBe('first');
            expect(await sync.keepBusy(async () => 'third')).toBe('third');
        });

        it('should release the lock when the operation throws', async () => {
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            await expect(sync.keepBusy(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
            expect(await sync.keepBusy(async () => 'ok')).toBe('ok');
        });
    });

    describe('initiate', () => {
        it('should only be called by the initiator', async () => {
            const sync = createSync(primary, primarySpaceId, NegentropyRole.RESPONDER);
            await expect(sync.initiate()).rejects.toMatchObject({ code: 'INVALID_ROLE' });
            expect(sync.state).toBe(NegentropyStates.IDLE);
        });

        it('should take the snapshot and describe the whole set', async () => {
            await storeMessages(primaryDB, primarySpaceId, history.slice(0, 30));
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);

            const message = await sync.initiate();

            expect(sync.state).toBe(NegentropyStates.RECONCILING);
            expect(sync.rounds).toBe(1);
            expect(sync.snapshotRowId).toBeGreaterThan(0);

            const ranges = await sync.splitRanges(null, null);
            expect(message).toEqual(ranges);
        });

        it('should send an empty ID list for an empty space', async () => {
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            const message = await sync.initiate();

            expect(message).toEqual([{ upperBound: null, mode: Mode.ID_LIST, ids: [] }]);
        });

        it('should not be called twice', async () => {
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            await sync.initiate();
            await expect(sync.initiate()).rejects.toMatchObject({ code: 'INVALID_STATE' });
        });
    });

    describe('reconcile', () => {
        let keys = [];
        let sync = null;

        /** @returns {Promise<string>} */
        const fingerprintOf = (lowerBound, upperBound) => computeRangeFingerprint(primaryDB, {
            spaceId: primarySpaceId,
            lowerBound: lowerBound,
            upperBound: upperBound,
        });

        const mismatch = () => ([
            { upperBound: null, mode: Mode.FINGERPRINT, fingerprint: ZERO_FINGERPRINT }
        ]);

        beforeEach(async () => {
            await storeMessages(primaryDB, primarySpaceId, history.slice(0, 30));
            keys = await listMessageIDs(primaryDB, primarySpaceId);
            sync = createSync(primary, primarySpaceId, NegentropyRole.RESPONDER);

            resetSessionForNode(primary);
        });

        describe('session state', () => {
            it('should require the initiator to initiate first', async () => {
                const initiator = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
                await expect(initiator.reconcile([])).rejects.toMatchObject({ code: 'INVALID_STATE' });
            });

            it('should fail the session after maxRounds', async () => {
                primary.manager.session.session.set('messaging.reconciliation.maxRounds', 2);

                await sync.reconcile(mismatch());
                await sync.reconcile(mismatch());
                await expect(sync.reconcile(mismatch())).rejects.toMatchObject({ code: 'MAX_ROUNDS_EXCEEDED' });

                expect(sync.state).toBe(NegentropyStates.FAILED);
                expect(sync.error).toBeInstanceOf(NegentropySyncError);
            });

            it('should refuse any message once failed', async () => {
                primary.manager.session.session.set('messaging.reconciliation.maxRounds', 0);

                await expect(sync.reconcile(mismatch())).rejects.toMatchObject({ code: 'MAX_ROUNDS_EXCEEDED' });

                await expect(sync.reconcile([])).rejects.toMatchObject({ code: 'INVALID_STATE' });
            });

            it('should refuse any message once done', async () => {
                const state = await sync.reconcile([]);
                expect(sync.isDone).toBe(true);

                await expect(sync.reconcile([])).rejects.toMatchObject({ code: 'INVALID_STATE' });
            });
        });

        describe('termination', () => {
            it('should finish and send an empty message when everything matches', async () => {
                const reply = await sync.reconcile([
                    { upperBound: null, mode: Mode.FINGERPRINT, fingerprint: await fingerprintOf(null, null) },
                ]);

                expect(reply).toEqual([]);
                expect(sync.isDone).toBe(true);
            });

            it('should finish when the peer only sends skips', async () => {
                const reply = await sync.reconcile([
                    { upperBound: keys[3], mode: Mode.SKIP },
                    { upperBound: null, mode: Mode.SKIP }
                ]);

                expect(reply).toEqual([]);
            });
        });

        describe('range modes', () => {
            it('should split a mismatched fingerprint range', async () => {
                const reply = await sync.reconcile(mismatch());

                expect(reply).toEqual(await sync.splitRanges(null, null));
                expect(sync.isDone).toBe(false);
            });

            it('should merge consecutive skips and drop trailing ones', async () => {
                const reply = await sync.reconcile([
                    { upperBound: keys[2], mode: Mode.SKIP },
                    { upperBound: keys[4], mode: Mode.FINGERPRINT, fingerprint: await fingerprintOf(keys[2], keys[4]) },
                    { upperBound: keys[6], mode: Mode.FINGERPRINT, fingerprint: ZERO_FINGERPRINT },
                    { upperBound: keys[8], mode: Mode.SKIP },
                    { upperBound: null, mode: Mode.SKIP },
                ]);

                expect(reply).toEqual([
                    { upperBound: keys[4], mode: Mode.SKIP },
                    { upperBound: keys[6], mode: Mode.ID_LIST, ids: idsOf(keys.slice(4, 6)) },
                ]);
            });

            it('should skip an identical ID list', async () => {
                const reply = await sync.reconcile([
                    { upperBound: keys[3], mode: Mode.ID_LIST, ids: idsOf(keys.slice(0, 3)) },
                    { upperBound: null, mode: Mode.FINGERPRINT, fingerprint: ZERO_FINGERPRINT },
                ]);

                expect(reply[0]).toEqual({ upperBound: keys[3], mode: Mode.SKIP });
                expect(sync.have.size + sync.need.size).toBe(0);
            });

            it('should record the difference of a small ID list and reply with its own IDs', async () => {
                const foreignId = 'f'.repeat(64);
                const reply = await sync.reconcile([
                    { upperBound: keys[5], mode: Mode.ID_LIST, ids: [...idsOf(keys.slice(0, 4)), foreignId] }
                ]);

                expect(reply).toEqual([
                    { upperBound: keys[5], mode: Mode.ID_LIST_RESPONSE, ids: idsOf(keys.slice(0, 5)) },
                ]);
                expect(sorted(sync.have)).toEqual([keys[4].messageId]);
                expect(sorted(sync.need)).toEqual([foreignId]);
            });

            it('should keep splitting when its own side of an ID list range is large', async () => {
                const reply = await sync.reconcile([{ upperBound: null, mode: Mode.ID_LIST, ids: [] }]);

                expect(reply).toHaveLength(TEST_RECONCILIATION_CONFIG.bucketCount);
                expect(reply.every(range => range.mode === Mode.FINGERPRINT)).toBe(true);
                // the difference is recorded later, once the sub-ranges are small enough
                expect(sync.have.size).toBe(0);
            });

            it('should record an ID list response without replying to it', async () => {
                const foreignId = 'e'.repeat(64);
                const reply = await sync.reconcile([
                    { upperBound: keys[2], mode: Mode.ID_LIST_RESPONSE, ids: [keys[0].messageId, foreignId] },
                ]);

                expect(reply).toEqual([]);
                expect(sorted(sync.have)).toEqual([keys[1].messageId]);
                expect(sorted(sync.need)).toEqual([foreignId]);
            });
        });
    });

    describe('resolveNeeds', () => {
        it('should return nothing when nothing is needed', async () => {
            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            expect(await sync.resolveNeeds()).toEqual([]);
        });

        it('should drop needs which are already stored locally', async () => {
            const [arrived, ...missing] = await storeMessages(primaryDB, primarySpaceId, history.slice(0, 3));
            for (const messageId of missing) {
                await flushMessageRecords(primaryDB, { messageId });
            }

            const sync = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR);
            sync.need = new Set([arrived, ...missing]);

            expect(sorted(await sync.resolveNeeds())).toEqual(sorted(missing));
            expect(sorted(sync.need)).toEqual(sorted(missing));
        });
    });

    describe('reconciliation between peers', () => {
        let initiator = null;
        let responder = null;

        beforeEach(() => {
            initiator = createSync(primary, primarySpaceId, NegentropyRole.INITIATOR, { peerPublicKey: secondary.publicKey });
            responder = createSync(secondary, secondarySpaceId, NegentropyRole.RESPONDER, { peerPublicKey: primary.publicKey });
        });

        it('should finish in one round-trip for identical sets', async () => {
            await storeMessages(primaryDB, primarySpaceId, history);
            await storeMessages(secondaryDB, secondarySpaceId, history);

            const transcript = await runSync(initiator, responder);

            expect(transcript).toHaveLength(2);
            expect(initiator.isDone && responder.isDone).toBe(true);
            expect(initiator.have.size + initiator.need.size).toBe(0);
            expect(responder.have.size + responder.need.size).toBe(0);
        });

        it('should let both sides learn the exact difference', async () => {
            const primaryIds = await storeMessages(primaryDB, primarySpaceId, history.filter((_, index) => index % 11 !== 3));
            const secondaryIds = await storeMessages(secondaryDB, secondarySpaceId, history.filter((_, index) => index % 7 !== 2));
            const onlyPrimary = primaryIds.filter(id => !secondaryIds.includes(id));
            const onlySecondary = secondaryIds.filter(id => !primaryIds.includes(id));

            await runSync(initiator, responder);

            expect(sorted(initiator.have)).toEqual(sorted(onlyPrimary));
            expect(sorted(initiator.need)).toEqual(sorted(onlySecondary));
            expect(sorted(responder.have)).toEqual(sorted(onlySecondary));
            expect(sorted(responder.need)).toEqual(sorted(onlyPrimary));
        });

        it('should give a new member (as initiator) the whole history', async () => {
            const messageIds = await storeMessages(secondaryDB, secondarySpaceId, history);

            const transcript = await runSync(initiator, responder);

            expect(sorted(initiator.need)).toEqual(sorted(messageIds));
            expect(sorted(responder.have)).toEqual(sorted(messageIds));

            // ID lists stay bounded even though the veteran holds the whole history
            for (const ranges of transcript) {
                for (const range of ranges) {
                    expect(range.ids?.length ?? 0).toBeLessThan(TEST_RECONCILIATION_CONFIG.idListThreshold);
                }
            }
        });

        it('should give a new member (as responder) the whole history', async () => {
            const messageIds = await storeMessages(primaryDB, primarySpaceId, history);

            await runSync(initiator, responder);

            expect(sorted(responder.need)).toEqual(sorted(messageIds));
            expect(sorted(initiator.have)).toEqual(sorted(messageIds));
        });

        it('should ignore messages stored during the sync', async () => {
            const primaryIds = await storeMessages(primaryDB, primarySpaceId, history.slice(0, 45));
            const secondaryIds = await storeMessages(secondaryDB, secondarySpaceId, history.slice(15, 60));
            const liveMessages = await createMessages(secondary, spaceTopicHash, 20, 1000);
            await initiator.init();
            await responder.init();

            // after every round, a live message reaches both peers and another one reaches only primary
            let liveIndex = 0;
            const onRound = async () => {
                if (liveIndex + 1 >= liveMessages.length) return;
                await storeMessages(primaryDB, primarySpaceId, liveMessages.slice(liveIndex, liveIndex + 2));
                await storeMessages(secondaryDB, secondarySpaceId, liveMessages.slice(liveIndex, liveIndex + 1));
                liveIndex += 2;
            };

            await runSync(initiator, responder, { onRound });

            expect(liveIndex).toBeGreaterThan(0);
            expect(sorted(initiator.have)).toEqual(sorted(primaryIds.filter(id => !secondaryIds.includes(id))));
            expect(sorted(initiator.need)).toEqual(sorted(secondaryIds.filter(id => !primaryIds.includes(id))));
        });
    });
});

const MANAGER_RECONCILIATION_CONFIG = Object.freeze({
    ...TEST_RECONCILIATION_CONFIG,
    maxIdListSize: 4096,
    sessionTimeout: 1000,
    heartbeatInterval: 60000, // tests run the heartbeat manually
    requestBatchSize: 10,
    requestTimeout: 1000,
});

/** Creates `count` distinct message ids. */
const createMessageIds = (prefix, count) =>
    Array.from({ length: count }, (_, index) => hex(hash(`${prefix}-${index}`)));

/**
 * Delivers every assigned batch (except the ones `skip` holds back) until the scheduler
 * is complete, and returns the number of messages each provider delivered.
 */
const drainScheduler = (scheduler, { skip = () => false, maxRounds = 1000 } = {}) => {
    const delivered = {};

    for (let round = 0; !scheduler.isComplete() && round < maxRounds; round++) {
        for (const [publicKey, assignment] of [...scheduler.assignments]) {
            if (skip(publicKey, round)) continue;

            delivered[publicKey] = (delivered[publicKey] ?? 0) + assignment.messageIds.size;
            scheduler.markDelivered([...assignment.messageIds]);
        }

        scheduler.assign();
    }

    return delivered;
};

/**
 * Wires the mock sockets of the nodes together: a frame written to a node's socket is
 * handled by that node, as if it came from the node that signed the message.
 */
const linkNetwork = (nodes) => {
    for (const target of nodes) {
        target.socket.write.mockImplementation(buffer => {
            const raw = unframeJson(buffer);
            const sender = nodes.find(node => node.publicKey === JSON.parse(raw).publicKey);

            setImmediate(() => target.manager.message.handleIncomingMessage(sender.socket, raw, sender.info));
            return true;
        });
    }
};

/** Resolves with the first `count` contexts of an event emitted on the node. */
const waitForEvents = (node, event, count = 1, timeout = 5000) => new Promise((resolve, reject) => {
    const contexts = [];
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${count} ${event} event(s)`)), timeout);

    const listener = context => {
        contexts.push(context);
        if (contexts.length < count) return;

        clearTimeout(timer);
        node.manager.emitter.off(event, listener);
        resolve(contexts);
    };

    node.manager.emitter.on(event, listener);
});

describe('MessageRequestScheduler', () => {
    let session = null;
    let requests = [];
    let scheduler = null;

    beforeEach(() => {
        session = new SessionManager();
        session.session.set('messaging.reconciliation', { ...MANAGER_RECONCILIATION_CONFIG });

        requests = [];
        scheduler = new MessageRequestScheduler({
            sessionManager: session,
            topic: 'topic',
            request: async (publicKey, messageIds) => { requests.push({ publicKey, messageIds }); },
        });
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('should not dispatch anything without a request handler', () => {
        scheduler.setRequestHandler(null);
        scheduler.addProvider('peerA', createMessageIds('m', 5));

        expect(scheduler.assign()).toEqual([]);
        expect(scheduler.pendingCount).toBe(5);
    });

    it('should assign one batch per idle provider, capped by requestBatchSize', async () => {
        scheduler.addProvider('peerA', createMessageIds('m', 25));

        const [assignment, ...rest] = scheduler.assign();
        expect(rest).toEqual([]);
        expect(assignment.messageIds).toHaveLength(MANAGER_RECONCILIATION_CONFIG.requestBatchSize);

        // the provider is busy until its batch is delivered
        expect(scheduler.assign()).toEqual([]);

        scheduler.markDelivered(assignment.messageIds);
        expect(scheduler.assign()).toHaveLength(1);

        await Promise.resolve();
        expect(requests).toHaveLength(2);
    });

    it('should split shared messages evenly between equally fast providers', () => {
        const messageIds = createMessageIds('m', 1000);
        scheduler.addProvider('peerA', messageIds);
        scheduler.addProvider('peerB', messageIds);
        scheduler.assign();

        const delivered = drainScheduler(scheduler);

        expect(delivered).toEqual({ peerA: 500, peerB: 500 });
        expect(scheduler.isComplete()).toBe(true);
    });

    it('should give more messages to a faster provider', () => {
        const messageIds = createMessageIds('m', 300);
        scheduler.addProvider('fast', messageIds);
        scheduler.addProvider('slow', messageIds);
        scheduler.assign();

        // the slow provider only delivers every third round
        const delivered = drainScheduler(scheduler, { skip: (publicKey, round) => publicKey === 'slow' && round % 3 !== 0 });

        expect(delivered.fast + delivered.slow).toBe(300);
        expect(delivered.fast).toBeGreaterThan(delivered.slow * 2);
    });

    it('should request the messages with the fewest providers first', () => {
        const shared = createMessageIds('shared', 10);
        const onlyA = createMessageIds('onlyA', 5);
        scheduler.addProvider('peerA', [...shared, ...onlyA]);
        scheduler.addProvider('peerB', shared);

        const assignmentA = scheduler.assign().find(assignment => assignment.publicKey === 'peerA');
        expect(assignmentA.messageIds.slice(0, 5)).toEqual(onlyA);
    });

    it('should not queue a message that is already assigned when another provider registers it', () => {
        const messageIds = createMessageIds('m', 5);
        scheduler.addProvider('peerA', messageIds);
        scheduler.assign();

        scheduler.addProvider('peerB', messageIds);
        expect(scheduler.queue.size).toBe(0);
        expect(scheduler.assign()).toEqual([]);
    });

    it('should hand the assignment of a removed provider to another provider', () => {
        const messageIds = createMessageIds('m', 10);
        scheduler.addProvider('peerA', messageIds);
        scheduler.assign();
        scheduler.addProvider('peerB', messageIds);

        scheduler.removeProvider('peerA');
        const [assignment] = scheduler.assign();

        expect(assignment.publicKey).toBe('peerB');
        expect(sorted(assignment.messageIds)).toEqual(sorted(messageIds));
    });

    it('should drop messages without any provider until a new provider registers them', () => {
        const messageIds = createMessageIds('m', 4);
        scheduler.addProvider('peerA', messageIds);
        scheduler.assign();

        scheduler.removeProvider('peerA');
        expect(scheduler.pendingCount).toBe(0);
        expect(scheduler.assign()).toEqual([]);

        scheduler.addProvider('peerB', messageIds);
        expect(scheduler.assign()[0].messageIds).toHaveLength(4);
    });

    it('should reclaim stalled assignments and penalize the provider', () => {
        const messageIds = createMessageIds('m', 20);
        scheduler.addProvider('peerA', messageIds);
        scheduler.assign();
        scheduler.addProvider('peerB', messageIds);

        const startedAt = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(startedAt + MANAGER_RECONCILIATION_CONFIG.requestTimeout + 1);

        // peerB got its own batch meanwhile, so only peerA is stalled
        const [assignmentB] = scheduler.assign();
        expect(assignmentB.publicKey).toBe('peerB');

        expect(scheduler.reclaimStalled()).toEqual(['peerA']);
        expect(scheduler.penalties.get('peerA')).toBe(1);

        // once peerB is idle again, it is picked before the penalized peerA
        scheduler.markDelivered(assignmentB.messageIds);
        const order = scheduler.pickIdleProviders();
        expect(order).toEqual(['peerB', 'peerA']);
    });

    it('should release and penalize a provider whose request fails', async () => {
        scheduler.setRequestHandler(async () => { throw new Error('socket closed'); });
        scheduler.addProvider('peerA', createMessageIds('m', 5));

        scheduler.assign();
        await new Promise(resolve => setImmediate(resolve));

        expect(scheduler.isIdle('peerA')).toBe(true);
        expect(scheduler.queue.size).toBe(5);
        expect(scheduler.penalties.get('peerA')).toBe(1);
    });
});

/**
 * Three linked virtual nodes, all members of the same space:
 * primary and secondary hold the history, tertiary acts as a new member.
 */
describe('NegentropySyncManager', () => {
    let nodes = [];
    let primary = null;
    let secondary = null;
    let tertiary = null;
    let space = null;
    let spaceTopicHash = null;
    let history = [];

    const store = async (node, list) => {
        const db = node.manager.session.getDatabase().db;
        const spaceId = (await getTopicToSpaceMap(db)).get(spaceTopicHash);
        return await storeMessages(db, spaceId, list);
    };

    const emitSpaceSync = (node, peer, action = SpaceSyncHandler.STATES.IDENTICAL) => {
        node.manager.emitter.emit(EVENTS.SpaceSync, { info: peer.info, message: { payload: space }, action });
    };

    /** The node elected as initiator between two nodes. */
    const electedOf = (first, second) =>
        isReconciliationInitiator(spaceTopicHash, first.publicKey, second.publicKey) ? first : second;

    beforeEach(async () => {
        nodes = await createP2PNetwork(3);
        [primary, secondary, tertiary] = nodes;

        for (const node of nodes) {
            node.manager.session.session.set('messaging.reconciliation', { ...MANAGER_RECONCILIATION_CONFIG });
        }

        const spaceParams = await buildTestSpacePayload({
            spaceName: 'NegentropyManagerSpace',
            publicKey: primary.publicKey,
            permissionRead: 0,
            permissionBroadcast: 0,
            readWhitelist: nodes.map(node => node.publicKey),
            broadcastWhitelist: nodes.map(node => node.publicKey),
        });

        const primaryDB = primary.manager.session.getDatabase().db;
        const { spaceId } = await createSpaceForPublicKey(primaryDB, spaceParams, primary.secretKey);
        space = await getSpace(primaryDB, spaceId);

        for (const node of [secondary, tertiary]) {
            await upsertSpace(node.manager.session.getDatabase().db, space);
        }

        spaceTopicHash = getSpaceTopicHash(space);
        createConnections(spaceTopicHash, nodes);
        linkNetwork(nodes);

        for (const node of nodes) {
            await node.manager.negentropy.init();
        }

        history = await createMessages(primary, spaceTopicHash, 60);
    });

    afterEach(async () => {
        vi.restoreAllMocks();

        for (const node of nodes) {
            await node.manager.negentropy.stop();

            const { sqlite } = node.manager.session.getDatabase();
            await sqlite.close();
            await cleanup(node.manager.root);
        }
    });

    describe('session negotiation', () => {
        it('should only let the elected peer initiate after SpaceSync', async () => {
            const primaryIds = await store(primary, history.slice(0, 40));
            const secondaryIds = await store(secondary, history.slice(20, 60));

            const elected = electedOf(primary, secondary);
            const other = elected === primary ? secondary : primary;

            const completions = Promise.all([
                waitForEvents(primary, EVENTS.NegentropySyncComplete),
                waitForEvents(secondary, EVENTS.NegentropySyncComplete),
            ]);

            // both peers receive a direct SpaceSync from each other
            emitSpaceSync(primary, secondary);
            emitSpaceSync(secondary, primary);

            const [[onPrimary], [onSecondary]] = await completions;

            expect(elected.manager.negentropy.getSession(other.publicKey, spaceTopicHash).role).toBe(NegentropyRole.INITIATOR);
            expect(other.manager.negentropy.getSession(elected.publicKey, spaceTopicHash).role).toBe(NegentropyRole.RESPONDER);

            expect(sorted(onPrimary.need)).toEqual(sorted(secondaryIds.filter(id => !primaryIds.includes(id))));
            expect(sorted(onPrimary.have)).toEqual(sorted(primaryIds.filter(id => !secondaryIds.includes(id))));
            expect(sorted(onSecondary.need)).toEqual(sorted(onPrimary.have));
        });

        it('should let the newcomer initiate on a first encounter, even when not elected', async () => {
            const veteran = electedOf(primary, secondary);
            const newcomer = veteran === primary ? secondary : primary;
            const messageIds = await store(veteran, history);

            const completions = Promise.all([
                waitForEvents(newcomer, EVENTS.NegentropySyncComplete),
                waitForEvents(veteran, EVENTS.NegentropySyncComplete),
            ]);
            emitSpaceSync(newcomer, veteran, SpaceSyncHandler.STATES.FIRST_ENCOUNTER);
            const [[context]] = await completions;

            expect(context.role).toBe(NegentropyRole.INITIATOR);
            expect(veteran.manager.negentropy.getSession(newcomer.publicKey, spaceTopicHash).role).toBe(NegentropyRole.RESPONDER);
            expect(sorted(context.need)).toEqual(sorted(messageIds));
        });

        it('should ignore SpaceSync when not elected', async () => {
            const notElected = electedOf(primary, secondary) === primary ? secondary : primary;
            const peer = notElected === primary ? secondary : primary;

            emitSpaceSync(notElected, peer);
            await new Promise(resolve => setTimeout(resolve, 50));

            expect(notElected.manager.negentropy.sessions.size).toBe(0);
            expect(peer.socket.write).not.toHaveBeenCalled();
        });

        it('should not start a session with a peer that cannot read the space', async () => {
            const restricted = await buildTestSpacePayload({
                spaceName: 'RestrictedSpace',
                publicKey: primary.publicKey,
                permissionRead: 0,
                readWhitelist: [primary.publicKey],
            });
            const primaryDB = primary.manager.session.getDatabase().db;
            const { spaceId } = await createSpaceForPublicKey(primaryDB, restricted, primary.secretKey);
            const restrictedTopic = getSpaceTopicHash(await getSpace(primaryDB, spaceId));

            const session = await primary.manager.negentropy.startSession(secondary.publicKey, restrictedTopic);

            expect(session).toBeNull();
            expect(secondary.socket.write).not.toHaveBeenCalled();
        });

        it('should not start two sessions for the same peer and space', async () => {
            secondary.socket.write.mockImplementation(() => true);

            const [first, second] = await Promise.all([
                primary.manager.negentropy.startSession(secondary.publicKey, spaceTopicHash),
                primary.manager.negentropy.startSession(secondary.publicKey, spaceTopicHash),
            ]);

            expect(first).toBe(second);
            expect(secondary.socket.write).toHaveBeenCalledTimes(1);
        });

        it('should keep a single session when both peers initiate at the same time', async () => {
            await store(primary, history.slice(0, 30));
            await store(secondary, history.slice(30, 60));

            const completions = Promise.all([
                waitForEvents(primary, EVENTS.NegentropySyncComplete),
                waitForEvents(secondary, EVENTS.NegentropySyncComplete),
            ]);

            await Promise.all([
                primary.manager.negentropy.startSession(secondary.publicKey, spaceTopicHash),
                secondary.manager.negentropy.startSession(primary.publicKey, spaceTopicHash),
            ]);

            const [[onPrimary], [onSecondary]] = await completions;
            const primarySession = primary.manager.negentropy.getSession(secondary.publicKey, spaceTopicHash);
            const secondarySession = secondary.manager.negentropy.getSession(primary.publicKey, spaceTopicHash);

            expect(primarySession.sessionId).toBe(secondarySession.sessionId);
            expect(new Set([onPrimary.role, onSecondary.role])).toEqual(new Set([NegentropyRole.INITIATOR, NegentropyRole.RESPONDER]));
            expect(onPrimary.need).toHaveLength(30);
            expect(onSecondary.need).toHaveLength(30);
        });
    });

    describe('session lifecycle', () => {
        it('should drop a session whose peer stops answering', async () => {
            secondary.socket.write.mockImplementation(() => true); // secondary never answers

            await primary.manager.negentropy.startSession(secondary.publicKey, spaceTopicHash);
            expect(primary.manager.negentropy.sessions.size).toBe(1);

            const startedAt = Date.now();
            vi.spyOn(Date, 'now').mockReturnValue(startedAt + MANAGER_RECONCILIATION_CONFIG.sessionTimeout + 1);
            await primary.manager.negentropy.heartbeat();

            expect(primary.manager.negentropy.sessions.size).toBe(0);
        });

        it('should drop a session when the peer rejects its last message', async () => {
            secondary.socket.write.mockImplementation(() => true);

            const session = await primary.manager.negentropy.startSession(secondary.publicKey, spaceTopicHash);
            primary.manager.emitter.emit(EVENTS.Reject, {
                fromPublicKey: secondary.publicKey,
                linkedMessageNonce: session.lastSentNonce,
            });

            expect(primary.manager.negentropy.sessions.size).toBe(0);
        });

        it('should drop the sessions of a disconnected peer', async () => {
            secondary.socket.write.mockImplementation(() => true);

            await primary.manager.negentropy.startSession(secondary.publicKey, spaceTopicHash);
            primary.manager.emitter.emit(EVENTS.Disconnect, { publicKey: secondary.publicKey });

            expect(primary.manager.negentropy.sessions.size).toBe(0);
        });

        it('should start a new session once the previous one was dropped', async () => {
            secondary.socket.write.mockImplementation(() => true);

            const first = await primary.manager.negentropy.startSession(secondary.publicKey, spaceTopicHash);
            primary.manager.emitter.emit(EVENTS.Disconnect, { publicKey: secondary.publicKey });
            const second = await primary.manager.negentropy.startSession(secondary.publicKey, spaceTopicHash);

            expect(second).not.toBe(first);
            expect(second.sessionId).not.toBe(first.sessionId);
        });
    });

    describe('message requests', () => {
        let requests = [];

        /** tertiary (new member) reconciles with primary and secondary which hold the full history */
        const syncNewcomer = async () => {
            const messageIds = await store(primary, history);
            await store(secondary, history);

            // wait for both sides of both sessions to finish
            const completions = Promise.all([
                waitForEvents(tertiary, EVENTS.NegentropySyncComplete, 2),
                waitForEvents(primary, EVENTS.NegentropySyncComplete),
                waitForEvents(secondary, EVENTS.NegentropySyncComplete),
            ]);
            emitSpaceSync(tertiary, primary, SpaceSyncHandler.STATES.FIRST_ENCOUNTER);
            emitSpaceSync(tertiary, secondary, SpaceSyncHandler.STATES.FIRST_ENCOUNTER);
            await completions;

            return messageIds;
        };

        beforeEach(() => {
            requests = [];
            tertiary.manager.negentropy.setRequestHandler(async ({ topic, publicKey, messageIds }) => {
                requests.push({ topic, publicKey, messageIds });
            });
        });

        it('should register every finished session as provider of the needed messages', async () => {
            const messageIds = await syncNewcomer();
            const scheduler = tertiary.manager.negentropy.getScheduler(spaceTopicHash);

            expect(scheduler.pendingCount).toBe(messageIds.length);
            for (const messageId of messageIds) {
                expect(scheduler.providers.get(messageId)).toEqual(new Set([primary.publicKey, secondary.publicKey]));
            }

            // one batch per provider is requested right away
            await new Promise(resolve => setImmediate(resolve));
            expect(requests.map(request => request.publicKey).sort()).toEqual([primary.publicKey, secondary.publicKey].sort());
            expect(requests.every(request => request.topic === spaceTopicHash)).toBe(true);
        });

        it('should balance the requests between the peers sharing the messages', async () => {
            const messageIds = await syncNewcomer();
            const scheduler = tertiary.manager.negentropy.getScheduler(spaceTopicHash);

            const delivered = drainScheduler(scheduler);

            expect(delivered).toEqual({
                [primary.publicKey]: messageIds.length / 2,
                [secondary.publicKey]: messageIds.length / 2,
            });
        });

        it('should request the remaining messages from another peer after a disconnect', async () => {
            const messageIds = await syncNewcomer();
            const scheduler = tertiary.manager.negentropy.getScheduler(spaceTopicHash);

            tertiary.manager.emitter.emit(EVENTS.Disconnect, { publicKey: primary.publicKey });
            const delivered = drainScheduler(scheduler);

            expect(delivered).toEqual({ [secondary.publicKey]: messageIds.length });
            expect(tertiary.manager.negentropy.getSession(primary.publicKey, spaceTopicHash)).toBeUndefined();
        });

        it('should reassign stalled requests during the heartbeat', async () => {
            await syncNewcomer();
            const scheduler = tertiary.manager.negentropy.getScheduler(spaceTopicHash);
            const stalled = scheduler.assignments.get(primary.publicKey);

            const startedAt = Date.now();
            vi.spyOn(Date, 'now').mockReturnValue(startedAt + MANAGER_RECONCILIATION_CONFIG.requestTimeout + 1);
            await tertiary.manager.negentropy.heartbeat();

            expect(scheduler.penalties.get(primary.publicKey)).toBe(1);
            expect(scheduler.penalties.get(secondary.publicKey)).toBe(1);

            // every stalled message is requested again
            const assigned = [...scheduler.assignments.values()].flatMap(assignment => [...assignment.messageIds]);
            for (const messageId of stalled.messageIds) {
                expect(assigned.includes(messageId) || scheduler.queue.has(messageId)).toBe(true);
            }
        });
    });
});
