import { describe, it, beforeEach, afterEach, expect } from "vitest";
import * as EVENTS from '../../src/constants/events.constants.js';
import { buildTestSpacePayload, getMockSocket } from '../general.utils.js';
import { getSpaceTopicHash } from "../../src/utils/space.utils.js";
import { encodeShareLink } from "../../src/utils/sharelink.utils.js";
import { CoreFactory } from "../factory.js";


describe('spaceService', () => {
    let factory;

    beforeEach(async () => {
        factory = new CoreFactory();
        await factory.init();
    });

    afterEach(async () => {
        await factory.cleanup();
    });

    describe('create', () => {
        it('should create a new space and join the topic', async () => {
            const core = await factory.createCore();

            const payload = await buildTestSpacePayload();
            const space = await core.space.create(payload);

            const { publicKey } = core.managers.session.getCredentials();

            expect(space.spaceName).toBe(payload.spaceName);
            expect(space.publicKey).toBe(publicKey);
            expect(space.nonce).toBe(payload.nonce);
            expect(core.managers.connection.isDiscoverable(space.topicHash));
        })
    })

    describe('update', () => {
        it('should updates the space and propagate changes to connected peers', async () => {
            const [primaryCore, secondaryCore] = await Promise.all([
                factory.createCore(),
                factory.createCore()
            ]);

            const space = await primaryCore.space.create({
                spaceName: 'original',
                permissionBroadcast: false
            });

            await factory.condition(async (core, success) => {
                core.emitter.on(EVENTS.SpaceSync, () => success(), { once: true });
                
                try {
                    await core.space.join(space.sharelink);
                } catch(error) { /* Do nothing, timeout will handle it. */ }

            }, { excludeIndices: [0] });

            const [ initialSecondarySpaceInstance ] = await secondaryCore.space.list();

            expect(initialSecondarySpaceInstance.permissionBroadcast).toBe(false);

            let updatedSpace;

            await factory.condition(async (core, success) => {
                core.emitter.on(EVENTS.SpaceSync, () => success(), { once: true });
                updatedSpace = await primaryCore.space.update(space, { permissionBroadcast: true });

            }, { excludeIndices: [0] });

            const [ updatedSecondarySpaceInstance ] = await secondaryCore.space.list();
            
            expect(updatedSecondarySpaceInstance.permissionBroadcast).toBe(true);
            expect(updatedSecondarySpaceInstance.toObject()).toMatchObject(updatedSpace.toObject());
        });
    });

    describe('join', () => {
        it('should join an existing space using sharelink', async () => {
            const [primaryCore, secondaryCore] = await Promise.all([
                factory.createCore(),
                factory.createCore()
            ]);

            const { publicKey: primaryPublicKey } = primaryCore.managers.session.getCredentials();
            const { publicKey: secondaryPublicKey } = secondaryCore.managers.session.getCredentials();

            const conditionPromise = factory.condition(async (core, success) => {
                core.emitter.on(EVENTS.SpaceHashList, () => {
                    success();
                });
            });


            const space = await primaryCore.space.create({ spaceName: 'generic' });
            await secondaryCore.space.join(space.sharelink);

            await conditionPromise;

            const primarySnapShot = primaryCore.managers.sockets.getSnapShot({ sortByPeers: true });
            const secondarySnapShot = secondaryCore.managers.sockets.getSnapShot({ sortByPeers: true });

            expect(primarySnapShot[secondaryPublicKey]).toEqual([space.topicHash]);
            expect(secondarySnapShot[primaryPublicKey]).toEqual([space.topicHash]);
        })

        it('should broadcast the new topic to connected peers', async () => {
            const [primaryCore, secondaryCore] = await Promise.all([
                factory.createCore(),
                factory.createCore()
            ]);

            const { publicKey: secondaryPublicKey } = secondaryCore.managers.session.getCredentials();

            const conditionPromise = factory.condition(
                async (core, success) => {
                    core.emitter.on(EVENTS.SpaceHashList, () => {
                        success();
                    });
                },
                { excludeIndices: [1] } // secondary is index 1
            );

            const space = await primaryCore.space.create({ spaceName: 'generic' });
            await secondaryCore.space.join(space.sharelink);

            const randomSpace = await buildTestSpacePayload({ spaceName: 'randomSpace' });
            const randomSharelink = encodeShareLink(randomSpace);
            const randomTopicHash = getSpaceTopicHash(randomSpace);
            await secondaryCore.space.join(randomSharelink);

            await conditionPromise;

            const primarySnapShot = primaryCore.managers.sockets.getSnapShot({ sortByPeers: true });
            expect(primarySnapShot[secondaryPublicKey].length).toBe(2);
            expect(primarySnapShot[secondaryPublicKey]).toEqual([space.topicHash, randomTopicHash]);
        })
    })

    describe('leave', () => {
        it('should delete space record and update nodes', async () => {
            const [primaryCore, secondaryCore] = await Promise.all([
                factory.createCore(),
                factory.createCore()
            ]);

            const { publicKey: secondaryPublicKey } = secondaryCore.managers.session.getCredentials();

            const conditionPromise = factory.condition(async (core, success) => {
                core.emitter.on(EVENTS.SpaceHashList, () => {
                    success();
                });
            });

            const space = await primaryCore.space.create({ spaceName: 'original' });
            const secondaryJoinedSpace = await secondaryCore.space.join(space.sharelink);

            const randomSpace = await buildTestSpacePayload({ spaceName: 'random space' });
            const randomSharelink = encodeShareLink(randomSpace);
            const randomTopicHash = getSpaceTopicHash(randomSpace);
            await secondaryCore.space.join(randomSharelink);

            await conditionPromise;

            const primarySnapShot = primaryCore.managers.sockets.getSnapShot({ sortByPeers: true });
            expect(primarySnapShot[secondaryPublicKey].length).toBe(2);
            expect(primarySnapShot[secondaryPublicKey]).toEqual([space.topicHash, randomTopicHash]);

            await secondaryCore.space.leave(secondaryJoinedSpace);

            await new Promise(resolve => setTimeout(resolve, 50));

            const updatedPrimarySnapShot = primaryCore.managers.sockets.getSnapShot();

            expect(typeof updatedPrimarySnapShot === 'object').toBe(true);
            // exclude the original space and only contain the randomly generated space
            expect(updatedPrimarySnapShot[secondaryPublicKey]).toEqual([randomTopicHash]);
        });
    })

    describe('list', () => {
        let primaryCoreInstance;
        let spaceOne;
        let spaceTwo;

        beforeEach(async () => {
            primaryCoreInstance = await factory.createCore();
            spaceOne = await primaryCoreInstance.space.create({ spaceName: 'space num.1' });

            const randomSpace = await buildTestSpacePayload({ spaceName: 'space num.2' });
            const randomSharelink = encodeShareLink(randomSpace);
            await primaryCoreInstance.space.join(randomSharelink);
            spaceTwo = randomSpace;
        })

        it('should return all space records', async () => {
            const list = await primaryCoreInstance.space.list();
            // spaces that already has been initialized
            const syncedList = list.filter(item => item.isSync);
            // spaces that has not been initiallized or discovered yet.
            const unSyncList = list.filter(item => !item.isSync);

            expect(list.length).toBe(2);
            expect(syncedList[0]).toMatchObject(spaceOne);
            // Because of timestamp difference in sharelinks,
            // We cannot expect to match the object.
            // Thus we only check the nonce for sharelinks.
            expect(unSyncList[0].nonce).toBe(spaceTwo.nonce);
        })

        it('should return subset of spaces using filter', async () => {
            const list = await primaryCoreInstance.space.list({
                spaceName: 'space num.1'
            });

            expect(list.length).toBe(1);
            expect(list[0]).toMatchObject(spaceOne);
        })
    })

    describe('getCurrentState', () => {
        let coreInstance;

        beforeEach(async () => {

            const core = await factory.createCore();

            const spaceOne = await core.space.create({ spaceName: 'space #1' });
            const spaceTwo = await core.space.create({ spaceName: 'space #2' });

            const spaceThree = await buildTestSpacePayload({ spaceName: 'space #3' });
            const spaceThreeSharelink = encodeShareLink(spaceThree);
            const spaceThreeTopicHash = getSpaceTopicHash(spaceThree);
            await core.space.join(spaceThreeSharelink);

            const topics = [
                spaceOne.topicHash,
                spaceTwo.topicHash,
                spaceThreeTopicHash
            ];

            const peers = Array(10).fill(null).map(() =>
                Array.from({ length: 32 }, () =>
                    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
                ).join('')
            );

            const callTheThrottlerByCount = (peer, count) => {
                for (let index = 0; index < count; index++) {
                    core.managers.throttle.updateByFrequency(peer);
                }
            };

            for (const peer of peers) {
                const socket = getMockSocket(peer);
                core.managers.sockets.addSocket(socket, peer, topics);
                callTheThrottlerByCount(peer, 10);
            }

            // throttle last peer heavily
            callTheThrottlerByCount(peers.at(-1), 100000);

            coreInstance = core;
        });

        it('should return proper state output with spaces and network details', async () => {
            const state = await coreInstance.space.getCurrentState();
            expect(state).toHaveProperty('spaces');
            expect(state).toHaveProperty('network');
            expect(state.spaces).toHaveProperty('synced');
            expect(state.spaces).toHaveProperty('queued');
        })
    })
})
