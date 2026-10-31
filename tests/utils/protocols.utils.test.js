import { describe, it, expect, beforeEach } from 'vitest';
import * as EVENTS from '../../src/constants/events.constants.js';
import * as cryptoUtils from '../../src/utils/crypto.utils.js';
import * as protocolUtils from '../../src/utils/protocol.utils.js';
import { generateSpaceSecret } from '../../src/utils/space.utils.js';
import { buildTestProfilePayload, generateKeypair } from '../general.utils.js';
import { generateMerkleTree } from '../../src/utils/merkletree.utils.js';
import { Readable } from 'stream';

const { hex } = cryptoUtils;

describe('Protocol Messages', () => {
    let secretKey, publicKey;

    beforeEach(async () => {
        const keys = await generateKeypair();
        secretKey = hex(keys.secretKey);
        publicKey = hex(keys.publicKey);
    })

    describe('generateNonceFromPayoad', () => {
        it('should generate identical nonce for indentical payload', () => {
            const payloadOne = { data: 10 };
            const nonceOne = protocolUtils.generateNonceFromPayoad(payloadOne);
            const nonceTwo = protocolUtils.generateNonceFromPayoad(payloadOne);

            expect(nonceOne).toBe(nonceTwo);
            expect(nonceOne.length).toBe(24);
            expect(nonceTwo.length).toBe(24);
        })

        it('should generate different nonce with different payload', () => {
            const payloadOne = { data: 10 };
            const payloadTwo = { data: 11 };
            const nonceOne = protocolUtils.generateNonceFromPayoad(payloadOne);
            const nonceTwo = protocolUtils.generateNonceFromPayoad(payloadTwo);

            expect(nonceOne).not.toBe(nonceTwo);
            expect(nonceOne.length).toBe(24);
            expect(nonceTwo.length).toBe(24);
        })
    })

    describe('createBaseMessage', () => {

        it('creates a signed base message', async () => {
            const payload = { hello: 'world' }

            const msg = await protocolUtils.createBaseMessage({
                type: 'message',
                topic: 'test-topic',
                payload,
                secretKey: secretKey,
                publicKey: publicKey
            })

            expect(msg).toHaveProperty('type', 'message')
            expect(msg).toHaveProperty('topic', 'test-topic')
            expect(msg).toHaveProperty('payload')
            expect(msg).toHaveProperty('nonce')
            expect(msg).toHaveProperty('timestamp')
            expect(msg).toHaveProperty('signature')
            expect(msg).toHaveProperty('publicKey')

            expect(typeof msg.nonce).toBe('string')
            expect(typeof msg.timestamp).toBe('number')

            expect(msg.payload).toEqual(payload)
        })

        it('produces a verifiable signature', async () => {
            const payload = { foo: 'bar' }

            const msg = await protocolUtils.createBaseMessage({
                type: 'message',
                topic: 'topic',
                payload,
                secretKey: secretKey,
                publicKey: publicKey
            })

            const { signature, ...unsigned } = msg

            const isValid = await cryptoUtils.verifySignedJSON(unsigned, signature, publicKey)
            expect(isValid).toBe(true)
        })

        it('fails verification if payload is tampered', async () => {
            const payload = { secure: true }

            const msg = await protocolUtils.createBaseMessage({
                type: 'message',
                topic: 'topic',
                payload,
                secretKey,
                publicKey
            })

            // Tamper with payload
            msg.payload.secure = false

            const { signature, ...unsigned } = msg
            const isValid = await cryptoUtils.verifySignedJSON(unsigned, signature, publicKey)

            expect(isValid).toBe(false)
        })

        it('allows deterministic nonce and timestamp', async () => {
            const payload = { test: 123 }
            const fixedNonce = 'deadbeefdeadbeefdeadbeef'
            const fixedTimestamp = 1234567890

            const msg = await protocolUtils.createBaseMessage({
                type: 'message',
                topic: 'deterministic',
                payload,
                secretKey,
                publicKey,
                nonce: fixedNonce,
                timestamp: fixedTimestamp
            })

            expect(msg.nonce).toBe(fixedNonce)
            expect(msg.timestamp).toBe(fixedTimestamp)
        })

        it('generates unique nonce per message when not provided', async () => {

            const msg1 = await protocolUtils.createBaseMessage({
                type: 'message',
                topic: 'topic',
                payload: { a: 1 },
                secretKey,
                publicKey
            })

            const msg2 = await protocolUtils.createBaseMessage({
                type: 'message',
                topic: 'topic',
                payload: { a: 1 },
                secretKey,
                publicKey
            })

            expect(msg1.nonce).not.toBe(msg2.nonce)
        })
    })

    describe('validateBaseMessage', () => {
        it('should validate valid message', async () => {
            const validMessage = await protocolUtils.createBaseMessage({
                type: 'update',
                topic: 'some-space-topic',
                publicKey: publicKey,
                secretKey: secretKey,
                payload: { data: 123 }
            });

            const result = protocolUtils.validateBaseMessage(validMessage);
            expect(result.isValid).toBe(true);
        })

        it('should reject missing parameters', async () => {
            const validMessage = await protocolUtils.createBaseMessage({
                type: 'update',
                topic: 'some-space-topic',
                publicKey: publicKey,
                secretKey: secretKey,
                payload: { data: 123 }
            });

            const testCases = [
                { field: 'type', value: undefined, reason: 'type is required' },
                { field: 'topic', value: undefined, reason: 'topic is required' },
                { field: 'nonce', value: undefined, reason: 'nonce is required' },
                { field: 'publicKey', value: undefined, reason: 'publicKey is required' },
                { field: 'timestamp', value: undefined, reason: 'timestamp is required' },
                { field: 'signature', value: undefined, reason: 'signature is required' }
            ];

            testCases.forEach(({ field, value, reason }) => {
                const invalidMessage = { ...validMessage, [field]: value };
                const result = protocolUtils.validateBaseMessage(invalidMessage);
                expect(result.isValid).toBe(false);
                expect(result.reason).toBe(reason);
            });
        });

        it('should reject topic longer than 158 characters', async () => {
            const validMessage = await protocolUtils.createBaseMessage({
                type: 'update',
                topic: 'some-space-topic',
                publicKey: publicKey,
                secretKey: secretKey,
                payload: { data: 123 }
            });

            const message = { ...validMessage, topic: 'a'.repeat(159) };
            const result = protocolUtils.validateBaseMessage(message);
            expect(result.isValid).toBe(false);
            expect(result.reason).toBe('topic should not be larger than 158 characters');
        })

        it('should reject invalid nonce', async () => {
            const validMessage = await protocolUtils.createBaseMessage({
                type: 'update',
                topic: 'some-space-topic',
                publicKey: publicKey,
                secretKey: secretKey,
                payload: { data: 123 }
            });

            const shortNonceMessage = { ...validMessage, nonce: 'a'.repeat(9) };
            const shortNonceResult = protocolUtils.validateBaseMessage(shortNonceMessage);

            const badHexNonceMessage = { ...validMessage, nonce: 'x'.repeat(24) };
            const badHexNonceResult = protocolUtils.validateBaseMessage(badHexNonceMessage);

            expect(shortNonceResult.isValid).toBe(false);
            expect(shortNonceResult.reason).toBe('nonce should be 24 characters long');

            expect(badHexNonceResult.isValid).toBe(false);
            expect(badHexNonceResult.reason).toBe('nonce should be a valid hex string');
        })

        it('should reject invalid publicKeys', async () => {
            const validMessage = await protocolUtils.createBaseMessage({
                type: 'update',
                topic: 'some-space-topic',
                publicKey: publicKey,
                secretKey: secretKey,
                payload: { data: 123 }
            });

            const numericalPublicKeyMessage = { ...validMessage, publicKey: 123 };
            const numericalPublicKeyResult = protocolUtils.validateBaseMessage(numericalPublicKeyMessage);

            const shortPublicKeyMessage = { ...validMessage, publicKey: 'a'.repeat(12) };
            const shortPublicKeyResult = protocolUtils.validateBaseMessage(shortPublicKeyMessage);

            const badHexPublicKeyMessage = { ...validMessage, publicKey: 'x'.repeat(64) };
            const badHexPublicKeyResult = protocolUtils.validateBaseMessage(badHexPublicKeyMessage);

            expect(numericalPublicKeyResult.isValid).toBe(false);
            expect(numericalPublicKeyResult.reason).toBe('publicKey should be a string');

            expect(shortPublicKeyResult.isValid).toBe(false);
            expect(shortPublicKeyResult.reason).toBe('publicKey should be 64 characters long');

            expect(badHexPublicKeyResult.isValid).toBe(false);
            expect(badHexPublicKeyResult.reason).toBe('publicKey should be a valid hex string');
        })

        it('should reject invalid timestamp', async () => {
            const validMessage = await protocolUtils.createBaseMessage({
                type: 'update',
                topic: 'some-space-topic',
                publicKey: publicKey,
                secretKey: secretKey,
                payload: { data: 123 }
            });

            const badTimeStampMessage = { ...validMessage, timestamp: -1000 };
            const badTimeStampResult = protocolUtils.validateBaseMessage(badTimeStampMessage);

            expect(badTimeStampResult.isValid).toBe(false);
            expect(badTimeStampResult.reason).toBe('timestamp should be a valid date');
        })

        it('should reject invalid signatures', async () => {
            const validMessage = await protocolUtils.createBaseMessage({
                type: 'update',
                topic: 'some-space-topic',
                publicKey: publicKey,
                secretKey: secretKey,
                payload: { data: 123 }
            });

            const numericalSignatureMessage = { ...validMessage, signature: 123 };
            const numericalSignatureResult = protocolUtils.validateBaseMessage(numericalSignatureMessage);

            const shortSignatureMessage = { ...validMessage, signature: 'a'.repeat(127) };
            const shortSignatureResult = protocolUtils.validateBaseMessage(shortSignatureMessage);

            const badHexSignatureMessage = { ...validMessage, signature: 'x'.repeat(128) };
            const badHexSignatureResult = protocolUtils.validateBaseMessage(badHexSignatureMessage);

            expect(numericalSignatureResult.isValid).toBe(false);
            expect(numericalSignatureResult.reason).toBe('signature should be a string');

            expect(shortSignatureResult.isValid).toBe(false);
            expect(shortSignatureResult.reason).toBe('signature should be 128 characters long');

            expect(badHexSignatureResult.isValid).toBe(false);
            expect(badHexSignatureResult.reason).toBe('signature should be a valid hex string');
        })
    })

    describe('verifyMessageSignature', () => {
        it('should return true for a valid signed message', async () => {
            const payload = { foo: 'bar' }

            const message = await protocolUtils.createBaseMessage({
                type: 'test',
                topic: 'topic',
                payload: payload,
                secretKey: secretKey,
                publicKey: publicKey
            })

            const result = await protocolUtils.verifyMessageSignature(message);
            expect(result).toBe(true)
        })

        it('should return false if payload is tampered', async () => {
            const payload = { secure: true }

            const msg = await protocolUtils.createBaseMessage({
                type: 'test',
                topic: 'topic',
                payload,
                secretKey: secretKey,
                publicKey: publicKey
            })

            // Tamper payload
            msg.payload.secure = false

            const result = await protocolUtils.verifyMessageSignature(msg)
            expect(result).toBe(false)
        })

        it('should throw error if signature is missing', async () => {
            const payload = { foo: 'bar' }

            const message = await protocolUtils.createBaseMessage({
                type: 'test',
                topic: 'topic',
                payload: payload,
                secretKey: secretKey,
                publicKey: publicKey
            })

            delete message.signature
            await expect(protocolUtils.verifyMessageSignature(message)).rejects.toThrow(
                'Message missing signature or publicKey'
            )
        })

        it('should throw error if publicKey is missing', async () => {
            const payload = { foo: 'bar' }

            const msg = await protocolUtils.createBaseMessage({
                type: 'test',
                topic: 'topic',
                payload,
                secretKey: secretKey,
                publicKey: publicKey
            })

            delete msg.publicKey

            await expect(protocolUtils.verifyMessageSignature(msg)).rejects.toThrow(
                'Message missing signature or publicKey'
            )
        })
    })

    describe('createRejectionMessage', () => {

        it('creates a rejection message with given reason', async () => {
            const topic = 'some random topic';
            const replyNonce = hex(cryptoUtils.randomNonce());
            const reason = 'invalid message !';

            const msg = await protocolUtils.createRejectionMessage({
                topic: topic,
                linkedMessageNonce: replyNonce,
                reason: reason,
                secretKey,
                publicKey
            });

            expect(msg.type).toBe(EVENTS.Reject);
            expect(msg.topic).toBe(topic);
            expect(msg.payload.linkedMessageNonce).toBe(replyNonce);
            expect(msg.payload.reason).toBe(reason);

            const valid = await protocolUtils.verifyMessageSignature(msg);
            expect(valid).toBe(true);
        })

        it('throws error if required fields are missing', async () => {
            await expect(protocolUtils.createRejectionMessage({
                topic: 't1',
                linkedMessageNonce: 'nonce',
                reason: 'reason',
                secretKey: null,
                publicKey
            })).rejects.toThrow('secretKey is required');
        })
    })

    describe('createProfileUpdateMessage', () => {
        it('creates and verifies a signed profile update message', async () => {
            const profile = await buildTestProfilePayload({ username: 'bob' });
            const topics = ['a'.repeat(64)];

            const msg = await protocolUtils.createProfileUpdateMessage({
                profile,
                topics: topics,
                secretKey,
                publicKey
            });

            expect(msg.type).toBe(EVENTS.ProfileUpdate);
            expect(msg.payload).toEqual({ profile, topics });
            expect(msg.publicKey).toBeDefined();
            expect(msg.signature).toBeDefined();

            const valid = await protocolUtils.verifyMessageSignature(msg);
            expect(valid).toBe(true);
        })
    })

    describe('createSpaceSyncMessage', () => {
        it('creates and verifies a signed space sync message', async () => {

            const topic = 'My Space topic'

            const space = {
                name: 'My Space',
                owner: publicKey,
                secret: generateSpaceSecret()
            }

            const msg = await protocolUtils.createSpaceSyncMessage({
                topic,
                space,
                secretKey,
                publicKey
            })

            expect(msg.type).toBe(EVENTS.SpaceSync)
            expect(msg.topic).toBe(topic)
            expect(msg.payload).toEqual(space)
            expect(msg.publicKey).toBeDefined()
            expect(msg.signature).toBeDefined()

            const valid = await protocolUtils.verifyMessageSignature(msg)
            expect(valid).toBe(true)
        })
    })

    describe('createSpaceHashListMessage', () => {
        it('creates and verifies a signed space-hash list message', async () => {

            const hashList = [
                'a1b2c3d4',
                'deadbeef',
                'ff001122'
            ]

            const msg = await protocolUtils.createSpaceHashListMessage({
                hashList,
                secretKey,
                publicKey
            })

            expect(msg.type).toBe(EVENTS.SpaceHashList)
            expect(msg.topic).toBe(EVENTS.noTopic)
            expect(msg.payload).toEqual(hashList)
            expect(Array.isArray(msg.payload)).toBe(true)
            expect(msg.publicKey).toBeDefined()
            expect(msg.signature).toBeDefined()

            // cryptographic verification
            const valid = await protocolUtils.verifyMessageSignature(msg)
            expect(valid).toBe(true)
        })
    })

    describe('validateSpaceHashListPayload', () => {
        it('should validate valid spaceHashList payload', async () => {
            const message = await protocolUtils.createSpaceHashListMessage({
                hashList: Array(10).fill().map(() => 'a'.repeat(64)),
                publicKey: publicKey,
                secretKey: secretKey
            });

            const spaceHashListResult = protocolUtils.validateSpaceHashListPayload(message);

            expect(spaceHashListResult.isValid).toBe(true);
        })

        it('should reject invalid spaceHashList payload', async () => {
            const messageWithShortHashes = await protocolUtils.createSpaceHashListMessage({
                hashList: Array(10).fill().map(() => 'a'.repeat(63)),
                publicKey: publicKey,
                secretKey: secretKey
            });

            const messageWithBadHex = await protocolUtils.createSpaceHashListMessage({
                hashList: Array(10).fill().map(() => 'x'.repeat(64)),
                publicKey: publicKey,
                secretKey: secretKey
            });

            const messageWithLongPayload = await protocolUtils.createSpaceHashListMessage({
                hashList: Array(65).fill().map(() => 'a'.repeat(64)),
                publicKey: publicKey,
                secretKey: secretKey
            });

            const shortHashResult = protocolUtils.validateSpaceHashListPayload(messageWithShortHashes);
            const badHexResult = protocolUtils.validateSpaceHashListPayload(messageWithBadHex);
            const longPayloadResult = protocolUtils.validateSpaceHashListPayload(messageWithLongPayload);

            expect(shortHashResult.isValid).toBe(false);
            expect(shortHashResult.reason).toBe('in SpaceHashList, each hash should be 64 characters long');

            expect(badHexResult.isValid).toBe(false);
            expect(badHexResult.reason).toBe('in SpaceHashList, each hash should be a valid hex string');

            expect(longPayloadResult.isValid).toBe(false);
            expect(longPayloadResult.reason).toBe('SpaceHashList payload array should not exceed 64 elements');
        })
    })

    describe('createSpaceMessage', () => {
        it('creates and verifies a signed space message', async () => {

            const topic = 'hello-space'

            const messagePayload = {
                text: 'Hello space',
                attachments: [],
                version: 1
            }

            const msg = await protocolUtils.createSpaceMessage({
                topic,
                messagePayload,
                secretKey,
                publicKey
            })

            expect(msg.type).toBe(EVENTS.SpaceMessage)
            expect(msg.topic).toBe(topic)
            expect(msg.payload).toEqual(messagePayload)
            expect(msg.publicKey).toBeDefined()
            expect(msg.signature).toBeDefined()

            const valid = await protocolUtils.verifyMessageSignature(msg)
            expect(valid).toBe(true)
        })
    })

    describe('encryptPayload', () => {
        it('should encrypt space message payload while preserving signature validity', async () => {
            const topic = 'space-enc-test';
            const originalPayload = { text: 'Encrypted hello' };
            const spaceSecret = generateSpaceSecret();
            const nonce = hex(cryptoUtils.randomNonce());

            const encryptedPayload = await protocolUtils.encryptPayload({
                payload: originalPayload,
                spaceSecret: spaceSecret,
                nonce: nonce
            });

            const encryptedMsg = await protocolUtils.createSpaceMessage({
                topic,
                messagePayload: encryptedPayload,
                secretKey,
                publicKey,
                nonce: nonce
            });

            const valid = await protocolUtils.verifyMessageSignature(encryptedMsg);
            expect(valid).toBe(true);
        })
    })

    describe('decryptPayload', () => {
        it('should decrypt space message payload for valid encrypted payload', async () => {
            const topic = 'space-enc-test';
            const originalPayload = { text: 'Encrypted hello' };
            const spaceSecret = generateSpaceSecret();
            const nonce = hex(cryptoUtils.randomNonce());

            const encryptedPayload = await protocolUtils.encryptPayload({
                payload: originalPayload,
                spaceSecret: spaceSecret,
                nonce: nonce
            });

            const encryptedMsg = await protocolUtils.createSpaceMessage({
                topic,
                messagePayload: encryptedPayload,
                secretKey,
                publicKey,
                nonce: nonce
            });

            const valid = await protocolUtils.verifyMessageSignature(encryptedMsg);
            expect(valid).toBe(true);

            const decrypted = await protocolUtils.decryptPayload({
                payload: encryptedMsg.payload,
                spaceSecret: spaceSecret,
                nonce: encryptedMsg.nonce
            });

            expect(decrypted).toEqual(originalPayload);
        })
    })

    describe('validateSpaceFileEventPayload', () => {

        const publicKey = 'a'.repeat(64);

        const validAddEvent = {
            action: 'add',
            files: [
                ['/file.mp4', publicKey, 1712345678, 'a'.repeat(64), 'a'.repeat(128)],
                ['/movies/file2.mp4', publicKey, 1712345679, 'b'.repeat(64), 'b'.repeat(128)],
            ],
        };

        const validRemoveEvent = {
            action: 'remove',
            files: [
                ['/old.mp4', publicKey, 1712345680, 'c'.repeat(64), 'c'.repeat(128)],
            ],
        };

        it('should return true for fully valid payload', async () => {
            const message = await protocolUtils.createSpaceFileEventMessage({
                topic: 'file-topic',
                publicKey,
                secretKey,
                events: [validAddEvent, validRemoveEvent],
            });

            const result = protocolUtils.validateSpaceFileEventPayload(message);
            expect(result.isValid).toBe(true);
            expect(result.reason).toBe('payload is valid');
        });

        it('should accept an empty events array', async () => {
            const message = await protocolUtils.createSpaceFileEventMessage({
                topic: 'file-topic',
                publicKey,
                secretKey,
                events: [],
            });

            const result = protocolUtils.validateSpaceFileEventPayload(message);
            expect(result.isValid).toBe(true);
            expect(result.reason).toBe('payload is valid');
        });

        it('should reject when payload is not an array', async () => {
            const message = await protocolUtils.createSpaceFileEventMessage({
                topic: 'file-topic',
                publicKey,
                secretKey,
                events: { foo: 'not an array' },
            });

            const result = protocolUtils.validateSpaceFileEventPayload(message);
            expect(result.isValid).toBe(false);
            expect(result.reason).toBe('payload should be an array');
        });

        it('should reject when payload contains non-object elements', async () => {
            const message = await protocolUtils.createSpaceFileEventMessage({
                topic: 'file-topic',
                publicKey,
                secretKey,
                events: ['string', 123, null],
            });

            const result = protocolUtils.validateSpaceFileEventPayload(message);
            expect(result.isValid).toBe(false);
            expect(result.reason).toBe('payload should contain only objects');
        });

        it('should reject when action is not in SpaceFileEvent', async () => {
            const message = await protocolUtils.createSpaceFileEventMessage({
                topic: 'file-topic',
                publicKey,
                secretKey,
                events: [{ action: 'random', files: [] }],
            });

            const result = protocolUtils.validateSpaceFileEventPayload(message);
            expect(result.isValid).toBe(false);
            expect(result.reason).toBe('event actions should be valid');
        });

        it('should reject when event lacks files array', async () => {
            const message = await protocolUtils.createSpaceFileEventMessage({
                topic: 'file-topic',
                publicKey,
                secretKey,
                events: [{ action: 'random', }], // no files key
            });

            const result = protocolUtils.validateSpaceFileEventPayload(message);
            expect(result.isValid).toBe(false);
            expect(result.reason).toBe('event actions should be valid');
        });

        it('should reject for invalid file path', async () => {
            const message = await protocolUtils.createSpaceFileEventMessage({
                topic: 'file-topic',
                publicKey,
                secretKey,
                events: [{ action: 'add', files: ['very^bad/path', 123, 'abc'] }], // bad file path
            });

            const result = protocolUtils.validateSpaceFileEventPayload(message);
            expect(result.isValid).toBe(false);
            expect(result.reason).toBe('event actions should be valid');
        });

        it('should reject for invalid timestamp', async () => {
            const message = await protocolUtils.createSpaceFileEventMessage({
                topic: 'file-topic',
                publicKey,
                secretKey,
                events: [{ action: 'add', files: ['movies/file.mp4', null, 'abc'] }], // null timestamp
            });

            const result = protocolUtils.validateSpaceFileEventPayload(message);
            expect(result.isValid).toBe(false);
            expect(result.reason).toBe('event actions should be valid');
        });

        it('should reject event with invalid signature format', async () => {
            const message = await protocolUtils.createSpaceFileEventMessage({
                topic: 'file-topic',
                publicKey,
                secretKey,
                events: [{ action: 'add', files: ['movies/file.mp4', 123, 'xxx'] }], // null timestamp
            });

            const result = protocolUtils.validateSpaceFileEventPayload(message);
            expect(result.isValid).toBe(false);
            expect(result.reason).toBe('event actions should be valid');
        });
    });

    describe('createSpaceFileRecordSignature', () => {
        it('should create valid signature from file record', async () => {
            const { publicKey, secretKey } = await generateKeypair();
            const record = {
                topic: 'topic',
                path: '/file1.txt',
                rootHash: 'hash1',
                publicKey: publicKey,
                timestamp: 1000
            };

            const signature = await protocolUtils.createSpaceFileRecordSignature({
                ...record,
                secretKey: secretKey
            });

            expect(typeof signature).toBe('string');
            expect(signature.length).toBe(128);
        });
    });

    describe('verifySpaceFileRecordSignature', () => {
        it('should verify valid file record signature', async () => {
            const { publicKey, secretKey } = await generateKeypair();
            const record = {
                topic: 'topic',
                path: '/file1.txt',
                rootHash: 'hash1',
                publicKey: publicKey,
                timestamp: 1000
            };

            const signature = await protocolUtils.createSpaceFileRecordSignature({
                ...record,
                secretKey: secretKey
            });

            const result = await protocolUtils.verifySpaceFileRecordSignature({
                ...record,
                signature
            });

            expect(result).toBe(true);
        });
    });

    describe('validateSpaceFileTreeRequestPayload', () => {
        const validSpacePath = '/root/movie.mp4';
        const validRootHash = 'a'.repeat(32);

        it('should return true for valid payload', async () => {
            const message = await protocolUtils.createSpaceFileTreeRequestMessage({
                topic: 'some-space-topic',
                rootHash: 'a'.repeat('64'),
                spaceFilePath: validSpacePath,
                publicKey: publicKey,
                secretKey: secretKey
            });

            const result = protocolUtils.validateSpaceFileTreeRequestPayload(message);
            expect(result.isValid).toBe(true);
        });

        it('should return false for invalid rootHash', async () => {
            const invalidPayloads = [
                { rootHash: 123, spaceFilePath: validSpacePath }, // not string
                { rootHash: 'zz'.repeat(32), spaceFilePath: validSpacePath }, // invalid hex
                { rootHash: '', spaceFilePath: validSpacePath } // empty string (invalid hex)
            ];

            for (const payload of invalidPayloads) {
                const message = {
                    topic: 'space-topic',
                    payload: {
                        rootHash: payload.rootHash,
                        spaceFilePath: payload.spaceFilePath,
                    },
                    publicKey,
                    secretKey
                };

                const status = protocolUtils.validateSpaceFileTreeRequestPayload(message);
                expect(status.isValid).toBe(false);
                expect(status.reason).toMatch(/rootHash/i);
            }
        });

        it('should return false for invalid spaceFilePath', async () => {
            const invalidPayloads = [
                { rootHash: validRootHash, spaceFilePath: undefined }, // missing
                { rootHash: validRootHash, spaceFilePath: ['root'] }, // not string
                { rootHash: validRootHash, spaceFilePath: '/root/../movie' }, // path traversal '..'
                { rootHash: validRootHash, spaceFilePath: '/root/./movie' }, // path traversal '.'
                { rootHash: validRootHash, spaceFilePath: '../secret' } // leading '..'
            ];

            for (const payload of invalidPayloads) {
                const message = {
                    topic: 'space-topic',
                    payload: {
                        rootHash: payload.rootHash,
                        spaceFilePath: payload.spaceFilePath,
                    },
                    publicKey,
                    secretKey
                };

                const status = protocolUtils.validateSpaceFileTreeRequestPayload(message);
                
                expect(status.isValid).toBe(false);
                expect(status.reason).toMatch(/spaceFilePath/i);
            }
        });
    });

    describe('validateSpaceFileTreeResponsePayload', () => {
        let tree = null;
        beforeEach(async () => {
            const block = c => Buffer.alloc(1024, c);
            const chunks = [ block('a'), block('b'), block('c') ];

            tree = await generateMerkleTree({
                stream: Readable.from(chunks),
                size: chunks.length * 1024,
                chunkSize: 1024
            });
        });

        it('should return true for valid payload', async () => {
            const message = await protocolUtils.createSpaceFileTreeResponseMessage({
                topic: 'space-topic',
                tree: tree,
                lastRequestableLeaf: 10,
                replyNonce: 'a'.repeat(24),
                publicKey: publicKey,
                secretKey: secretKey,
            });

            const status = protocolUtils.validateSpaceFileTreeResponsePayload(message);
            expect(status.isValid).toBe(true);
        });
    });

    it('should return false when tree is invalid', () => {
        const payloads = [
            { lastRequestableLeaf: 1, replyNonce: 'a'.repeat(24), tree: undefined },
            { lastRequestableLeaf: 1, replyNonce: 'a'.repeat(24), tree: { bad: 'format' } },
        ];

        for (const payload of payloads) {
            const message = { payload: payload };
            const status = protocolUtils.validateSpaceFileTreeResponsePayload(message);

            expect(status.isValid).toBe(false);
        }
    });

    describe('createNegentropySyncMessage', () => {
        const sessionId = 'a'.repeat(24);

        it('should create a signed NegentropySync message', async () => {
            const ranges = [{ upperBound: null, mode: EVENTS.NegentropyModeOptions.ID_LIST, ids: [] }];
            const message = await protocolUtils.createNegentropySyncMessage({
                topic: 'b'.repeat(64), sessionId, ranges, publicKey, secretKey,
            });

            expect(message.type).toBe(EVENTS.NegentropySync);
            expect(message.payload).toEqual({ sessionId, ranges });
            expect(await protocolUtils.verifyMessageSignature(message)).toBe(true);
        });

        it('should require a valid session id and a ranges array', async () => {
            const params = { topic: 'b'.repeat(64), sessionId, ranges: [], publicKey, secretKey };

            await expect(protocolUtils.createNegentropySyncMessage({ ...params, sessionId: 'abc' })).rejects.toThrow();
            await expect(protocolUtils.createNegentropySyncMessage({ ...params, ranges: null })).rejects.toThrow();
        });
    });

    describe('validateNegentropySyncPayload', () => {
        const Mode = EVENTS.NegentropyModeOptions;
        const sessionId = 'a'.repeat(24);
        const bound = (timestamp, fill = 'a') => ({ timestamp, messageId: fill.repeat(64) });
        const isValid = (ranges, limits, payload = { sessionId, ranges }) =>
            protocolUtils.validateNegentropySyncPayload({ payload }, limits).isValid;

        it('should accept an empty ranges list (end of session)', () => {
            expect(isValid([])).toBe(true);
        });

        it('should accept every range mode', () => {
            expect(isValid([
                { upperBound: bound(1), mode: Mode.SKIP },
                { upperBound: bound(2), mode: Mode.FINGERPRINT, fingerprint: '0'.repeat(32) },
                { upperBound: bound(3), mode: Mode.ID_LIST, ids: ['b'.repeat(64)] },
                { upperBound: null, mode: Mode.ID_LIST_RESPONSE, ids: [] },
            ])).toBe(true);
        });

        it('should reject malformed payloads and session ids', () => {
            expect(isValid(null, {}, null)).toBe(false);
            expect(isValid([], {}, { sessionId: 'xyz', ranges: [] })).toBe(false);
            expect(isValid(null, {}, { sessionId, ranges: 'nope' })).toBe(false);
            expect(isValid([null])).toBe(false);
        });

        it('should only allow an open-ended bound on the last range', () => {
            expect(isValid([{ upperBound: null, mode: Mode.SKIP }, { upperBound: null, mode: Mode.SKIP }])).toBe(false);
        });

        it('should require strictly increasing bounds', () => {
            expect(isValid([{ upperBound: bound(2), mode: Mode.SKIP }, { upperBound: bound(1), mode: Mode.SKIP }])).toBe(false);
            expect(isValid([{ upperBound: bound(1), mode: Mode.SKIP }, { upperBound: bound(1), mode: Mode.SKIP }])).toBe(false);
            expect(isValid([{ upperBound: bound(1, 'a'), mode: Mode.SKIP }, { upperBound: bound(1, 'b'), mode: Mode.SKIP }])).toBe(true);
        });

        it('should reject malformed bounds, fingerprints, id lists and modes', () => {
            expect(isValid([{ upperBound: { timestamp: -1, messageId: 'a'.repeat(64) }, mode: Mode.SKIP }])).toBe(false);
            expect(isValid([{ upperBound: { timestamp: 1, messageId: 'A'.repeat(64) }, mode: Mode.SKIP }])).toBe(false);
            expect(isValid([{ upperBound: null, mode: Mode.FINGERPRINT, fingerprint: 'xyz' }])).toBe(false);
            expect(isValid([{ upperBound: null, mode: Mode.ID_LIST, ids: ['nope'] }])).toBe(false);
            expect(isValid([{ upperBound: null, mode: Mode.ID_LIST_RESPONSE }])).toBe(false);
            expect(isValid([{ upperBound: null, mode: 'unknown' }])).toBe(false);
        });

        it('should enforce maxRanges and maxIdListSize', () => {
            const skips = [{ upperBound: bound(1), mode: Mode.SKIP }, { upperBound: bound(2), mode: Mode.SKIP }];
            expect(isValid(skips, { maxRanges: 1 })).toBe(false);
            expect(isValid(skips, { maxRanges: 2 })).toBe(true);

            const ids = ['a'.repeat(64), 'b'.repeat(64)];
            expect(isValid([{ upperBound: null, mode: Mode.ID_LIST, ids }], { maxIdListSize: 1 })).toBe(false);
            expect(isValid([{ upperBound: null, mode: Mode.ID_LIST, ids }], { maxIdListSize: 2 })).toBe(true);
        });
    });
})

