import { describe, it, beforeEach, afterEach, expect } from "vitest";
import * as EVENTS from '../../src/constants/events.constants.js';

import { createBaseMessage, createSpaceMessage } from "../../src/utils/protocol.utils.js";
import { createSpaceForPublicKey, getSpace, getSpaceTopicHash, upsertSpace } from "../../src/utils/space.utils.js";
import { hex, randomNonce } from "../../src/utils/crypto.utils.js";
import { buildTestSpacePayload, cleanup, createP2PNetwork } from "../general.utils.js";
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
