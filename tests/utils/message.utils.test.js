import { describe, it, beforeEach, beforeAll, afterEach, expect } from "vitest";
import {
    createMessageRecord,
    queryMessageRecord,
    flushMessageRecords,
    pushMessageToHistory,
} from "../../src/utils/message.utils.js";
import { createBaseMessage } from "../../src/utils/protocol.utils.js";
import { cleanup, createTempDatabase, generateKeypair } from "../general.utils.js";
import { now } from "../../src/utils/general.utils.js";
import { hex, randomNonce } from "../../src/utils/crypto.utils.js";
import { createSpaceForPublicKey } from "../../src/utils/space.utils.js";

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
            expect(result.type).toBe(message.type);
            expect(result.senderPublicKey).toBe(senderPublicKey);
            expect(result.broadcastTimestamp).toBe(broadcastTimestamp);
            expect(result.messageTimestamp).toBe(message.timestamp);
            expect(result.nonce).toBe(message.nonce);
            expect(result.ownerPublicKey).toBe(message.publicKey);
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