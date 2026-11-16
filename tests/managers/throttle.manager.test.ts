import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MockCoreFactory } from '../mock.factory.js';
import { createBaseMessage } from '../../src/utils/protocol.utils.js';

describe('ThrottleManager', () => {
  let factory: MockCoreFactory;

  beforeEach(async () => {
    factory = new MockCoreFactory();
    await factory.init();
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  it('should exist within manager stack', async () => {
    const managers = (await factory.createCore()).managers;
    expect(managers.throttle).toBeDefined();
  });

  describe('updateByMessage', () => {
    it('should update nonce record', async () => {
      const managers = (await factory.createCore()).managers;
      const { publicKey, secretKey } = managers.session.getCredentials();
      if (!publicKey || !secretKey) throw new Error('Credentials are missing');

      const message = await createBaseMessage({
        type: 'abc',
        topic: 'abc',
        payload: {},
        publicKey: publicKey,
        secretKey: secretKey,
      });

      expect(managers.throttle.messageIsDuplicated(message)).toBe(false);
      managers.throttle.updateByMessage(message);
      expect(managers.throttle.messageIsDuplicated(message)).toBe(true);
    });
  });

  describe('updateByFrequency', () => {
    it('should throttle by frequency when exceeding the limit', async () => {
      const managers = (await factory.createCore()).managers;
      const { publicKey } = managers.session.getCredentials();
      if (!publicKey) throw new Error('Public key is missing');
      const { MAX_FREQUENCY_THROTTLE } = managers.throttle;

      expect(managers.throttle.shouldBeThrottledByFrequency(publicKey)).toBe(
        false,
      );

      for (let count = 0; count <= MAX_FREQUENCY_THROTTLE; count++) {
        managers.throttle.updateByFrequency(publicKey);
      }

      expect(managers.throttle.shouldBeThrottledByFrequency(publicKey)).toBe(
        true,
      );
    });

    it('should clear frequency count periodically', async () => {
      const managers = (await factory.createCore()).managers;
      const { publicKey } = managers.session.getCredentials();
      if (!publicKey) throw new Error('Public key is missing');
      const { MAX_FREQUENCY_THROTTLE } = managers.throttle;

      expect(managers.throttle.shouldBeThrottledByFrequency(publicKey)).toBe(
        false,
      );

      for (let count = 0; count <= MAX_FREQUENCY_THROTTLE - 1; count++) {
        managers.throttle.updateByFrequency(publicKey);
      }

      // wait for 1 second to clear frequency map
      await new Promise((resolve) => setTimeout(resolve, 1000 + 1));
      expect(managers.throttle.frequencyRecord.get(publicKey)).toBe(0);
    });

    it('should stop throttling after quarantine duration', async () => {
      const managers = (await factory.createCore()).managers;

      // temporary set quarantine time to 100ms
      managers.session.set('messaging.maxQuarantineTime', 100);

      const { publicKey } = managers.session.getCredentials();
      if (!publicKey) throw new Error('Public key is missing');
      const { MAX_FREQUENCY_THROTTLE, MAX_QUARANTINE_TIME } = managers.throttle;

      expect(managers.throttle.shouldBeThrottledByFrequency(publicKey)).toBe(
        false,
      );

      for (let count = 0; count <= MAX_FREQUENCY_THROTTLE; count++) {
        managers.throttle.updateByFrequency(publicKey);
      }

      expect(managers.throttle.shouldBeThrottledByFrequency(publicKey)).toBe(
        true,
      );

      let quarantineStatus: boolean | null = null;
      const checkQuarantineAfterPeriod = new Promise<void>((resolve) => {
        setTimeout(() => {
          quarantineStatus =
            managers.throttle.shouldBeThrottledByFrequency(publicKey);
          resolve();
        }, MAX_QUARANTINE_TIME + 1);
      });

      await checkQuarantineAfterPeriod;
      expect(quarantineStatus).toBe(false);
    });
  });
});
