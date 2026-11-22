import * as EVENTS from '../../../../../src/constants/events.constants.js';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { MockCoreFactory } from '../../../../helpers/mock.factory.js';
import { createSignedEvent, waitForEvent } from '../../../../helpers/file.test.utils.js';
import { now } from '../../../../../src/utils/general.utils.js';
import { FileEventBroadcaster } from '../../../../../src/managers/files/components/events.js';

describe('FileEventBroadcaster', () => {
  let factory: any = null;
  let cores: any[] = [];
  let primaryCore: any = null;
  let spaceId: any = null;
  let topic: any = null;
  let broadcaster: any = null;

  beforeEach(async () => {
    factory = new MockCoreFactory();
    await factory.init();

    cores = await factory.createMultipleCores(5);
    primaryCore = cores[0];

    broadcaster = new FileEventBroadcaster(primaryCore.emitter, {
      sessionManager: primaryCore.managers.session,
      socketManager: primaryCore.managers.sockets,
      messageManager: primaryCore.managers.message,
    });

    const space = await primaryCore.space.create({ spaceName: 'test-space' });
    topic = space.topicHash;

    const status = await factory.condition(
      async (core: any, success: (value?: any) => void) => {
        // resolve the condition after SpaceSync state
        core.emitter.once(EVENTS.SpaceHashList, (data: any) => {
          success(data);
        });

        await core.space.join(space.sharelink);
      },
      { excludeIndices: [0], timeout: 1000 },
    );
  });

  afterEach(async () => {
    await broadcaster.flush();
    await factory.cleanup();
  });

  it('should add an event to the stack and flush it', async () => {
    const signedEvent = await createSignedEvent({
      topic: topic,
      path: '/test.txt',
      publicKey: primaryCore.publicKey,
      secretKey: primaryCore.secretKey,
      timestamp: now(),
      rootHash: 'a'.repeat(64),
    });

    broadcaster.add(EVENTS.SpaceFileEventOptions.ADD, signedEvent);

    // the space handshake also exchanges a file-list context; wait for the
    // broadcast that actually carries this record
    const eventPromise = waitForEvent(cores[1], EVENTS.SpaceFileEvent, {
      match: (event: any) => event.message.payload[0]?.files.length === 1,
    });
    await broadcaster.flush();

    const received = await eventPromise;

    expect(received.message.topic).toBe(topic);
    expect(received.message.payload).toHaveLength(1);
    expect(received.message.payload[0].action).toBe(
      EVENTS.SpaceFileEventOptions.ADD,
    );
    expect(received.message.payload[0].files).toEqual([
      [
        signedEvent.path,
        signedEvent.publicKey,
        signedEvent.timestamp,
        signedEvent.rootHash,
        signedEvent.signature,
      ],
    ]);

    expect(broadcaster.stack.size).toBe(0);
  });

  it('should combine add/remove events into one broadcast message', async () => {
    const addEvent = await createSignedEvent({
      topic: topic,
      path: '/test.txt',
      publicKey: primaryCore.publicKey,
      secretKey: primaryCore.secretKey,
      timestamp: now(),
      rootHash: 'a'.repeat(64),
    });

    const removeEvent = await createSignedEvent({
      topic: topic,
      path: '/test2.txt',
      publicKey: primaryCore.publicKey,
      secretKey: primaryCore.secretKey,
      timestamp: now(),
      rootHash: 'a'.repeat(64),
    });

    broadcaster.add(EVENTS.SpaceFileEventOptions.ADD, addEvent);
    broadcaster.add(EVENTS.SpaceFileEventOptions.REMOVE, removeEvent);

    // ignore the file-list context of the space handshake
    const eventPromise = waitForEvent(cores[1], EVENTS.SpaceFileEvent, {
      match: (event: any) => event.message.payload.length === 2,
    });

    await broadcaster.flush();

    const received = await eventPromise;
    expect(received.message.payload).toHaveLength(2);

    const actions = received.message.payload.map((e: any) => e.action);
    expect(actions).toContain(EVENTS.SpaceFileEventOptions.ADD);
    expect(actions).toContain(EVENTS.SpaceFileEventOptions.REMOVE);
  });
});
