import { describe, beforeEach, it, expect, vi } from "vitest"
import * as EVENTS from '../../src/constants/events.constants.js';
import * as MESSAGES from '../../src/constants/messages.constants.js';
import { MessageManager } from "../../src/managers/message.manager.js";
import { initializeManagers } from "../../src/managers/initialization";
import { createSpaceHashListMessage } from "../../src/utils/protocol.utils.js";
import { buildTestSpacePayload, createFakeP2PConnection, unframeJson } from "../general.utils.js";
import { BaseProtocolHandler } from "../../src/protocols/base.js";
import { hex, randomNonce } from "../../src/utils/crypto.utils.js";
import { getSpaceTopicHash } from "../../src/utils/space.utils.js";

describe('MessageManager', () => {

    it('should exist within the initialized managers object', async () => {
        const managers = initializeManagers();
        expect(managers.message).toBeDefined();
        expect(managers.message).toBeInstanceOf(MessageManager);
    })

    describe('sendMessageToSocket', () => {
        it('should send message to socket', async () => {
            const [manager, socket, info] = await createFakeP2PConnection();
            const { publicKey, secretKey } = manager.session.getCredentials();

            const message = await createSpaceHashListMessage({
                hashList: [],
                publicKey: publicKey,
                secretKey: secretKey,
            });

            // remove all event types from whitelist to ensure nothing is supposed to be saved
            const { session } = manager.session;
            session.set('messaging.recordMessagesForEvents', []);

            await manager.message.sendMessageToSocket(message, socket);
            const messageRecords = await manager.storage.queryMessages();

            expect(socket.write).toHaveBeenCalled();
            expect(messageRecords).toEqual([]);
            expect(messageRecords.length).toBe(0);
        });
    })

    describe('handleIncommingMessage', () => {
        it('should handle incoming messages with valid protocol handler', async () => {
            const [manager, socket, info] = await createFakeP2PConnection();
            const { publicKey, secretKey } = manager.session.getCredentials();

            class TestProtocolHandler {
                constructor() {
                    this.isCalled = false;
                }

                async handle() {
                    this.isCalled = true;
                }
            }

            const testHandler = {
                type: EVENTS.SpaceHashList,
                handler: new TestProtocolHandler()
            };

            manager.message.setProtocolMap([testHandler]);

            const validMessage = await createSpaceHashListMessage({
                hashList: [],
                publicKey: publicKey,
                secretKey: secretKey
            });

            await manager.message.handleIncomingMessage(socket, JSON.stringify(validMessage), info);

            expect(testHandler.handler.isCalled).toBe(true);
            expect(socket.write).not.toHaveBeenCalled();
        })

        it('should handle event callbacks for messages', async () => {
            const [manager, socket, info] = await createFakeP2PConnection();
            const { publicKey, secretKey } = manager.session.getCredentials();

            class TestProtocolHandler extends BaseProtocolHandler {
                async handle(socket, message, info) {
                    this.emit(EVENTS.SpaceHashList, () => { });
                }
            }

            const testHandler = new TestProtocolHandler(manager.emitter, manager);
            const protocols = [
                {
                    type: EVENTS.SpaceHashList,
                    handler: testHandler
                }
            ];

            manager.message.setProtocolMap(protocols);

            const message = await createSpaceHashListMessage({
                hashList: [],
                publicKey: publicKey,
                secretKey: secretKey
            });

            let firstCallbackCalled = false;
            let secondCallbackCalled = false;

            manager.emitter.on(EVENTS.SpaceHashList, () => { firstCallbackCalled = true; });
            manager.emitter.on(EVENTS.SpaceHashList, () => { secondCallbackCalled = true; });

            await manager.message.handleIncomingMessage(socket, JSON.stringify(message), info);

            expect(firstCallbackCalled).toBe(true);
            expect(secondCallbackCalled).toBe(true);
        })

        it('should reject messages that exceed size limit', async () => {
            const [manager, socket, info] = await createFakeP2PConnection();
            const messageSize = manager.session.session.get('messaging.rawLimitSize');
            const largeRawMessage = Buffer.from(new Array(messageSize + 1).fill('a').join(''));

            await manager.message.handleIncomingMessage(socket, largeRawMessage, info);

            expect(socket.write).toHaveBeenCalled();

            const response = JSON.parse(unframeJson(socket.write.mock.calls[0][0]));

            expect(response.type).toEqual(EVENTS.Reject);
            expect(response.topic).toEqual(EVENTS.noTopic);
            expect(response.payload.linkedMessageNonce).toEqual(EVENTS.noNonce);
            expect(response.payload.reason).toEqual(MESSAGES.EXCEED_SIZE_MESSAGE);
        })

        it('should reject messages with invalid json', async () => {
            const [manager, socket, info] = await createFakeP2PConnection();
            await manager.message.handleIncomingMessage(socket, '{"invalid": json}', info);

            expect(socket.write).toHaveBeenCalled();

            const response = JSON.parse(unframeJson(socket.write.mock.calls[0][0]));

            expect(response.type).toEqual(EVENTS.Reject);
            expect(response.topic).toEqual(EVENTS.noTopic);
            expect(response.payload.linkedMessageNonce).toEqual(EVENTS.noNonce);
            expect(response.payload.reason).toEqual(MESSAGES.BAD_JSON_MESSAGE);
        })

        it('should reject messages with invalid signature', async () => {
            const [manager, socket, info] = await createFakeP2PConnection();
            const { publicKey, secretKey } = manager.session.getCredentials();
            const badMessage = await createSpaceHashListMessage({
                hashList: [],
                secretKey: secretKey,
                publicKey: publicKey,
            })

            badMessage.signature = 'b'.repeat(128);

            await manager.message.handleIncomingMessage(socket, JSON.stringify(badMessage), info);

            expect(socket.write).toHaveBeenCalled();

            const response = JSON.parse(unframeJson(socket.write.mock.calls[0][0]));

            expect(response.type).toEqual(EVENTS.Reject);
            expect(response.topic).toEqual(EVENTS.noTopic);
            expect(response.payload.linkedMessageNonce).toEqual(badMessage.nonce);
            expect(response.payload.reason).toEqual(MESSAGES.BAD_SIGNATURE_MESSAGE);
        })

        it('should reject messages when handlers thows error', async () => {
            const [manager, socket, info] = await createFakeP2PConnection();
            const { publicKey, secretKey } = manager.session.getCredentials();

            class TempSpaceHanlder {
                async handle() {
                    throw new Error('Handler failed')
                }
            }

            const testHandler = {
                type: EVENTS.SpaceHashList,
                handler: new TempSpaceHanlder()
            };

            manager.message.setProtocolMap([testHandler]);

            const validMessage = await createSpaceHashListMessage({
                hashList: [],
                publicKey: publicKey,
                secretKey: secretKey
            });

            await manager.message.handleIncomingMessage(socket, JSON.stringify(validMessage), info);

            expect(socket.write).toHaveBeenCalled();

            const response = JSON.parse(unframeJson(socket.write.mock.calls[0][0]));

            expect(response.type).toEqual(EVENTS.Reject);
            expect(response.topic).toEqual(EVENTS.noTopic);
            expect(response.payload.linkedMessageNonce).toEqual(validMessage.nonce);
            expect(response.payload.reason).toEqual(MESSAGES.INTERNAL_ERROR_MESSAGE);
        })

        it('should reject message when the message type has no handler', async () => {
            const [manager, socket, info] = await createFakeP2PConnection();
            const { publicKey, secretKey } = manager.session.getCredentials();

            manager.message.setProtocolMap([]);

            const validMessage = await createSpaceHashListMessage({
                hashList: [],
                publicKey: publicKey,
                secretKey: secretKey
            });

            await manager.message.handleIncomingMessage(socket, JSON.stringify(validMessage), info);

            expect(socket.write).toHaveBeenCalled();

            const response = JSON.parse(unframeJson(socket.write.mock.calls[0][0]));

            expect(response.type).toEqual(EVENTS.Reject);
            expect(response.topic).toEqual(EVENTS.noTopic);
            expect(response.payload.linkedMessageNonce).toEqual(validMessage.nonce);
            expect(response.payload.reason).toEqual(MESSAGES.NO_HANDLER_MESSAGE);
        })

        it('should reject reject message duplicates', async () => {
            const [manager, socket, info] = await createFakeP2PConnection();
            const { publicKey, secretKey } = manager.session.getCredentials();

            // enable throttle rejection
            manager.session.setMessageConfig({ allowThrottleRejection: true });

            const message = await createSpaceHashListMessage({
                hashList: [],
                publicKey: publicKey,
                secretKey: secretKey
            });

            let callCount = 0;
            manager.emitter.on(EVENTS.SpaceHashList, () => { callCount++; });

            await manager.message.handleIncomingMessage(socket, JSON.stringify(message), info);
            expect(callCount).toBe(1);
            expect(socket.write.mock.calls.length).toBe(0);

            await manager.message.handleIncomingMessage(socket, JSON.stringify(message), info);

            const response = JSON.parse(unframeJson(socket.write.mock.calls[0][0]));
            expect(response.type).toEqual(EVENTS.Reject);
            expect(response.topic).toEqual(EVENTS.noTopic);
            expect(response.payload.linkedMessageNonce).toEqual(message.nonce);
            expect(response.payload.reason).toEqual(MESSAGES.MESSAGE_IS_DUPLICATED);
        })

        it('should throttle and quarantine node for certain time period when node sends too many messages', async () => {
            const [manager, socket, info] = await createFakeP2PConnection();
            const { publicKey, secretKey } = manager.session.getCredentials();

            // enable throttle rejection
            manager.session.setMessageConfig({ allowThrottleRejection: true });

            // set quarantine time to 50ms for test
            manager.session.session.set('messaging.maxQuarantineTime', 50);

            const messageConfig = manager.session.getMessageConfig();
            const { frequencyThrottle, maxQuarantineTime } = messageConfig;

            let callCount = 0;
            manager.emitter.on(EVENTS.SpaceHashList, () => { callCount++; })

            const createMessage = async () => {
                const space = await buildTestSpacePayload();
                const topic = getSpaceTopicHash(space);

                return await createSpaceHashListMessage({
                    hashList: [topic],
                    publicKey: publicKey,
                    secretKey: secretKey
                });
            }

            for (let count = 0; count < frequencyThrottle + 1; count++) {
                const message = await createMessage();
                await manager.message.handleIncomingMessage(socket, JSON.stringify(message), info);
            }

            expect(callCount).toBe(frequencyThrottle);

            const response = JSON.parse(unframeJson(socket.write.mock.calls[0][0]));

            expect(response.type).toEqual(EVENTS.Reject);
            expect(response.topic).toEqual(EVENTS.noTopic);
            expect(response.payload.linkedMessageNonce).toEqual(EVENTS.noNonce);
            expect(response.payload.reason).toEqual(MESSAGES.MESSAGE_RATE_LIMIT_EXCEEDED);

            await new Promise(resolve => setTimeout(resolve, maxQuarantineTime + 1));

            const message = await createMessage();
            await manager.message.handleIncomingMessage(socket, JSON.stringify(message), info);

            expect(callCount).toBe(frequencyThrottle + 1);
        })
    })
})