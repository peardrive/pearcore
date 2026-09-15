import * as EVENTS from '../../src/constants/events.constants.js';
import { describe, it, expect, beforeEach } from "vitest";
import { initializeManagers } from "../../src/managers/initialization.js";
import { getSpaceTopicHash } from '../../src/utils/space.utils.js';
import { createProfileUpdateMessage } from "../../src/utils/protocol.utils.js";
import { buildTestProfilePayload, createP2PNetwork, buildTestSpacePayload, createConnections } from "../general.utils.js";
import { createProfile, createProfileForPublicKey, getProfileByPublicKey, updateProfileForPublicKey } from '../../src/utils/profile.utils.js';
import { stripIds } from '../../src/utils/general.utils.js';


describe('ProfileProtocolHandler', () => {
    const generalTopicHash = 'a'.repeat(64)
    let primary;
    let primaryDB;
    let secondary;
    let secondaryDB;
    let spaceParams;
    let spaceTopicHash;

    beforeEach(async () => {
        [primary, secondary] = await createP2PNetwork(2);

        spaceParams = await buildTestSpacePayload({
            spaceName: 'TestSpace',
            publicKey: primary.publicKey,
            permissionRead: 1,
            permissionBroadcast: 1,
            readWhitelist: [],
            broadcastWhitelist: [],
        });

        spaceTopicHash = getSpaceTopicHash(spaceParams);
        createConnections(spaceTopicHash, [primary, secondary]);

        primaryDB = primary.manager.session.getDatabase().db;
        secondaryDB = secondary.manager.session.getDatabase().db;
    })

    it('should exist within the protocol map', () => {
        const managers = initializeManagers();
        expect(managers.message).toBeDefined();
        expect(managers.message.protocolHandlers.has(EVENTS.ProfileUpdate)).toBe(true);
    })

    it('should handle valid ProfileUpdate message', async () => {
        const profile = await buildTestProfilePayload({
            username: 'alice',
            publicKey: primary.publicKey,
            secretKey: primary.secretKey
        });

        const message = await createProfileUpdateMessage({
            profile: profile,
            topics: [generalTopicHash],
            publicKey: primary.publicKey,
            secretKey: primary.secretKey
        });

        // this makes primaryManager think it already sent the message
        primary.manager.throttle.updateByMessage(message);

        let eventContext = null;
        secondary.manager.emitter.on(EVENTS.ProfileUpdate, ({ message }) => {
            eventContext = message;
        });

        await secondary.manager.message.handleIncomingMessage(primary.socket, JSON.stringify(message), primary.info);
        const profileRecord = await getProfileByPublicKey(secondaryDB, profile.publicKey);

        expect(eventContext).toBeDefined();
        expect(eventContext).toEqual(message);

        expect(stripIds(profileRecord)).toEqual(message.payload.profile);
    })

    it('should update record base on valid ProfileUpdate message', async () => {
        const profile = {
            username: 'alice',
            tag: '@pancake',
            profileURL: null,
            publicKey: secondary.publicKey,
        };

        // generate the base profile payload in the secondary
        const originalProfile = await createProfileForPublicKey(secondaryDB, profile, secondary.secretKey);

        // update the recorded profile payload with new parameters
        const newProfileParams = { ...profile, username: 'alice likes pancake' };
        await updateProfileForPublicKey(
            secondaryDB,
            originalProfile.id,
            newProfileParams,
            secondary.secretKey
        );

        // fetch the updated payload from the secondary
        const updatedProfile = await getProfileByPublicKey(secondaryDB, originalProfile.publicKey);

        // only store the base profile in the primary to differentiate with the newer one
        await createProfile(primaryDB, originalProfile);

        const message = await createProfileUpdateMessage({
            profile: stripIds(updatedProfile),
            topics: [generalTopicHash],
            publicKey: secondary.publicKey,
            secretKey: secondary.secretKey
        });

        let eventContext = null;
        primary.manager.emitter.on(EVENTS.ProfileUpdate, ({ message }) => {
            eventContext = message;
        });

        // primary with older profile payload will receive updated profile
        await primary.manager.message.handleIncomingMessage(secondary.socket, JSON.stringify(message), secondary.info);
        const profileRecord = await getProfileByPublicKey(primaryDB, secondary.publicKey);

        // now the profile payload within the primary should also be updated
        expect(profileRecord).toEqual(updatedProfile);
    })
})