import { describe, it, beforeEach, expect } from "vitest";
import {
    createMessageFilter,
    createMessageRecord,
    queryMessageRecord,
    flushMessageRecord,
    pushMessageToHistory
} from "../../src/utils/message.utils.js";
import { createBaseMessage } from "../../src/utils/protocol.utils.js";
import { createTempDatabase, generateKeypair } from "../general.utils.js";
import { now } from "../../src/utils/general.utils";
import { hex } from "../../src/utils/crypto.utils.js";

const createMessage = async (overrides = {}) => {
    const keypair = await generateKeypair();

    return await createBaseMessage({
        type: 'test',
        topic: 'topic',
        nonce: 'abc',
        timestamp: now(),
        payload: { data: 10 },
        publicKey: hex(keypair.publicKey),
        secretKey: hex(keypair.secretKey),
        ...overrides
    });
}

describe('Message Utilities', () => {
    let db = null;

    beforeEach(async () => {
        const { db: dbInstance } = await createTempDatabase();
        db = dbInstance;

        for (let index = 0; index < 5; index++) {
            const message = await createMessage({
                type: 'base',
                topic: `topic-index-${index}`,
                nonce: `nonce-index-${index}`,
                timestamp: index * 1000,
                payload: {
                    data: `data-for-${index}`
                }
            });

            await createMessageRecord(db, {
                message: message,
                senderPublicKey: `sender-publicKey-index-${index}`,
                broadcastTimestamp: index * 2000
            });

        }
    })

    describe('createMessageRecord', () => {
        it('should create a message record successfully', async () => {
            const message = await createMessage();
            const senderPublicKey = message.publicKey;
            const broadcastTimestamp = now();

            const result = await createMessageRecord(db, {
                message: message,
                senderPublicKey: senderPublicKey,
                broadcastTimestamp: broadcastTimestamp
            });

            expect(result).toHaveProperty('id');
            expect(result.type).toBe(message.type);
            expect(result.topic).toBe(message.topic);
            expect(result.senderPublicKey).toBe(senderPublicKey);
            expect(result.broadcastTimestamp).toBe(broadcastTimestamp);
            expect(result.messageTimestamp).toBe(message.timestamp);
            expect(result.nonce).toBe(message.nonce);
            expect(result.messageOwnerPublicKey).toBe(message.publicKey);
            expect(result.isRelay).toBe(false); // sender = owner
        })

        it('should create a message record with correct relay parameter', async () => {
            const senderKeypair = await generateKeypair();
            const senderPublicKey = hex(senderKeypair.publicKey);

            const broadcastTimestamp = now();
            const message = await createMessage();

            const result = await createMessageRecord(db, {
                message: message,
                senderPublicKey: senderPublicKey,
                broadcastTimestamp: broadcastTimestamp
            });


            expect(result).toHaveProperty('id');
            expect(result.type).toBe(message.type);
            expect(result.topic).toBe(message.topic);
            expect(result.senderPublicKey).toBe(senderPublicKey);
            expect(result.broadcastTimestamp).toBe(broadcastTimestamp);
            expect(result.messageTimestamp).toBe(message.timestamp);
            expect(result.nonce).toBe(message.nonce);
            expect(result.messageOwnerPublicKey).toBe(message.publicKey);
            expect(result.isRelay).toBe(true); // sender != owner
        })
    })

    describe('queryMessageRecord', () => {
        it('should query all message records when no filter is provided', async () => {
            const result = await queryMessageRecord(db, {});
            expect(result.length).toBe(5);
        })

        it('should filter by id', async () => {
            const queryResultByID = await queryMessageRecord(db, { id: 1 });
            expect(queryResultByID.length).toBe(1);
            expect(queryResultByID[0].id).toBe(1);
        })

        it('should filter by topic', async () => {
            const queryResultByTopic = await queryMessageRecord(db, { topic: 'topic-index-2' });
            expect(queryResultByTopic.length).toBe(1);
            expect(queryResultByTopic[0].topic).toBe('topic-index-2');
        })

        it('should filter by type', async () => {
            const customMessage = await createMessage({
                type: 'custom',
            });

            await createMessageRecord(db, {
                message: customMessage,
                senderPublicKey: customMessage.publicKey,
                broadcastTimestamp: now()
            });

            const queryResultByType = await queryMessageRecord(db, { type: 'custom' });
            expect(queryResultByType.length).toBe(1);
        })

        it('should filter by relay parameter', async () => {
            const message = await createMessage();

            await createMessageRecord(db, {
                message: message,
                senderPublicKey: message.publicKey,
                broadcastTimestamp: now()
            });

            const queryResultByRelay = await queryMessageRecord(db, { isRelay: false });
            expect(queryResultByRelay.length).toBe(1);
            expect(queryResultByRelay[0].isRelay).toBe(false);
        })

        it('should filter by nonce', async () => {
            const queryResultByNonce = await queryMessageRecord(db, { nonce: 'nonce-index-2' });
            expect(queryResultByNonce.length).toBe(1);
            expect(queryResultByNonce[0].nonce).toBe('nonce-index-2');
        })

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
        })

        it('should filter by payloadContains', async () => {
            const queryResultByPayload = await queryMessageRecord(db, {
                payloadContains: 'data-for-0'
            });

            expect(queryResultByPayload.length).toBe(1);
            expect(queryResultByPayload[0].payload).toEqual({ data: 'data-for-0' });
        })

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
        })

        it('should support ordering by messageTimestamp', async () => {
            const queryResultOrderByTimestamp = await queryMessageRecord(db, {
                orderBy: 'messageTimestamp',
                orderDirection: 'asc'
            });

            for (let index = 0; index < queryResultOrderByTimestamp.length - 1; index++) {
                expect(queryResultOrderByTimestamp[index].messageTimestamp)
                    .toBeLessThan(queryResultOrderByTimestamp[index + 1].messageTimestamp);
            }
        })

        it('should support pagination with offset', async () => {
            const resultWithOffset = await queryMessageRecord(db, {
                offset: 2
            });

            const allRecords = await queryMessageRecord(db, {});
            expect(resultWithOffset.length).toBe(allRecords.length - 2);
        })

        it('should return empty array when no records match filters', async () => {
            const queryResultUnkown = await queryMessageRecord(db, {
                type: 'non-existent-type'
            });

            expect(queryResultUnkown.length).toBe(0);
        })
    })

    describe('pushMessageToHistory', () => {
        beforeEach(async () => {
            await flushMessageRecord(db, {}); // clear database
        });

        it('should avoid insertion of duplicated message', async () => {
            const message = await createMessage();
            const senderPublicKey = message.publicKey;
            const broadcastTimestamp = now();

            await pushMessageToHistory(db, { message, senderPublicKey });
            await pushMessageToHistory(db, { message, senderPublicKey });

            const messageRecords = await queryMessageRecord(db, {});
            expect(messageRecords.length).toBe(1);
        });
    });

    describe('flushMessageRecord', () => {
        it('should delete records matching exact id', async () => {
            const result = await flushMessageRecord(db, { id: 1 });
            expect(result.length).toBe(1);
            expect(result[0].id).toBe(1);

            const remainingRecords = await queryMessageRecord(db, {});
            expect(remainingRecords.some(r => r.id === 1)).toBe(false);
        })

        it('should delete records matching exact type', async () => {
            const result = await flushMessageRecord(db, { type: 'base' });
            expect(result.length).toBe(5);

            const remainingRecords = await queryMessageRecord(db, {});
            expect(remainingRecords.every(r => r.type !== 'base')).toBe(true);
        })

        it('should delete records matching exact topic', async () => {
            const result = await flushMessageRecord(db, { topic: 'topic-index-2' });
            expect(result.length).toBe(1);
            expect(result[0].topic).toBe('topic-index-2');

            const remainingRecords = await queryMessageRecord(db, {});
            expect(remainingRecords.some(r => r.topic === 'topic-index-2')).toBe(false);
        })

        it('should delete records matching exact nonce', async () => {
            const result = await flushMessageRecord(db, { nonce: 'nonce-index-3' });
            expect(result.length).toBe(1);

            const remainingRecords = await queryMessageRecord(db, {});
            expect(remainingRecords.some(r => r.nonce === 'nonce-index-3')).toBe(false);
        })

        it('should delete records matching relay status', async () => {
            const message = await createMessage();
            await createMessageRecord(db, {
                message: message,
                senderPublicKey: message.publicKey,
                broadcastTimestamp: now()
            });

            const result = await flushMessageRecord(db, { isRelay: false });
            expect(result.length).toBe(1);

            const remainingRecords = await queryMessageRecord(db, {});
            expect(remainingRecords.some(r => r.isRelay === false)).toBe(false);
        })

        it('should delete records matching sender public key', async () => {
            const result = await flushMessageRecord(db, { senderPublicKey: 'sender-publicKey-index-1' });
            expect(result.length).toBe(1);

            const remainingRecords = await queryMessageRecord(db, {});
            expect(remainingRecords.some(r => r.senderPublicKey === 'sender-publicKey-index-1')).toBe(false);
        })


        it('should delete records within broadcast timestamp range', async () => {
            const result = await flushMessageRecord(db, {
                broadcastTimestamp: { start: 2000, end: 4000 }
            });
            expect(result.length).toBe(2);

            const remainingRecords = await queryMessageRecord(db, {});
            expect(remainingRecords.every(r => !(r.broadcastTimestamp >= 2000 && r.broadcastTimestamp <= 4000))).toBe(true);
        })

        it('should delete records within message timestamp range', async () => {
            const result = await flushMessageRecord(db, {
                messageTimestamp: { start: 1000, end: 3000 }
            });
            expect(result.length).toBe(3);

            const remainingRecords = await queryMessageRecord(db, {});
            expect(remainingRecords.every(r => !(r.messageTimestamp >= 1000 && r.messageTimestamp <= 3000))).toBe(true);
        })

        it('should delete records matching payload substring', async () => {
            const result = await flushMessageRecord(db, { payloadContains: 'data-for-0' });
            expect(result.length).toBe(1);

            const remainingRecords = await queryMessageRecord(db, {});
            expect(remainingRecords.some(r => r.payload.data === 'data-for-0')).toBe(false);
        })

        it('should delete records matching message owner public key', async () => {
            const result = await flushMessageRecord(db, { messageOwnerPublicKey: 'publicKey' });
            expect(result.length).toBe(0);
        })

        it('should support limiting the number of records to delete', async () => {
            const result = await flushMessageRecord(db, { limit: 3 });
            expect(result.length).toBe(3);

            const remainingRecords = await queryMessageRecord(db, {});
            expect(remainingRecords.length).toBe(2);
        })
    })
})