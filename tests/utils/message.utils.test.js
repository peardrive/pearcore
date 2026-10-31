import { describe, it, beforeEach, beforeAll, afterEach, expect } from "vitest";
import { createBaseMessage } from "../../src/utils/protocol.utils.js";
import { cleanup, createTempDatabase, generateKeypair } from "../general.utils.js";
import { isNumber, now, validateHexString } from "../../src/utils/general.utils.js";
import { hex, randomNonce } from "../../src/utils/crypto.utils.js";
import { createSpaceForPublicKey } from "../../src/utils/space.utils.js";
import {
    createMessageRecord,
    queryMessageRecord,
    flushMessageRecords,
    pushMessageToHistory,
    computeRangeFingerprint,
    computeRangeBuckets,
    countMessagesInRange,
    listMessageIdsInRange,
    getMessageSnapshotRowId,
    getMessagesByIds,
    isReconciliationInitiator,
} from "../../src/utils/message.utils.js";

const createMessage = async (overrides = {}) => {
    const keypair = await generateKeypair();

    return await createBaseMessage({
        type: 'test',
        topic: 'topic',
        nonce: 'aaaa',
        timestamp: now(),
        payload: { data: 10 },
        publicKey: hex(keypair.publicKey),
        secretKey: hex(keypair.secretKey),
        ...overrides
    });
}

