import { createSpaceFileRecordSignature } from '../../src/utils/protocol.utils.js';

export const createSignedEvent = async (event: any) => {
  const signature = await createSpaceFileRecordSignature(event);
  const signedEvent = { ...event, signature };
  return signedEvent;
};

export const waitForEvent = (
  core: any,
  eventName: string,
  { timeout = 5000, match = null }: { timeout?: number; match?: any } = {},
): Promise<any> => {
  return new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => {
      core.emitter.off(eventName, listener);
      reject(
        new Error(`Timeout waiting for ${eventName} on core ${core.publicKey}`),
      );
    }, timeout);

    const listener = (data: any) => {
      if (match && !match(data)) return;

      clearTimeout(timer);
      core.emitter.off(eventName, listener);
      resolve(data);
    };

    core.emitter.on(eventName, listener);
  });
};
