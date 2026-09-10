import { describe, it, expect } from "vitest";
import { buildTestSpacePayload } from "../general.utils.js";
import { publicKeyIsAllowedToRead, publicKeyIsAllowedToBroadcast, spaceShouldEncryptMessages } from "../../src/utils/policy.utils.js";

describe('Policy Utilities', () => {
    describe('spaceShouldEncryptMessages', () => {
        it('should return false if the permissionRead is true', async () => {
            const space = await buildTestSpacePayload({
                spaceName: 'Public Channel!',
                permissionRead: true,
                readWhitelist: []
            });

            // no secret key for public spaces
            expect(space.secret).toBeDefined();
            expect(space.secret).toBe(null);

            const result = spaceShouldEncryptMessages(space);
            expect(result).toBe(false);
        })

        it('should return true if read whitelist has been set', async () => {
            const otherNode = 'a'.repeat(64);
            const space = await buildTestSpacePayload({
                spaceName: 'Private Channel!',
                permissionRead: false,
                readWhitelist: [otherNode]
            });

            expect(space.secret).toBeDefined();
            expect(space.secret).not.toBe(null);

            const result = spaceShouldEncryptMessages(space);
            expect(result).toBe(true);
        })

        it('should return false if the secret key is missing even if the space is set to private', async () => {
            const otherNode = 'a'.repeat(64);
            const space = await buildTestSpacePayload({
                spaceName: 'Private Channel!',
                permissionRead: false,
                readWhitelist: [otherNode]
            });

            // manually remove the secret key
            space.secret = null;

            const result = spaceShouldEncryptMessages(space);
            expect(result).toBe(false);
        })
    })

    describe('publicKeyIsAllowedToRead', () => {
        it('should return true if the publicKey belongs to the space owner', async () => {
            const space = await buildTestSpacePayload({ spaceName: 'Private Room' });
            const { publicKey } = space;
            const result = publicKeyIsAllowedToRead(publicKey, space);

            expect(result).toBe(true);
        })

        it('should return true if permissionTrue is set to true', async () => {
            const space = await buildTestSpacePayload({ permissionRead: true, readWhitelist: [] });
            const result = publicKeyIsAllowedToRead('publickey123', space);

            expect(result).toBe(true);
        })

        it('should return true if publickey is in readWhitelist', async () => {
            const space = await buildTestSpacePayload({ permissionRead: false, readWhitelist: ['pub123'] });
            const result = publicKeyIsAllowedToRead('pub123', space);

            expect(result).toBe(true);
        })

        it('should return false if readWhitelist does not include the publicKey', async () => {
            const space = await buildTestSpacePayload({
                permissionRead: false,
                readWhitelist: ['pubkey456', 'pubkey789']
            });
            const result = publicKeyIsAllowedToRead('pubkey123', space);

            expect(result).toBe(false);
        })
    })

    describe('publicKeyIsAllowedToBroadcast', () => {
        it('should return true if permissionBroadcast is set to true', async () => {
            const space = await buildTestSpacePayload({ permissionBroadcast: true, broadcastWhitelist: [] });
            const result = publicKeyIsAllowedToBroadcast('publickey123', space);

            expect(result).toBe(true);
        })

        it('should return true if publickey is in broadcastWhitelist', async () => {
            const space = await buildTestSpacePayload({ permissionBroadcast: false, broadcastWhitelist: ['pub123'] });
            const result = publicKeyIsAllowedToBroadcast('pub123', space);

            expect(result).toBe(true);
        })

        it('should return false if broadcastWhitelist does not include the publicKey', () => {
            const space = {
                permissionBroadcast: false,
                broadcastWhitelist: ['pubkey456', 'pubkey789']
            };
            const result = publicKeyIsAllowedToBroadcast('pubkey123', space);
            expect(result).toBe(false);
        })
    })
})