describe('Negentropy message delivery utils', () => {
    const topic = 'a'.repeat(64);
    const assignmentKey = 'b'.repeat(24);
    const messageId = 'c'.repeat(64);

    let author;
    let authorPublicKey;
    let authorSecretKey;

    beforeEach(async () => {
        author = await generateKeypair();
        authorPublicKey = cryptoUtils.hex(author.publicKey);
        authorSecretKey = cryptoUtils.hex(author.secretKey);
    });

    /** A stored row, as the messages table returns it. */
    const toRecord = message => ({
        type: message.type,
        ownerPublicKey: message.publicKey,
        nonce: message.nonce,
        messageTimestamp: message.timestamp,
        signature: message.signature,
        payload: cryptoUtils.canonicalStringify(message.payload),
    });

    const createAuthored = payload => protocolUtils.createSpaceMessage({
        topic,
        messagePayload: payload,
        publicKey: authorPublicKey,
        secretKey: authorSecretKey,
    });

    describe('buildCanonicalMessageString', () => {
        const payloads = {
            'plain object': { text: 'hello', n: 1 },
            'nested and unordered keys': { z: [3, { y: true, a: null }], a: { c: 1.5, b: 'x' } },
            'escapes and unicode': { text: 'quote " backslash \\ newline \n tab \t emoji 🍐  ' },
            'encrypted (string) payload': 'ab'.repeat(40),
        };

        for (const [name, payload] of Object.entries(payloads)) {
            it(`should equal canonicalStringify of the unsigned message: ${name}`, () => {
                const header = { type: EVENTS.SpaceMessage, topic, publicKey: authorPublicKey, nonce: 'd'.repeat(24), timestamp: 1767225600000 };

                const spliced = protocolUtils.buildCanonicalMessageString(header, cryptoUtils.canonicalStringify(payload));

                expect(spliced).toBe(cryptoUtils.canonicalStringify({ ...header, payload }));
            });
        }
    });

    describe('verifyDeliveredMessage', () => {
        it('should verify the original signature from the stored canonical payload', async () => {
            const message = await createAuthored({ text: 'stored once, verified without parsing' });
            const delivered = protocolUtils.toDeliverableMessage(toRecord(message));

            expect(await protocolUtils.verifyDeliveredMessage(topic, delivered)).toBe(true);
        });

        it('should reject a tampered payload, header or topic', async () => {
            const message = await createAuthored({ text: 'original' });
            const delivered = protocolUtils.toDeliverableMessage(toRecord(message));

            expect(await protocolUtils.verifyDeliveredMessage(topic, { ...delivered, canonicalPayload: '{"text":"forged"}' })).toBe(false);
            expect(await protocolUtils.verifyDeliveredMessage(topic, { ...delivered, timestamp: delivered.timestamp + 1 })).toBe(false);
            expect(await protocolUtils.verifyDeliveredMessage('e'.repeat(64), delivered)).toBe(false);
        });

        it('should compute the same id as the stored record', async () => {
            const { computeMessageId } = await import('../../src/utils/message.utils.js');
            const message = await createAuthored({ text: 'id' });
            const record = toRecord(message);

            expect(protocolUtils.computeDeliveredMessageId(protocolUtils.toDeliverableMessage(record)))
                .toBe(computeMessageId({ ...message, payload: record.payload }));
        });
    });

    describe('NegentropyContentRequest', () => {
        it('should create a valid signed request', async () => {
            const message = await protocolUtils.createNegentropyContentRequestMessage({
                topic, assignmentKey, messageIds: [messageId], publicKey: authorPublicKey, secretKey: authorSecretKey,
            });

            expect(message.type).toBe(EVENTS.NegentropyContentRequest);
            expect(message.payload).toEqual({ assignmentKey, messageIds: [messageId] });
            expect(await protocolUtils.verifyMessageSignature(message)).toBe(true);
            expect(protocolUtils.validateNegentropyContentRequestPayload(message).isValid).toBe(true);
        });

        it('should reject invalid payloads', () => {
            const validate = payload => protocolUtils.validateNegentropyContentRequestPayload({ payload }, { maxIds: 2 }).reason;

            expect(validate(null)).toBe('payload should be an object');
            expect(validate({ assignmentKey: 'xyz', messageIds: [messageId] })).toBe('assignmentKey should be 24 character hex string');
            expect(validate({ assignmentKey, messageIds: [] })).toBe('messageIds should not be empty');
            expect(validate({ assignmentKey, messageIds: [messageId, messageId, messageId] })).toBe('too many message ids');
            expect(validate({ assignmentKey, messageIds: ['not-hex'] })).toBe('invalid message id');
        });
    });

    describe('NegentropyContentCancel', () => {
        it('should create whole and partial cancellations', async () => {
            const params = { topic, assignmentKey, publicKey: authorPublicKey, secretKey: authorSecretKey };

            const whole = await protocolUtils.createNegentropyContentCancelMessage(params);
            const partial = await protocolUtils.createNegentropyContentCancelMessage({ ...params, messageIds: [messageId] });

            expect(whole.payload).toEqual({ assignmentKey });
            expect(partial.payload).toEqual({ assignmentKey, messageIds: [messageId] });
            expect(protocolUtils.validateNegentropyContentCancelPayload(whole).isValid).toBe(true);
            expect(protocolUtils.validateNegentropyContentCancelPayload(partial).isValid).toBe(true);
        });

        it('should reject invalid payloads', () => {
            const validate = payload => protocolUtils.validateNegentropyContentCancelPayload({ payload }).reason;

            expect(validate({ assignmentKey: 'xyz' })).toBe('assignmentKey should be 24 character hex string');
            expect(validate({ assignmentKey, messageIds: 'm1' })).toBe('messageIds should be an array');
            expect(validate({ assignmentKey, messageIds: [] })).toBe('messageIds should not be empty');
            expect(validate({ assignmentKey, messageIds: ['bad'] })).toBe('invalid message id');
        });
    });

    describe('NegentropyContentDelivery', () => {
        it('should create a valid signed delivery carrying one canonical string', async () => {
            const authored = await createAuthored({ text: 'deliver me' });
            const delivered = protocolUtils.toDeliverableMessage(toRecord(authored));

            const message = await protocolUtils.createNegentropyContentDeliveryMessage({
                topic, assignmentKey, content: delivered, publicKey: authorPublicKey, secretKey: authorSecretKey,
            });

            expect(message.type).toBe(EVENTS.NegentropyContentDelivery);
            expect(message.payload.content.canonicalPayload).toBe('{"text":"deliver me"}');
            expect(await protocolUtils.verifyMessageSignature(message)).toBe(true);
            expect(protocolUtils.validateNegentropyContentDeliveryPayload(message).isValid).toBe(true);
        });

        it('should reject invalid delivered content', async () => {
            const authored = await createAuthored({ text: 'x' });
            const delivered = protocolUtils.toDeliverableMessage(toRecord(authored));
            const validate = content => protocolUtils.validateNegentropyContentDeliveryPayload({ payload: { assignmentKey, content } }).reason;

            expect(validate([delivered])).toBe('content should be an object');
            expect(validate({ ...delivered, publicKey: 'xyz' })).toBe('invalid content publicKey');
            expect(validate({ ...delivered, nonce: 'xyz' })).toBe('invalid content nonce');
            expect(validate({ ...delivered, signature: 'ab' })).toBe('invalid content signature');
            expect(validate({ ...delivered, canonicalPayload: { text: 'x' } })).toBe('invalid content payload');
        });
    });
});
