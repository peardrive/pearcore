import { describe, it, beforeEach, afterEach, expect, should } from "vitest";
import * as EVENTS from '../../src/constants/events.constants.js';
import { startBootstrapper } from "../../src/utils/network.utils";
import { getRandomPort, buildTestSpacePayload, makeTempDir, getMockSocket } from '../general.utils.js';
import { createCore } from '../../src/core.js';
import { getSpaceTopicHash } from "../../src/utils/space.utils.js";
import { encodeShareLink, queryShareLink } from "../../src/utils/sharelink.utils.js";

const setupTestCore = async (bootstrapper) => {
    const root = await makeTempDir();
    const core = await createCore({
        bootstrap: bootstrapper,
        rootPath: root
    });

    await core.accounts.create('testUser', 'testPassword');
    await core.accounts.authenticate('testUser', 'testPassword');

    return { ...core, root };
}

const killBootstapper = (bootstrapper) => {
    bootstrapper.bootstrapperNode.destroy();
    bootstrapper.persistentNode.destroy();
}

describe('spaceService', () => {
    let bootstrapperInstance = null;
    let bootstrapperEndpoint = null;

    beforeEach(async () => {
        const randomPort = getRandomPort();
        bootstrapperInstance = await startBootstrapper({
            ipv4: '127.0.0.1',
            port: randomPort
        });

        bootstrapperEndpoint = `127.0.0.1:${randomPort}`;
    })

    afterEach(() => { killBootstapper(bootstrapperInstance); })

    describe('create', () => {
        it('should create a new space and join the topic', async () => {
            const core = await setupTestCore(bootstrapperEndpoint);

            const payload = await buildTestSpacePayload();
            const space = await core.space.create(payload);

            const { publicKey } = core.managers.session.getCredentials();

            expect(space.spaceName).toBe(payload.spaceName);
            expect(space.publicKey).toBe(publicKey);
            expect(space.nonce).toBe(payload.nonce);
            expect(core.managers.connection.isDiscoverable(space.topicHash));
        })
    })

    describe('join', () => {
        it('should join an existing space using sharelink', async () => {
            const primaryCore = await setupTestCore(bootstrapperEndpoint);
            const secondaryCore = await setupTestCore(bootstrapperEndpoint);

            const { publicKey: primaryPublicKey } = primaryCore.managers.session.getCredentials();
            const { publicKey: secondaryPublicKey } = secondaryCore.managers.session.getCredentials();

            let primaryMessageReceived = false;
            let secondaryMessageReceived = false;


            const connectPromise = new Promise(resolve => {
                const shouldResolve = () => primaryMessageReceived && secondaryMessageReceived;
                setTimeout(() => resolve(), 2000);

                primaryCore.emitter.on(EVENTS.SpaceHashList, message => {
                    secondaryMessageReceived = true;
                    if (shouldResolve()) resolve();
                })

                secondaryCore.emitter.on(EVENTS.SpaceHashList, message => {
                    primaryMessageReceived = true;
                    if (shouldResolve()) resolve();
                })
            });

            const space = await primaryCore.space.create({ spaceName: 'generic' });
            await secondaryCore.space.join(space.sharelink);

            await connectPromise;

            const primarySnapShot = primaryCore.managers.sockets.getSnapShot({ sortByPeers: true });
            const secondarySnapShot = secondaryCore.managers.sockets.getSnapShot({ sortByPeers: true });

            expect(primarySnapShot[secondaryPublicKey]).toEqual([space.topicHash]);
            expect(secondarySnapShot[primaryPublicKey]).toEqual([space.topicHash]);
        })

        it('should broadcast the new topic to connected peers', async () => {
            const primaryCore = await setupTestCore(bootstrapperEndpoint);
            const secondaryCore = await setupTestCore(bootstrapperEndpoint);

            const { publicKey: secondaryPublicKey } = secondaryCore.managers.session.getCredentials();

            const messageWaitingPromise = new Promise(resolve => {
                primaryCore.emitter.on(EVENTS.SpaceHashList, message => {
                    resolve();
                })
            })

            const space = await primaryCore.space.create({ spaceName: 'generic' });
            await secondaryCore.space.join(space.sharelink);

            const randomSpace = await buildTestSpacePayload({ spaceName: 'randomSpace' });
            const randomSharelink = encodeShareLink(randomSpace);
            const randomTopicHash = getSpaceTopicHash(randomSpace);
            await secondaryCore.space.join(randomSharelink);

            await messageWaitingPromise;

            const primarySnapShot = primaryCore.managers.sockets.getSnapShot({ sortByPeers: true });
            expect(primarySnapShot[secondaryPublicKey].length).toBe(2);
            expect(primarySnapShot[secondaryPublicKey]).toEqual([space.topicHash, randomTopicHash]);
        })
    })

    describe('leave', () => {
        it('should delete space record and update nodes', async () => {
            const primaryCore = await setupTestCore(bootstrapperEndpoint);
            const secondaryCore = await setupTestCore(bootstrapperEndpoint);

            const { publicKey: secondaryPublicKey } = secondaryCore.managers.session.getCredentials();

            const messageWaitingPromise = new Promise(resolve => {
                primaryCore.emitter.on(EVENTS.SpaceHashList, message => {
                    resolve();
                })
            })

            const space = await primaryCore.space.create({ spaceName: 'original' });
            const secondaryJoinedSpace = await secondaryCore.space.join(space.sharelink);

            const randomSpace = await buildTestSpacePayload({ spaceName: 'random space' });
            const randomSharelink = encodeShareLink(randomSpace);
            const randomTopicHash = getSpaceTopicHash(randomSpace);
            await secondaryCore.space.join(randomSharelink);

            await messageWaitingPromise;

            const primarySnapShot = primaryCore.managers.sockets.getSnapShot({ sortByPeers: true });
            expect(primarySnapShot[secondaryPublicKey].length).toBe(2);
            expect(primarySnapShot[secondaryPublicKey]).toEqual([space.topicHash, randomTopicHash]);

            await secondaryCore.space.leave(secondaryJoinedSpace);

            let updatedPrimarySnapShot = null;

            // 50ms delay for update to fully settle in primary
            await new Promise(resolve => {
                setTimeout(() => {
                    updatedPrimarySnapShot = primaryCore.managers.sockets.getSnapShot();
                    resolve();
                }, 50)
            });

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
            const primaryCore = await setupTestCore(bootstrapperEndpoint);
            const space = await primaryCore.space.create({ spaceName: 'space num.1' });

            const randomSpace = await buildTestSpacePayload({ spaceName: 'space num.2' });
            const randomSharelink = encodeShareLink(randomSpace);
            await primaryCore.space.join(randomSharelink);

            primaryCoreInstance = primaryCore;
            spaceOne = space;
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
            const core = await setupTestCore(bootstrapperEndpoint);
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
            ]

            const peers = Array(10).fill(null).map(() => {
                return Array.from({ length: 32 }, () =>
                    Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
                ).join('');

            });

            const callTheThrottlerByCount = (peer, count) => {
                for (let index = 0; index < count; index++) {
                    core.managers.throttle.updateByFrequency(peer);
                }
            }

            for (const peer of peers) {
                const socket = getMockSocket(peer)
                core.managers.sockets.addSocket(socket, peer, topics);
                callTheThrottlerByCount(peer, 10);
            }

            // we need to trotthle the last peer for the experiment
            callTheThrottlerByCount(peers.at(-1), 100000);

            coreInstance = core;
        })

        it('should return proper state output with spaces and network details', async () => {
            const state = await coreInstance.space.getCurrentState();
            expect(state).toHaveProperty('spaces');
            expect(state).toHaveProperty('network');
            expect(state.spaces).toHaveProperty('synced');
            expect(state.spaces).toHaveProperty('queued');
        })
    })
})
