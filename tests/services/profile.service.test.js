import * as EVENTS from '../../src/constants/events.constants.js';
import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { CoreFactory } from "../factory.js";
import { buildTestProfilePayload } from "../general.utils.js";

describe('ProfileService', () => {
    let factory = null;

    beforeEach(async () => {
        factory = new CoreFactory();
        await factory.init();
    })

    describe('list', () => {
        it('should list all profile record', async () => {
            const core = await factory.createCore();
            await core.profile.update({
                username: 'profile list test'
            });

            for (let index = 0; index < 10; index++) {
                const profile = await buildTestProfilePayload({ username: `test:${index}` });
                await core.managers.storage.createProfile(profile);
            }

            const profileList = await core.profile.list();
            expect(profileList.length).toBe(11);
        });
    })

    describe('broadcast', () => {
        it('should broadcast updated profile payload to connected nodes', async () => {
            const cores = await factory.createMultipleCores(5);
            
            const primaryCore = cores[0];
            const {
                publicKey: primaryPublicKey,
                secretKey: primarySecretKey
            } = primaryCore.managers.session.getCredentials();

            // create a space to connect nodes together
            const space = await primaryCore.space.create({ spaceName: 'profile space' });

            // wait for nodes to join the space
            await factory.condition(async (core, success, failure) => {
                await core.space.join(space.sharelink);
                success();

            }, { excludeIndices: [0] });

            const newUseraname = 'updated user name';

            // modify the account's profile record in the database
            await primaryCore.managers.storage.updateProfileForPublicKey({
                publicKey: primaryPublicKey,
                username: newUseraname
            }, primarySecretKey);

            // broadcast profile record to connected nodes
            await primaryCore.profile.broadcast();

            // wait for nodes to receive and process profile update
            await factory.condition(async (core, success, failure) => {
                core.emitter.on(EVENTS.ProfileUpdate, () => {
                    success();
                })
            }, { excludeIndices: [0] });

            for (const core of factory.cores) {
                const profileListRecord = await core.profile.list({
                    publicKey: primaryPublicKey
                });

                expect(profileListRecord.length).toBe(1);
                expect(profileListRecord[0].username).toBe(newUseraname);
            }
        })
    })

    describe('update', () => {
        it('should update current profile and update connected nodes', async () => {
            const cores = await factory.createMultipleCores(5);

            const primaryCore = cores[0];
            const primaryProfile = await primaryCore.profile.getCurrentProfile();
            const primaryPublicKey = primaryCore.managers.session.getCredentials().publicKey;

            // create a space to connect nodes together
            const space = await primaryCore.space.create({ spaceName: 'profile space' });

            await factory.condition(async (core, success, failure) => {
                await core.space.join(space.sharelink);
                success();

            }, { excludeIndices: [0] });

            const newUseraname = 'updated user name';
            await primaryCore.profile.update({ username: newUseraname });

            await factory.condition(async (core, success, failure) => {
                core.emitter.on(EVENTS.ProfileUpdate, () => {
                    success();
                })
            }, { excludeIndices: [0] });

            for (const core of factory.cores) {
                const profileListRecord = await core.profile.list({
                    publicKey: primaryPublicKey
                });

                expect(profileListRecord.length).toBe(1);
                expect(profileListRecord[0].username).toBe(newUseraname);
            }
        })
    })

    describe('getCurrentProfile', () => {
        it('should return profile payload for the current account', async () => {
            const username = 'profile list test';
            const core = await factory.createCore(username);
            const currentProfile = await core.profile.getCurrentProfile();
            const { publicKey } = core.managers.session.getCredentials();

            expect(currentProfile.username).toBe(username);
            expect(currentProfile.publicKey).toBe(publicKey);
        })
    })
})