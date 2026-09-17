import * as EVENTS from '../../src/constants/events.constants.js';
import { describe, it, beforeEach, expect } from "vitest";
import { CoreFactory } from "../factory.js";
import { publicKeyIsAllowedToRead } from '../../src/utils/policy.utils.js';

describe('MessageService', () => {
    let factory = null;
    let primaryCore = null;
    let secondaryCore = null;
    let goodSpace = null;
    let badSpace = null;

    beforeEach(async () => {
        factory = new CoreFactory();
        await factory.init();

        const cores = await factory.createMultipleCores(4);
        const keys = cores.map(core => core.publicKey);
        primaryCore = cores[0];
        secondaryCore = cores[1];

        goodSpace = await primaryCore.space.create({
            spaceName: 'good space',
            permissionRead: false,
            readWhitelist: keys // all nodes are allowed to read and sync messages
        });

        badSpace = await secondaryCore.space.create({
            spaceName: 'bad space',
            permissionRead: false,
            readWhitelist: keys,
            permissionBroadcast: false,
            // only nodes 4, 5, and 6 are allowed to send message into space
            broadcastWhitelist: keys.slice(4, 7)
        });
    })

    describe('send', () => {
        it('message  should reach all allowed nodes', async () => {
            // wait for all nodes to discover the topic except the creator of space
            await factory.condition(async (core, success, failure) => {
                core.emitter.on(EVENTS.SpaceSync, () => { success(); })
                await core.space.join(goodSpace.sharelink);
            }, { excludeIndices: [0] });

            // send messsage into the space
            const payload = { data: 'hello world' };
            const sendResult = await primaryCore.messages.send(goodSpace, payload, (rejectionContext) => {
                throw new Error('Received unexpected rejection message');
            });

            const broadcastResult = await factory.condition(async (core, success, failure) => {
                core.emitter.on(EVENTS.SpaceMessage, ({ message, content }) => {
                    if (message.publicKey == primaryCore.publicKey) {
                        if (content.data === payload.data) success();
                        else failure();
                    }
                    else { failure(); }
                })
            }, { excludeIndices: [0] });

            for (const node of sendResult) {
                expect(publicKeyIsAllowedToRead(node.publicKey, goodSpace)).toBe(true);
                expect(node.topics).toContain(goodSpace.topicHash);
            }

            for (const status of broadcastResult) {
                expect(status.success).toBe(true);
            }
        });

        it('should trigger rejection callback after receiving rejection messages connected nodes', async () => {
            // wait for all nodes to discover the topic except the creator of space
            await factory.condition(async (core, success, failure) => {
                setTimeout(failure, 1000);
                core.managers.session.setMessageConfig({ allowThrottleRejection: true });
                core.emitter.on(EVENTS.SpaceSync, () => { success(); })
                await core.space.join(badSpace.sharelink);
            }, { excludeIndices: [1] });

            // send messsage into the space
            const payload = { data: 'hello world' };

            const rejects = await new Promise(resolve => {
                let broadcastList = null;

                const rejectionCallback = ({ message }) => { resolve({ broadcastList, message }); };

                primaryCore.messages.send(badSpace, payload, rejectionCallback)
                    .then(result => { broadcastList = result; })
                    .catch(error => { throw new Error(error) });
            });

            expect(rejects.broadcastList.length > 0).toBe(true);
            expect(
                rejects.broadcastList
                    .filter(r => r.status === 'fulfilled').length > 0
            ).toBe(true);

            expect(rejects.message.type).toBe(EVENTS.Reject);
        })
    });
})