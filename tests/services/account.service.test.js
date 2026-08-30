import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { createCore } from '../../src/core';
import { createAccount } from '../../src/utils/accounts.utils';
import { makeTempDir, cleanup } from '../general.utils';

describe('AccountService', () => {
    let core;
    let tempDir;

    beforeEach(async () => {
        tempDir = await makeTempDir();
        core = await createCore({
            rootPath: tempDir
        });
    })

    afterEach(async () => {
        await cleanup(tempDir);
    })

    describe('initialization', () => {
        it('should create account service instance', async => {
            expect(core).toBeDefined();
            expect(core.accounts).toBeDefined();
        })
    })

    describe('listAccounts', () => {
        it('should return empty array when no account exists', async () => {
            const accounts = await core.accounts.list();
            expect(Array.isArray(accounts)).toBe(true);
            expect(accounts).toHaveLength(0)
        })

        it('should return account metadata', async () => {
            let username = 'me';
            let password = 'me';

            let initialAccount = await createAccount(username, password, tempDir);
            const accountList = await core.accounts.list();

            expect(accountList).toHaveLength(1);
            expect(accountList[0].publicKey).toBe(initialAccount.publicKey);
        })
    })

    describe('createAccount', () => {
        it('should throw if username is invalid', async () => {
            await expect(
                core.accounts.create(null, 'pass')
            ).rejects.toThrow(/Invalid username parameter/);
        })

        it('should throw is password is invalid', async () => {
            await expect(
                core.accounts.create('username', null)
            ).rejects.toThrow(/Invalid password parameter/);
        })

        it('should create account', async () => {
            const username = 'me';
            const password = 'me';

            const result = await core.accounts.create(username, password);
            expect(result.username).toBe(username);
            expect(result).toHaveProperty('publicKey');
            expect(result).toHaveProperty('mnemonic');
        })
    })

    describe('recover', () => {
        it('should recovery credentials from valid mnemonic', async () => {
            const info = await core.accounts.create('initialUser', '123');
            const recovery = await core.accounts.recover('recovered', '123', info.mnemonic);
            const list = await core.accounts.list();

            expect(recovery.publicKey).toBe(info.publicKey);
            expect(list.length).toBe(2);
        });
    });

    describe('authenticate', () => {
        it('should throw if username is invalid', async () => {
            await expect(core.accounts.authenticate('', 'pass')).rejects.toThrow();
            await expect(core.accounts.authenticate(null, 'pass')).rejects.toThrow();
            await expect(core.accounts.authenticate(123, 'pass')).rejects.toThrow();
        })

        it('should throw if password is invalid', async () => {
            await expect(core.accounts.authenticate('alice', '')).rejects.toThrow();
            await expect(core.accounts.authenticate('alice', null)).rejects.toThrow();
            await expect(core.accounts.authenticate('alice', 123)).rejects.toThrow();
        })


        it('should throw if password is wrong', async () => {
            let username = 'me';
            let password = 'me';

            await core.accounts.create(username, password);
            await expect(
                core.accounts.authenticate(username, 'notmypassoword')
            ).rejects.toThrow(/Invalid password/);
        })

        it('should authentication with correct username and password', async () => {
            let username = 'me';
            let password = 'me';

            await core.accounts.create(username, password);
            const login = await core.accounts.authenticate(username, password);

            expect(login.username).toBe(username);
            expect(login.secretKey).toBeDefined();
            expect(login.publicKey).toBeDefined();

            await core.accounts.logout();
        })
    })
})