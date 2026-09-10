import { describe, it, expect } from "vitest";
import { createManagerInstance } from "../general.utils.js";
import { createBaseMessage } from "../../src/utils/protocol.utils.js";
import { now } from "../../src/utils/general.utils.js";

describe('ThrottleManager', () => {
    it('should exist within manager stack', async () => {
        const managers = await createManagerInstance();
        expect(managers.throttle).toBeDefined();
    })

    describe('load', () => {
        it('should load message records from database', async () => {
            const managers = await createManagerInstance();
            const { publicKey, secretKey } = managers.session.getCredentials();

            const messages = [];
            for (let count = 0; count <= 5; count++) {
                const message = await createBaseMessage({
                    type: 'abc',
                    topic: 'abc',
                    payload: {},
                    publicKey: publicKey,
                    secretKey: secretKey
                });

                messages.push(message);
                await managers.storage.saveMessageRecord({
                    message: message,
                    senderPublicKey: publicKey,
                    broadcastTimestamp: now(),
                });
            }

            await managers.throttle.load();
            for (const message of messages) {
                expect(managers.throttle.messageIsDuplicated(message)).toBe(true);
            }
        })
    })

    describe('updateByMessage', () => {
        it('should update nonce record', async () => {
            const managers = await createManagerInstance();
            const { publicKey, secretKey } = managers.session.getCredentials();

            const message = await createBaseMessage({
                type: 'abc',
                topic: 'abc',
                payload: {},
                publicKey: publicKey,
                secretKey: secretKey
            });

            expect(managers.throttle.messageIsDuplicated(message)).toBe(false);
            managers.throttle.updateByMessage(message);
            expect(managers.throttle.messageIsDuplicated(message)).toBe(true);
        })
    })

    describe('updateByFrequency', () => {
        it('should throttle by frequency when exceeding the limit', async () => {
            const managers = await createManagerInstance();
            const { publicKey } = managers.session.getCredentials();
            const { MAX_FREQUENCY_THROTTLE } = managers.throttle;

            expect(managers.throttle.shouldBeThrottledByFrequency(publicKey)).toBe(false);

            for (let count = 0; count <= MAX_FREQUENCY_THROTTLE; count++) {
                managers.throttle.updateByFrequency(publicKey);
            }

            expect(managers.throttle.shouldBeThrottledByFrequency(publicKey)).toBe(true);
        })

        it('should clear frequency count periodically', async () => {
            const managers = await createManagerInstance();
            const { publicKey } = managers.session.getCredentials();
            const { MAX_FREQUENCY_THROTTLE } = managers.throttle;

            expect(managers.throttle.shouldBeThrottledByFrequency(publicKey)).toBe(false);

            for (let count = 0; count <= MAX_FREQUENCY_THROTTLE-1; count++) {
                managers.throttle.updateByFrequency(publicKey);
            }

            // wait for 1 second to clear frequency map
            await new Promise(resolve => setTimeout(resolve, 1000 + 1));
            expect(managers.throttle.frequencyRecord.get(publicKey)).toBe(0);
        })

        it('should stop throttling after quarantine duration', async () => {
            const managers = await createManagerInstance();

            // temporary set quarantine time to 100ms
            managers.session.session.set('messaging.maxQuarantineTime', 100);

            const { publicKey } = managers.session.getCredentials();
            const { MAX_FREQUENCY_THROTTLE, MAX_QUARANTINE_TIME } = managers.throttle;

            expect(managers.throttle.shouldBeThrottledByFrequency(publicKey)).toBe(false);

            for (let count = 0; count <= MAX_FREQUENCY_THROTTLE; count++) {
                managers.throttle.updateByFrequency(publicKey);
            }

            expect(managers.throttle.shouldBeThrottledByFrequency(publicKey)).toBe(true);

            let quarantineStatus = null;
            const checkQuarantineAfterPeriod = new Promise((resolve) => {
                setTimeout(() => {
                    quarantineStatus = managers.throttle.shouldBeThrottledByFrequency(publicKey);
                    resolve();
                }, MAX_QUARANTINE_TIME + 1);
            });

            await checkQuarantineAfterPeriod;
            expect(quarantineStatus).toBe(false);
        })
    })
})