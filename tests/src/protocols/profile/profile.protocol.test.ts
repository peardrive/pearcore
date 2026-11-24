// @ts-nocheck
import * as EVENTS from '../../../../src/constants/events.constants.js';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { stripIds, now } from '../../../../src/utils/general.utils.js';
import { hexToUint8, signJSON } from '../../../../src/utils/crypto.utils.js';
import {
  buildProfilePayload,
  createProfile,
  getProfile,
  getProfileByPublicKey,
  updateProfile,
} from '../../../../src/utils/profile.utils.js';
import { createProfileUpdateMessage } from '../../../../src/utils/protocol.utils.js';
import { buildTestProfilePayload } from '../../../helpers/general.utils.js';
import { MockCoreFactory } from '../../../helpers/mock.factory.js';
import {
  collectMessages,
  connectProtocolNodes,
  deliverMessage,
} from '../../../helpers/protocol.utils.js';
import type {
  ProfileRecord,
  SignedProfile,
} from '../../../../src/utils/profile.utils.js';
import type { SignedProtocolMessage } from '../../../../src/utils/protocol.utils.js';

async function getExistingProfile(
  db: any,
  publicKey: string,
): Promise<ProfileRecord> {
  const profile = await getProfileByPublicKey(db, publicKey);
  if (!profile) throw new Error(`Profile ${publicKey} was not found`);
  return profile;
}

/**
 * Two factory cores on the in-memory peer network. The handshake already
 * exchanged both factory profiles, so the tests update them through the
 * protocol and observe what arrives on the peer (`EVENTS.General`).
 */
describe('ProfileProtocolHandler', () => {
  const generalTopicHash = 'a'.repeat(64);
  let factory: MockCoreFactory;
  let cores: any[];
  let primary: any;
  let primaryDB: any;
  let secondary: any;
  let secondaryDB: any;
  let secondaryInbox: ReturnType<typeof collectMessages>;

  beforeEach(async () => {
    factory = new MockCoreFactory();
    await factory.init();

    cores = await factory.createMultipleCores(2);
    cores.forEach((core, index) => {
      core.name = index === 0 ? 'primary' : 'secondary';
    });
    [primary, secondary] = cores;

    await connectProtocolNodes(factory, generalTopicHash, cores);

    secondaryInbox = collectMessages(secondary);

    primaryDB = primary.managers.session.getDatabase().db;
    secondaryDB = secondary.managers.session.getDatabase().db;
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  it('should exist within the protocol map', () => {
    expect(
      secondary.managers.message.protocolHandlers.has(EVENTS.ProfileUpdate),
    ).toBe(true);
  });

  it('should handle valid ProfileUpdate message', async () => {
    // `updateProfile` intentionally does not write profileURL, so the profile
    // matches the record the handshake already stored when it is null
    const profile = await buildTestProfilePayload({
      username: 'alice',
      profileURL: null,
      publicKey: primary.publicKey,
      secretKey: primary.secretKey,
      timestamp: now() + 60_000, // strictly newer than the handshake copy
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

    let eventContext: unknown = null;
    secondary.emitter.on(
      EVENTS.ProfileUpdate,
      ({ message }: { message: unknown }) => {
        eventContext = message;
      },
    );

    await deliverMessage(secondary, primary, message);
    await factory.settle();

    const profileRecord = await getExistingProfile(
      secondaryDB,
      profile.publicKey,
    );

    expect(eventContext).toBeDefined();
    expect(eventContext).toEqual(message);
    expect(stripIds(profileRecord)).toEqual(message.payload.profile);
  });

  it('should update record base on valid ProfileUpdate message', async () => {
    const base = await createProfileForSecondary();

    // a profile with an older timestamp must not overwrite the stored one
    const newer = await updateProfileForSecondary(base, {
      username: 'alice likes pancake',
      timestamp: base.timestamp + 60_000,
    });

    const message = (await createProfileUpdateMessage({
      profile: stripIds(newer),
      topics: [generalTopicHash],
      publicKey: secondary.publicKey,
      secretKey: secondary.secretKey,
    })) as SignedProtocolMessage<{
      profile: SignedProfile;
      topics: string[];
    }>;

    await deliverMessage(primary, secondary, message);
    await factory.settle();

    // primary held the older profile payload: it is now updated
    const profileRecord = await getProfileByPublicKey(
      primaryDB,
      secondary.publicKey,
    );
    expect(stripIds(profileRecord)).toEqual(stripIds(newer));
  });

  /** Creates the secondary's profile locally (the handshake stored it too). */
  const createProfileForSecondary = async () => {
    const existing = await getProfileByPublicKey(
      secondaryDB,
      secondary.publicKey,
    );
    if (existing) return existing;

    return createProfile(
      secondaryDB,
      await buildTestProfilePayload({
        username: 'alice',
        profileURL: null,
        publicKey: secondary.publicKey,
        secretKey: secondary.secretKey,
      }),
    );
  };

  /** Signs and stores a newer version of the given profile. */
  const updateProfileForSecondary = async (
    base: ProfileRecord,
    params: { username: string; timestamp: number },
  ) => {
    const payload = buildProfilePayload({
      username: params.username,
      tag: base.tag,
      profileURL: base.profileURL,
      publicKey: secondary.publicKey,
      timestamp: params.timestamp,
    });
    const signature = await signJSON(payload, hexToUint8(secondary.secretKey));

    const { profileId } = await updateProfile(secondaryDB, base.id, {
      ...payload,
      signature,
    });

    return (await getProfile(secondaryDB, profileId))!;
  };
});