describe('Message Utilities', () => {
    let db = null;
    let sqliteInstance = null;
    let spaceId = null;
    let rootPath = null;

    beforeEach(async () => {
        const { db: dbInstance, sqlite, root } = await createTempDatabase();
        db = dbInstance;
        rootPath = root;
        sqliteInstance = sqlite;

        const keypair = await generateKeypair();
        const result = await createSpaceForPublicKey(db, {
            publicKey: hex(keypair.publicKey),
            spaceName: 'test'
        }, hex(keypair.secretKey));

        spaceId = result.spaceId;
    });

    afterEach(async () => {
        await sqliteInstance.close();
        await cleanup(rootPath);
    });

    describe('createMessageRecord', () => {
        it('should create a message record successfully', async () => {
            const message = await createMessage();
            const senderPublicKey = message.publicKey;
            const broadcastTimestamp = now();

            const result = await createMessageRecord(db, {
                message: message,
                spaceId: spaceId,
                senderPublicKey: senderPublicKey,
                broadcastTimestamp: broadcastTimestamp
            });

            expect(result).toHaveProperty('id');
            expect(result).toHaveProperty('messageId');
            expect(isNumber(result.id)).toBe(true);
            expect(validateHexString(result.messageId)).toBe(true);
        });
    });

    describe('Range reconciliation', () => {
        const insertMany = async (count, startTimestamp = 1000) => {
            const rows = [];
            for (let index = 0; index < count; index++) {
                const nonce = hex(randomNonce());

                const message = await createMessage({
                    nonce: nonce,
                    timestamp: startTimestamp + Math.floor(index / 2), // pairs should share timestamp
                    payload: { index },
                });

                const record = await createMessageRecord(db, {
                    message: message, 
                    spaceId: spaceId, 
                    senderPublicKey: message.publicKey, 
                    broadcastTimestamp: now(),
                });

                rows.push({ ...message, ...record });
            }
            return rows.sort((a, b) => a.timestamp - b.timestamp || (a.messageId < b.messageId ? -1 : 1));
        };

        it('should count and list IDs in ascending (timestamp, messageId) order', async () => {
            const rows = await insertMany(9, 1000);
            const lowerBound = { timestamp: rows[2].timestamp, messageId: rows[2].messageId };
            const upperBound = { timestamp: rows[7].timestamp, messageId: rows[7].messageId };

            expect(await countMessagesInRange(db, { spaceId })).toBe(9);
            expect(await countMessagesInRange(db, { spaceId, lowerBound, upperBound })).toBe(5);
            expect(await listMessageIdsInRange(db, { spaceId, lowerBound, upperBound, batchSize: 2 }))
                .toEqual(rows.slice(2, 7).map(r => r.messageId));
        });

        it('should freeze the visible set with maxRowId', async () => {
            await insertMany(4, 1000);
            const snapshot = await getMessageSnapshotRowId(db, spaceId);
            const before = await computeRangeFingerprint(db, { spaceId, maxRowId: snapshot });

            await insertMany(3, 500); // older timestamps, inserted later

            expect(await countMessagesInRange(db, { spaceId, maxRowId: snapshot })).toBe(4);
            expect(await computeRangeFingerprint(db, { spaceId, maxRowId: snapshot })).toBe(before);
            expect(await computeRangeFingerprint(db, { spaceId })).not.toBe(before);
        });

        it('should return 0 as snapshot of an empty space', async () => {
            expect(await getMessageSnapshotRowId(db, spaceId)).toBe(0);
        });

        it('should split a range into contiguous buckets with matching fingerprints', async () => {
            const rows = await insertMany(23);
            const buckets = await computeRangeBuckets(db, { spaceId, bucketCount: 4, batchSize: 3 });

            expect(buckets).toHaveLength(4);
            expect(buckets.map(b => b.count)).toEqual([6, 6, 6, 5]);
            expect(buckets.at(-1).upperBound).toBeNull();
            expect(buckets[0].upperBound.messageId).toBe(rows[6].messageId);

            let lowerBound = null;
            for (const bucket of buckets) {
                const fingerprint = await computeRangeFingerprint(db, { spaceId, lowerBound, upperBound: bucket.upperBound });
                expect(fingerprint).toBe(bucket.fingerprint);
                lowerBound = bucket.upperBound;
            }
        });

        it('should create fewer buckets than requested for small ranges', async () => {
            await insertMany(3);
            const buckets = await computeRangeBuckets(db, { spaceId, bucketCount: 16 });
            expect(buckets.map(b => b.count)).toEqual([1, 1, 1]);

            const empty = await computeRangeBuckets(db, { spaceId: spaceId + 1000, bucketCount: 16 });
            expect(empty).toHaveLength(1);
            expect(empty[0].count).toBe(0);
        });

        it('should load records by message IDs', async () => {
            const rows = await insertMany(5);
            const records = await getMessagesByIds(db, {
                spaceId,
                messageIds: [rows[3].messageId, rows[1].messageId, rows[1].messageId],
                batchSize: 1,
            });

            expect(records.map(r => r.messageId)).toEqual([rows[1].messageId, rows[3].messageId]);
        });
    });

    describe('isReconciliationInitiator', () => {
        it('should elect exactly one initiator between two peers', async () => {
            const peers = await Promise.all([generateKeypair(), generateKeypair()]);
            const [first, second] = peers.map(keypair => hex(keypair.publicKey));

            for (let index = 0; index < 20; index++) {
                const topic = hex(randomNonce());
                const firstInitiates = isReconciliationInitiator(topic, first, second);
                const secondInitiates = isReconciliationInitiator(topic, second, first);

                expect(firstInitiates).not.toBe(secondInitiates);
            }
        });

        it('should spread the initiator role across topics', async () => {
            const [first, second] = (await Promise.all([generateKeypair(), generateKeypair()]))
                .map(keypair => hex(keypair.publicKey));

            const roles = new Set();
            for (let index = 0; index < 32; index++) {
                roles.add(isReconciliationInitiator(hex(randomNonce()), first, second));
            }

            expect(roles).toEqual(new Set([true, false]));
        });
    });

    describe("Operations", () => {

        describe('queryMessageRecord', () => {

            beforeEach(async () => {
                for (let index = 0; index < 5; index++) {
                    const message = await createMessage({
                        type: 'base',
                        topic: `topic-index-${index}`,
                        nonce: hex(randomNonce()),
                        timestamp: index * 1000,
                        payload: {
                            data: `data-for-${index}`
                        }
                    });

                    await createMessageRecord(db, {
                        message: message,
                        spaceId: spaceId,
                        senderPublicKey: 'aaaa',
                        broadcastTimestamp: index * 2000
                    });

                }
            });

            it('should query all message records when no filter is provided', async () => {
                const result = await queryMessageRecord(db, {});
                expect(result.length).toBe(5);
            });

            it('should filter by id', async () => {
                const queryResultByID = await queryMessageRecord(db, { id: 1 });
                expect(queryResultByID.length).toBe(1);
                expect(queryResultByID[0].id).toBe(1);
            });

            it('should filter by spaceId', async () => {
                const queryCorrectSpace = await queryMessageRecord(db, { spaceId: spaceId });
                expect(queryCorrectSpace.length).toBe(5);

                const queryWrongSpace = await queryMessageRecord(db, { spaceId: 1000 });
                expect(queryWrongSpace.length).toBe(0);
            });

            it('should filter by type', async () => {
                const customMessage = await createMessage({
                    type: 'custom',
                });

                await createMessageRecord(db, {
                    message: customMessage,
                    spaceId: spaceId,
                    senderPublicKey: customMessage.publicKey,
                    broadcastTimestamp: now()
                });

                const queryResultByType = await queryMessageRecord(db, { type: 'custom' });
                expect(queryResultByType.length).toBe(1);
            });

            it('should filter by nonce', async () => {

                const nonce = hex(randomNonce());
                const message = await createMessage({
                    type: 'base',
                    topic: `casual message`,
                    nonce: nonce,
                    timestamp: 1000,
                    payload: {
                        data: 'foo'
                    }
                });

                await createMessageRecord(db, {
                    message: message,
                    spaceId: spaceId,
                    senderPublicKey: message.publicKey,
                    broadcastTimestamp: now()
                });

                const queryResultByNonce = await queryMessageRecord(db, { nonce: nonce });
                expect(queryResultByNonce.length).toBe(1);
                expect(queryResultByNonce[0].nonce).toBe(nonce);
            });

            it('should filter by broadcastTimestamp', async () => {
                const queryResultByTimestampStart = await queryMessageRecord(db, {
                    broadcastTimestamp: { start: 2000 }
                });

                expect(queryResultByTimestampStart.length).toBe(4);
                expect(queryResultByTimestampStart.every(r => r.broadcastTimestamp >= 2000)).toBe(true);

                const queryResultByTimestampEnd = await queryMessageRecord(db, {
                    broadcastTimestamp: { end: 4000 }
                });

                expect(queryResultByTimestampEnd.length).toBe(3);
                expect(queryResultByTimestampEnd.every(r => r.broadcastTimestamp <= 4000)).toBe(true);

                const queryResultByTimestampPeriod = await queryMessageRecord(db, {
                    broadcastTimestamp: { start: 1000, end: 3000 }
                });

                expect(queryResultByTimestampPeriod.length).toBe(1);
                expect(queryResultByTimestampPeriod.every(r =>
                    r.broadcastTimestamp <= 3000 && r.broadcastTimestamp >= 1000)).toBe(true);
            });

            it('should filter by payloadContains', async () => {
                const queryResultByPayload = await queryMessageRecord(db, {
                    payloadContains: 'data-for-0'
                });

                expect(queryResultByPayload.length).toBe(1);
                expect(JSON.parse(queryResultByPayload[0].payload)).toEqual({ data: 'data-for-0' });
            });

            it('should support ordering by messageTimestamp', async () => {
                const queryResultByAscOrder = await queryMessageRecord(db, {
                    orderBy: 'messageTimestamp',
                    orderDirection: 'asc'
                });

                for (let index = 0; index < queryResultByAscOrder.length - 1; index++) {
                    expect(queryResultByAscOrder[index].messageTimestamp)
                        .toBeLessThan(queryResultByAscOrder[index + 1].messageTimestamp);
                }

                const queryResultByDescOrder = await queryMessageRecord(db, {
                    orderBy: 'messageTimestamp',
                    orderDirection: 'desc'
                });

                for (let index = 0; index < queryResultByDescOrder.length - 1; index++) {
                    expect(queryResultByDescOrder[index].messageTimestamp)
                        .toBeGreaterThan(queryResultByDescOrder[index + 1].messageTimestamp);
                }
            });

            it('should support ordering by messageTimestamp', async () => {
                const queryResultOrderByTimestamp = await queryMessageRecord(db, {
                    orderBy: 'messageTimestamp',
                    orderDirection: 'asc'
                });

                for (let index = 0; index < queryResultOrderByTimestamp.length - 1; index++) {
                    expect(queryResultOrderByTimestamp[index].messageTimestamp)
                        .toBeLessThan(queryResultOrderByTimestamp[index + 1].messageTimestamp);
                }
            });

            it('should support pagination with offset', async () => {
                const resultWithOffset = await queryMessageRecord(db, {
                    offset: 2
                });

                const allRecords = await queryMessageRecord(db, {});
                expect(resultWithOffset.length).toBe(allRecords.length - 2);
            });

            it('should return empty array when no records match filters', async () => {
                const queryResultUnkown = await queryMessageRecord(db, {
                    type: 'non-existent-type'
                });

                expect(queryResultUnkown.length).toBe(0);
            });
        })

        describe('pushMessageToHistory', () => {

            it('should avoid insertion of duplicated message', async () => {
                const message = await createMessage();
                const senderPublicKey = message.publicKey;

                await pushMessageToHistory(db, { message, senderPublicKey, spaceId });
                await pushMessageToHistory(db, { message, senderPublicKey, spaceId });

                const messageRecords = await queryMessageRecord(db, {});
                expect(messageRecords.length).toBe(1);
            });
        });

        describe('flushMessageRecords', () => {

            let nonces = [];

            beforeEach(async () => {
                for (let index = 0; index < 5; index++) {
                    const nonce = hex(randomNonce());
                    const message = await createMessage({
                        type: 'base',
                        topic: `topic-index-${index}`,
                        nonce: nonce,
                        timestamp: index * 1000,
                        payload: {
                            data: `data-for-${index}`
                        }
                    });

                    await createMessageRecord(db, {
                        message: message,
                        spaceId: spaceId,
                        senderPublicKey: 'aaaa',
                        broadcastTimestamp: index * 2000
                    });

                    nonces.push(nonce);

                }
            });

            afterEach(() => { nonces = []; });

            it('should delete records matching exact id', async () => {
                const result = await flushMessageRecords(db, { id: 1 });
                expect(result.deleteCount).toBe(1);

                const remainingRecords = await queryMessageRecord(db, {});
                expect(remainingRecords.some(r => r.id === 1)).toBe(false);
            });

            it('should delete records matching exact type', async () => {
                const result = await flushMessageRecords(db, { type: 'base' });
                expect(result.deleteCount).toBe(5);

                const remainingRecords = await queryMessageRecord(db, {});
                expect(remainingRecords.every(r => r.type !== 'base')).toBe(true);
            });

            it('should delete records matching exact nonce', async () => {
                const result = await flushMessageRecords(db, { nonce: nonces[2] });
                expect(result.deleteCount).toBe(1);

                const remainingRecords = await queryMessageRecord(db, {});
                expect(remainingRecords.some(r => r.nonce === nonces[2])).toBe(false);
            });

            it('should delete records within broadcast timestamp range', async () => {
                const result = await flushMessageRecords(db, {
                    broadcastTimestamp: { start: 2000, end: 4000 }
                });
                expect(result.deleteCount).toBe(2);

                const remainingRecords = await queryMessageRecord(db, {});
                expect(remainingRecords.every(r => !(r.broadcastTimestamp >= 2000 && r.broadcastTimestamp <= 4000))).toBe(true);
            });

            it('should delete records within message timestamp range', async () => {
                const result = await flushMessageRecords(db, {
                    messageTimestamp: { start: 1000, end: 3000 }
                });
                expect(result.deleteCount).toBe(3);

                const remainingRecords = await queryMessageRecord(db, {});
                expect(remainingRecords.every(r => !(r.messageTimestamp >= 1000 && r.messageTimestamp <= 3000))).toBe(true);
            });

            it('should delete records matching payload substring', async () => {
                const result = await flushMessageRecords(db, { payloadContains: 'data-for-0' });
                expect(result.deleteCount).toBe(1);

                const remainingRecords = await queryMessageRecord(db, {});
                expect(remainingRecords.some(r => r.payload.data === 'data-for-0')).toBe(false);
            });

            it('should delete records matching message owner public key', async () => {
                const result = await flushMessageRecords(db, { ownerPublicKey: 'publicKey' });
                expect(result.deleteCount).toBe(0);
            });

            it('should support limiting the number of records to delete', async () => {
                const result = await flushMessageRecords(db, { limit: 3 });
                expect(result.deleteCount).toBe(3);

                const remainingRecords = await queryMessageRecord(db, {});
                expect(remainingRecords.length).toBe(2);
            })
        })
    });
});
