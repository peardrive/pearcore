// @ts-nocheck
import { once } from 'node:events';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as EVENTS from '../../../src/constants/events.constants.js';
import { hex, generateRandomSecretKey } from '../../../src/utils/crypto.utils.js';
import { createSpaceHashListMessage } from '../../../src/utils/protocol.utils.js';
import {
  getSpaceTopicHash,
  upsertSpace,
} from '../../../src/utils/space.utils.js';
import { buildTestSpacePayload } from '../../helpers/general.utils.js';
import { MockCoreFactory } from '../../helpers/mock.factory.js';

/** Random 32-byte hex topic, as used by space discovery. */
function randomTopic() {
  return generateRandomSecretKey(32);
}

/**
 * Exercises the ConnectionManager over the in-memory peer network used by
 * `MockCoreFactory`. These tests cover the transport seam itself rather than
 * the space/message services: discovery, the initial handshake, broadcasting
 * through the real mux/message pipeline, direct links and disconnects.
 */
describe('ConnectionManager (in-memory network)', () => {
  let factory;

  beforeEach(() => {
    factory = new MockCoreFactory();
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  /**
   * Creates two cores subscribed to the same space topic. Both databases hold
   * the space so the handshake exchanges the same topic list, mirroring how
   * peer discovery works after a sharelink join.
   */
  async function connectPair() {
    const space = await buildTestSpacePayload({ spaceName: 'connection test' });
    const topic = getSpaceTopicHash(space);

    const [primary, secondary] = await Promise.all([
      factory.createCore('primary'),
      factory.createCore('secondary'),
    ]);

    await upsertSpace(primary.managers.session.getDatabase().db, space);
    await upsertSpace(secondary.managers.session.getDatabase().db, space);

    const primaryConnection = once(primary.emitter, EVENTS.Connection);
    const secondaryConnection = once(secondary.emitter, EVENTS.Connection);

    await primary.managers.connection.join(topic);
    await secondary.managers.connection.join(topic);
    await factory.settle();

    const [primaryEvent] = await primaryConnection;
    const [secondaryEvent] = await secondaryConnection;

    return { primary, secondary, topic, primaryEvent, secondaryEvent };
  }

  it('connects peers that join the same topic and runs the handshake', async () => {
    const space = await buildTestSpacePayload({ spaceName: 'connection test' });
    const topic = getSpaceTopicHash(space);

    const [primary, secondary] = await Promise.all([
      factory.createCore('primary'),
      factory.createCore('secondary'),
    ]);

    await upsertSpace(primary.managers.session.getDatabase().db, space);
    await upsertSpace(secondary.managers.session.getDatabase().db, space);

    const primaryConnection = once(primary.emitter, EVENTS.Connection);
    const secondaryConnection = once(secondary.emitter, EVENTS.Connection);
    const primaryHandshake = once(primary.emitter, EVENTS.Handshake);
    const secondaryHandshake = once(secondary.emitter, EVENTS.Handshake);

    await primary.managers.connection.join(topic);
    await secondary.managers.connection.join(topic);
    await factory.settle();

    const [primaryConnectionEvent] = await primaryConnection;
    const [secondaryConnectionEvent] = await secondaryConnection;

    expect(primaryConnectionEvent.publicKey).toBe(secondary.publicKey);
    expect(primaryConnectionEvent.topics).toEqual([topic]);
    expect(secondaryConnectionEvent.publicKey).toBe(primary.publicKey);
    expect(secondaryConnectionEvent.topics).toEqual([topic]);

    const [primaryHandshakeEvent] = await primaryHandshake;
    const [secondaryHandshakeEvent] = await secondaryHandshake;

    expect(primaryHandshakeEvent.publicKey).toBe(secondary.publicKey);
    expect(primaryHandshakeEvent.context.topics).toEqual([topic]);
    expect(primaryHandshakeEvent.context.profile.username).toBe('primary');
    expect(secondaryHandshakeEvent.publicKey).toBe(primary.publicKey);
    expect(secondaryHandshakeEvent.context.topics).toEqual([topic]);
    expect(secondaryHandshakeEvent.context.profile.username).toBe('secondary');

    const primarySnapShot = primary.managers.sockets.getSnapShot();
    const secondarySnapShot = secondary.managers.sockets.getSnapShot();

    expect(primarySnapShot[secondary.publicKey]).toEqual([topic]);
    expect(secondarySnapShot[primary.publicKey]).toEqual([topic]);

    // one link/socket per peer pair, even though both peers joined a topic
    expect(primary.managers.sockets.getConnectedSockets()).toHaveLength(1);
    expect(secondary.managers.sockets.getConnectedSockets()).toHaveLength(1);
  });

  it('delivers a broadcast to the peer protocol handler', async () => {
    const { primary, secondary, topic } = await connectPair();

    const { publicKey, secretKey } = primary.managers.session.getCredentials();
    const message = await createSpaceHashListMessage({
      hashList: [topic],
      publicKey,
      secretKey,
    });

    const received = once(secondary.emitter, EVENTS.SpaceHashList);

    await primary.managers.message.broadcastMessageToSockets(
      message,
      primary.managers.sockets.getConnectedSockets(),
    );
    await factory.settle();

    const [event] = await received;

    expect(event.topics).toEqual([topic]);
    expect(hex(event.info.publicKey)).toBe(primary.publicKey);
    expect(event.message.publicKey).toBe(primary.publicKey);
  });

  it('opens a direct link with connectWith() without a shared topic', async () => {
    const [primary, secondary] = await Promise.all([
      factory.createCore('primary'),
      factory.createCore('secondary'),
    ]);

    const primaryConnection = once(primary.emitter, EVENTS.Connection);
    const secondaryConnection = once(secondary.emitter, EVENTS.Connection);

    factory.connect(primary, secondary);
    await factory.settle();

    const [primaryEvent] = await primaryConnection;
    const [secondaryEvent] = await secondaryConnection;

    expect(primaryEvent.publicKey).toBe(secondary.publicKey);
    expect(primaryEvent.topics).toEqual([]);
    expect(secondaryEvent.publicKey).toBe(primary.publicKey);
    expect(secondaryEvent.topics).toEqual([]);

    expect(
      primary.managers.sockets.getSnapShot()[secondary.publicKey],
    ).toEqual([]);
    expect(
      secondary.managers.sockets.getSnapShot()[primary.publicKey],
    ).toEqual([]);
  });

  it('keeps sockets alive when the last shared topic is left', async () => {
    const { primary, secondary, topic } = await connectPair();

    await primary.managers.connection.leave(topic);
    await factory.settle();

    expect(primary.managers.connection.isDiscoverable(topic)).toBe(false);
    expect(secondary.managers.connection.isDiscoverable(topic)).toBe(true);

    // HyperDHT keeps established streams when a topic is left; only an
    // explicit destroy/close tears them down.
    expect(
      primary.managers.sockets.getSnapShot()[secondary.publicKey],
    ).toEqual([topic]);
    expect(
      secondary.managers.sockets.getSnapShot()[primary.publicKey],
    ).toEqual([topic]);

    expect(factory.disconnect(primary, secondary)).toBe(true);
    await factory.settle();

    expect(primary.managers.sockets.getConnectedSockets()).toHaveLength(0);
    expect(secondary.managers.sockets.getConnectedSockets()).toHaveLength(0);
  });

  it('dedupes links when peers share more than one topic', async () => {
    const { primary, secondary } = await connectPair();
    const secondTopic = randomTopic();

    await primary.managers.connection.join(secondTopic);
    await secondary.managers.connection.join(secondTopic);
    await factory.settle();

    expect(primary.managers.sockets.getConnectedSockets()).toHaveLength(1);
    expect(secondary.managers.sockets.getConnectedSockets()).toHaveLength(1);
  });
});
