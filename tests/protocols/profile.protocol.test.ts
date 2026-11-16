import * as EVENTS from '../../src/constants/events.constants.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stripIds } from '../../src/utils/general.utils.js';
import { getSpaceTopicHash } from '../../src/utils/space.utils.js';
import { hexToUint8 } from '../../src/utils/crypto.utils.js';
import { createProfileUpdateMessage } from '../../src/utils/protocol.utils.js';
import {
  buildTestProfilePayload,
  buildTestSpacePayload,
} from '../general.utils.js';
import { MockCoreFactory } from '../mock.factory.js';
import {
  connectProtocolNodes,
  createProtocolNodes,
  type ProtocolNode,
} from '../protocol.harness.js';
import {
  createProfile,
  createProfileForPublicKey,
  getProfileByPublicKey,
  updateProfileForPublicKey,
} from '../../src/utils/profile.utils.js';
import type {
  ProfileRecord,
  SignedProfile,
} from '../../src/utils/profile.utils.js';
import type { SignedProtocolMessage } from '../../src/utils/protocol.utils.js';

type TestNode = ProtocolNode;

async function getExistingProfile(
  db: any,
  publicKey: string,
): Promise<ProfileRecord> {
  const profile = await getProfileByPublicKey(db, publicKey);
  if (!profile) throw new Error(`Profile ${publicKey} was not found`);
  return profile;
}

describe('ProfileProtocolHandler', () => {
  const generalTopicHash = 'a'.repeat(64);
  let factory: MockCoreFactory;
  let nodes: TestNode[] = [];
  let primary: TestNode;
  let primaryDB: any;
  let secondary: TestNode;
  let secondaryDB: any;
  let spaceParams: Awaited<ReturnType<typeof buildTestSpacePayload>>;
  let spaceTopicHash: string;

  beforeEach(async () => {
    factory = new MockCoreFactory();
    await factory.init();

    nodes = await createProtocolNodes(factory, 2);
    [primary, secondary] = nodes;

    spaceParams = await buildTestSpacePayload({
      spaceName: 'TestSpace',
      publicKey: primary.publicKey,
      permissionRead: 1,
      permissionBroadcast: 1,
      readWhitelist: [],
      broadcastWhitelist: [],
    });

    spaceTopicHash = getSpaceTopicHash(spaceParams);
    connectProtocolNodes(spaceTopicHash, [primary, secondary]);

    primaryDB = primary.manager.session.getDatabase().db;
    secondaryDB = secondary.manager.session.getDatabase().db;
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  it('should exist within the protocol map', () => {
    expect(
      secondary.manager.message.protocolHandlers.has(EVENTS.ProfileUpdate),
    ).toBe(true);
  });

  it('should handle valid ProfileUpdate message', async () => {
    const profile = await buildTestProfilePayload({
      username: 'alice',
      publicKey: primary.publicKey,
      secretKey: primary.secretKey,
    });

    const message = (await createProfileUpdateMessage({
      profile: profile,
      topics: [generalTopicHash],
      publicKey: primary.publicKey,
      secretKey: primary.secretKey,
    })) as SignedProtocolMessage<{
      profile: SignedProfile;
      topics: string[];
    }>;

    // this makes primaryManager think it already sent the message
    primary.manager.throttle.updateByMessage(message);

    let eventContext: unknown = null;
    secondary.emitter.on(
      EVENTS.ProfileUpdate,
      ({ message }: { message: unknown }) => {
        eventContext = message;
      },
    );

    await secondary.manager.message.handleIncomingMessage(
      primary.socket,
      JSON.stringify(message),
      primary.info,
    );
    const profileRecord = await getExistingProfile(
      secondaryDB,
      profile.publicKey,
    );

    expect(eventContext).toBeDefined();
    expect(eventContext).toEqual(message);

    expect(stripIds(profileRecord)).toEqual(message.payload.profile);
  });

  it('should update record base on valid ProfileUpdate message', async () => {
    const profile = {
      username: 'alice',
      tag: '@pancake',
      profileURL: null,
      publicKey: secondary.publicKey,
    };

    // generate the base profile payload in the secondary
    const originalProfile = await createProfileForPublicKey(
      secondaryDB,
      profile,
      hexToUint8(secondary.secretKey),
    );

    // update the recorded profile payload with new parameters
    const newProfileParams = { ...profile, username: 'alice likes pancake' };
    await updateProfileForPublicKey(
      secondaryDB,
      originalProfile.id,
      newProfileParams,
      hexToUint8(secondary.secretKey),
    );

    // fetch the updated payload from the secondary
    const updatedProfile = await getExistingProfile(
      secondaryDB,
      originalProfile.publicKey,
    );

    // only store the base profile in the primary to differentiate with the newer one
    await createProfile(primaryDB, originalProfile);

    const message = (await createProfileUpdateMessage({
      profile: stripIds(updatedProfile),
      topics: [generalTopicHash],
      publicKey: secondary.publicKey,
      secretKey: secondary.secretKey,
    })) as SignedProtocolMessage<{
      profile: SignedProfile;
      topics: string[];
    }>;

    let eventContext: unknown = null;
    primary.emitter.on(
      EVENTS.ProfileUpdate,
      ({ message }: { message: unknown }) => {
        eventContext = message;
      },
    );

    // primary with older profile payload will receive updated profile
    await primary.manager.message.handleIncomingMessage(
      secondary.socket,
      JSON.stringify(message),
      secondary.info,
    );
    const profileRecord = await getProfileByPublicKey(
      primaryDB,
      secondary.publicKey,
    );

    // now the profile payload within the primary should also be updated
    expect(profileRecord).toEqual(updatedProfile);
  });
});
