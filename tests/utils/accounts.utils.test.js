import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

import {
  hexToUint8,
  seedFromMnemonic,
  edKeyPairFromSeed,
  hex
}
from '../../src/utils/crypto.utils.js'

import {
  accountBaseDir,
  accountDotDir,
  readAccountMeta,
  ensureAccountExists,
  listAccountsWithMeta,
  createAccount,
  authenticateAccount,
  deleteAccount,
  createAccountFromMnemonic
} from '../../src/utils/accounts.utils.js'


describe('Account Utilities', () => {
  let tempRoot

  beforeAll(async () => {
    // Create a unique temporary directory for all tests
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'account-utils-test-'))
  })

  afterAll(async () => {
    // Clean up: remove the temporary directory and all its contents
    try {
      await fs.rm(tempRoot, { recursive: true, force: true })
    } catch (error) {
      console.warn('Failed to clean up temp directory:', error.message)
    }
  })

  beforeEach(async () => {
    // Clear the temp directory before each test
    try {
      await fs.rm(tempRoot, { recursive: true, force: true })
      await fs.mkdir(tempRoot, { recursive: true })
    } catch (error) {
      // Directory might not exist yet
      await fs.mkdir(tempRoot, { recursive: true })
    }
  })

  describe('accountBaseDir', () => {
    it('should return correct path for username with root', () => {
      const username = 'testuser'
      const result = accountBaseDir(username, tempRoot)
      expect(result).toBe(path.join(tempRoot, username))
    })

    it('should throw error for empty username', () => {
      expect(() => accountBaseDir('', tempRoot)).toThrow('username must be a non-empty string')
    })

    it('should throw error for non-string username', () => {
      expect(() => accountBaseDir(null, tempRoot)).toThrow('username must be a non-empty string')
      expect(() => accountBaseDir(123, tempRoot)).toThrow('username must be a non-empty string')
      expect(() => accountBaseDir({}, tempRoot)).toThrow('username must be a non-empty string')
    })
  })

  describe('accountDotDir', () => {
    it('should return correct .account path', () => {
      const username = 'testuser'
      const result = accountDotDir(username, tempRoot)
      expect(result).toBe(path.join(tempRoot, username, '.account'))
    })
  })

  describe('readAccountMeta', () => {
    it('should return null when .account/meta.json does not exist', async () => {
      const userRoot = path.join(tempRoot, 'nonexistent')
      const meta = await readAccountMeta(userRoot)
      expect(meta).toBeNull()
    })

    it('should return null when meta.json has invalid JSON', async () => {
      const userRoot = path.join(tempRoot, 'invalidjson')
      const accountDir = path.join(userRoot, '.account')
      await fs.mkdir(accountDir, { recursive: true })
      await fs.writeFile(path.join(accountDir, 'meta.json'), '{invalid json')

      const meta = await readAccountMeta(userRoot)
      expect(meta).toBeNull()
    })

    it('should return null when meta.json missing required fields', async () => {
      const userRoot = path.join(tempRoot, 'missingfields')
      const accountDir = path.join(userRoot, '.account')
      await fs.mkdir(accountDir, { recursive: true })

      const incompleteMeta = { username: 'testuser' } // missing publicKey
      await fs.writeFile(path.join(accountDir, 'meta.json'), JSON.stringify(incompleteMeta))

      const meta = await readAccountMeta(userRoot)
      expect(meta).toBeNull()
    })

    it('should return valid meta when file exists with all required fields', async () => {
      const userRoot = path.join(tempRoot, 'validuser')
      const accountDir = path.join(userRoot, '.account')
      await fs.mkdir(accountDir, { recursive: true })

      const validMeta = {
        username: 'validuser',
        publicKey: 'testpublickey123',
        createdAt: Date.now()
      }
      await fs.writeFile(path.join(accountDir, 'meta.json'), JSON.stringify(validMeta))

      const meta = await readAccountMeta(userRoot)
      expect(meta).toEqual(validMeta)
    })
  })

  describe('ensureAccountExists', () => {
    it('should throw error for empty username', async () => {
      await expect(ensureAccountExists('', tempRoot)).rejects.toThrow('username required')
    })

    it('should throw error when account does not exist', async () => {
      await expect(ensureAccountExists('nonexistent', tempRoot)).rejects.toThrow('Account "nonexistent" not found or meta.json invalid')
    })

    it('should throw error when meta.json is invalid', async () => {
      const userRoot = path.join(tempRoot, 'invaliduser')
      const accountDir = path.join(userRoot, '.account')
      await fs.mkdir(accountDir, { recursive: true })

      // Create invalid meta.json
      await fs.writeFile(path.join(accountDir, 'meta.json'), JSON.stringify({}))

      await expect(ensureAccountExists('invaliduser', tempRoot)).rejects.toThrow('Account "invaliduser" not found or meta.json invalid')
    })

    it('should return meta when account exists and is valid', async () => {
      const username = 'existinguser'
      const userRoot = path.join(tempRoot, username)
      const accountDir = path.join(userRoot, '.account')
      await fs.mkdir(accountDir, { recursive: true })

      const validMeta = {
        username,
        publicKey: 'testpublickey456',
        createdAt: Date.now()
      }
      await fs.writeFile(path.join(accountDir, 'meta.json'), JSON.stringify(validMeta))

      const result = await ensureAccountExists(username, tempRoot)
      expect(result).toEqual(validMeta)
    })
  })

  describe('listAccountsWithMeta', () => {
    beforeEach(async () => {
      // Create some test directories
      await fs.mkdir(path.join(tempRoot, 'valid1', '.account'), { recursive: true })
      await fs.mkdir(path.join(tempRoot, 'valid2', '.account'), { recursive: true })
      await fs.mkdir(path.join(tempRoot, 'invalid1', '.account'), { recursive: true })
      await fs.mkdir(path.join(tempRoot, 'emptyfolder'), { recursive: true })
      await fs.mkdir(path.join(tempRoot, 'nometa', 'someotherfolder'), { recursive: true })

      // Write valid meta.json files
      const meta1 = {
        username: 'valid1',
        publicKey: 'key1',
        createdAt: 1000
      }
      await fs.writeFile(
        path.join(tempRoot, 'valid1', '.account', 'meta.json'),
        JSON.stringify(meta1)
      )

      const meta2 = {
        username: 'valid2',
        publicKey: 'key2',
        createdAt: 2000
      }
      await fs.writeFile(
        path.join(tempRoot, 'valid2', '.account', 'meta.json'),
        JSON.stringify(meta2)
      )

      // Write invalid meta.json (missing required fields)
      await fs.writeFile(
        path.join(tempRoot, 'invalid1', '.account', 'meta.json'),
        JSON.stringify({ username: 'invalid1' }) // missing publicKey
      )
    })

    it('should return only directories with valid meta.json', async () => {
      const accounts = await listAccountsWithMeta(tempRoot)

      expect(accounts).toHaveLength(2)
      expect(accounts.map(a => a.username)).toEqual(expect.arrayContaining(['valid1', 'valid2']))

      // Check each account has expected properties
      accounts.forEach(account => {
        expect(account).toHaveProperty('username')
        expect(account).toHaveProperty('publicKey')
        expect(account).toHaveProperty('path')
        expect(account.path).toContain(account.username)
      })
    })

    it('should include path in returned objects', async () => {
      const accounts = await listAccountsWithMeta(tempRoot)

      const valid1Account = accounts.find(a => a.username === 'valid1')
      expect(valid1Account).toBeDefined()
      expect(valid1Account.path).toBe(path.join(tempRoot, 'valid1'))
    })

    it('should handle empty root directory', async () => {
      const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'empty-test-'))
      try {
        const accounts = await listAccountsWithMeta(emptyDir)
        expect(accounts).toEqual([])
      } finally {
        await fs.rm(emptyDir, { recursive: true, force: true })
      }
    })

    it('should create root directory if it does not exist', async () => {
      const nonExistentDir = path.join(tempRoot, 'nonexistent-subdir')
      const accounts = await listAccountsWithMeta(nonExistentDir)
      expect(accounts).toEqual([])

      // Verify directory was created
      const stats = await fs.stat(nonExistentDir)
      expect(stats.isDirectory()).toBe(true)
    })
  })

  describe('createAccount', () => {
    it('should throw error for empty username', async () => {
      await expect(createAccount('', 'password123', tempRoot)).rejects.toThrow('Username required')
    })

    it('should throw error for whitespace-only username', async () => {
      await expect(createAccount('   ', 'password123', tempRoot)).rejects.toThrow('Username required')
    })

    it('should throw error when account already exists', async () => {
      // Create a directory with the username
      await fs.mkdir(path.join(tempRoot, 'existinguser'), { recursive: true })

      await expect(createAccount('existinguser', 'password123', tempRoot)).rejects.toThrow('Account already exists')
    })

    it('should create account structure and return correct data', async () => {
      const username = 'newuser'
      const password = 'testpassword123'

      const result = await createAccount(username, password, tempRoot)

      expect(result.username).toBe(username.toLowerCase())
      expect(result.mnemonic).toBeTruthy()
      expect(result.mnemonic.split(' ').length).toBeGreaterThanOrEqual(12)
      // expect 32 in Bytes and 64 in Hex
      expect(result.publicKey).toMatch(/^[0-9a-f]{64}$/)
      expect(result.path).toBe(path.join(tempRoot, username.toLowerCase()))

      // verify directory structure was created
      const userRoot = path.join(tempRoot, username.toLowerCase())
      const accountDir = path.join(userRoot, '.account')
      const driveDir = path.join(userRoot, 'drive')

      await expect(fs.stat(userRoot)).resolves.toBeTruthy()
      await expect(fs.stat(accountDir)).resolves.toBeTruthy()
      await expect(fs.stat(driveDir)).resolves.toBeTruthy()

      const metaContent = await fs.readFile(path.join(accountDir, 'meta.json'), 'utf-8')
      const meta = JSON.parse(metaContent)

      expect(meta.username).toBe(username.toLowerCase())
      expect(meta.publicKey).toBe(result.publicKey)
      // expect 12 in Bytes and 24 in Hex
      expect(meta.nonce).toMatch(/^[0-9a-f]{24}$/)
      // expect 16 in Bytes and 32 in Hex
      expect(meta.salt).toMatch(/^[0-9a-f]{32}$/)
      expect(meta.createdAt).toBeGreaterThan(0)

      // verify credentials.enc.json exists
      const encContent = await fs.readFile(path.join(accountDir, 'credentials.enc.json'), 'utf-8')
      expect(encContent).toBeTruthy()

      const authResult = await authenticateAccount(username, password, tempRoot);
      // verify authentication returns correct data
      expect(authResult.username).toBe(username.toLowerCase())
      expect(authResult.publicKey).toBe(result.publicKey)
      expect(authResult.secretKey).toMatch(/^[0-9a-f]{128}$/)

    })

    it('should trim whitespace from username', async () => {
      const username = '  spaceduser  '
      const password = 'password123'

      const result = await createAccount(username, password, tempRoot)

      expect(result.username).toBe('spaceduser')
      expect(result.path).toBe(path.join(tempRoot, 'spaceduser'))
    })

    it('should create root directory if it does not exist', async () => {
      const nonExistentRoot = path.join(tempRoot, 'new-root-dir')
      const username = 'testuser'
      const password = 'password123'

      const result = await createAccount(username, password, nonExistentRoot)

      expect(result.path).toBe(path.join(nonExistentRoot, username))

      // Verify directory was created
      await expect(fs.stat(nonExistentRoot)).resolves.toBeTruthy()
      await expect(fs.stat(result.path)).resolves.toBeTruthy()
    })

    describe('integration: create and list accounts', () => {
      it('should create multiple accounts and list them correctly', async () => {
        // Create first account
        const result1 = await createAccount('user1', 'password1', tempRoot)

        // Create second account
        const result2 = await createAccount('user2', 'password2', tempRoot)

        // List all accounts
        const accounts = await listAccountsWithMeta(tempRoot)

        expect(accounts).toHaveLength(2)

        // Verify both accounts are in the list
        const user1Account = accounts.find(a => a.username === 'user1')
        const user2Account = accounts.find(a => a.username === 'user2')

        expect(user1Account).toBeDefined()
        expect(user2Account).toBeDefined()

        expect(user1Account.publicKey).toBe(result1.publicKey)
        expect(user2Account.publicKey).toBe(result2.publicKey)

        // Verify ensureAccountExists works for both
        const meta1 = await ensureAccountExists('user1', tempRoot)
        expect(meta1.publicKey).toBe(result1.publicKey)

        const meta2 = await ensureAccountExists('user2', tempRoot)
        expect(meta2.publicKey).toBe(result2.publicKey)
      })
    })
  })

  describe('createAccountFromMnemonic', () => {
    let mnemonic;
    let expectedPublicKey;

    beforeEach(async () => {
      const info = await createAccount('testUser', 'testPassword', tempRoot);
      mnemonic = info.mnemonic;
      expectedPublicKey = info.publicKey;
    });

    it('should create an account from a valid mnemonic', async () => {
      const username = 'recoveryUsername';
      const info = await createAccountFromMnemonic(username, 'recoveryPassword', mnemonic, tempRoot);
      const status = await ensureAccountExists(username, tempRoot);
      
      expect(info.publicKey).toBe(expectedPublicKey);
      expect(status).toBeDefined();
      expect(status.publicKey).toBe(expectedPublicKey);
    });

    it('should allow authentication with correct password', async () => {

    });
  });

  describe('authenticateAccount', () => {
    it('should return decrypted credentials for valid account', async () => {
      const username = 'testauth'
      const password = 'testpass'

      // Create account first
      const { publicKey, mnemonic } = await createAccount(username, password, tempRoot)

      // Test authentication
      const authResult = await authenticateAccount(username, password, tempRoot)

      expect(authResult).toEqual({
        username: 'testauth',
        publicKey: publicKey,
        secretKey: expect.stringMatching(/^[0-9a-f]{128}$/)
      })

      // Verify secret key can be used
      const secretKeyBytes = hexToUint8(authResult.secretKey)
      expect(secretKeyBytes.length).toBe(64)
    })

    it('should handle corrupted ciphertext gracefully', async () => {
      const username = 'corruptuser'
      const password = 'testpass'

      // Create account
      await createAccount(username, password, tempRoot)

      // Corrupt the credentials file
      const userRoot = path.join(tempRoot, username)
      const credsPath = path.join(userRoot, '.account', 'credentials.enc.json')
      await fs.writeFile(credsPath, 'corrupteddata')

      // Should throw authentication error
      await expect(authenticateAccount(username, password, tempRoot))
        .rejects.toThrow()
    })

    it('should handle malformed meta.json', async () => {
      const username = 'malformeduser'
      const password = 'testpass'

      // Create account
      await createAccount(username, password, tempRoot)

      // Corrupt the meta.json file
      const userRoot = path.join(tempRoot, username)
      const metaPath = path.join(userRoot, '.account', 'meta.json')
      await fs.writeFile(metaPath, 'invalid json')

      // Should throw appropriate error
      await expect(authenticateAccount(username, password, tempRoot))
        .rejects.toThrow(/invalid|failed/i)
    })
  })

  describe('deleteAccount', () => {
    it('should delete valid account', async () => {
      const username = 'randomUser';
      await createAccount(username, 'password', tempRoot);

      const listBeforeDelete = await listAccountsWithMeta(tempRoot);
      await deleteAccount(username, tempRoot);
      const listAfterDelete = await listAccountsWithMeta(tempRoot);

      expect(listBeforeDelete.length).toBe(1);
      expect(listAfterDelete.length).toBe(0);
    });

    it('should throw error if account does not exist', async () => {
      await expect(deleteAccount('randomUser', tempRoot))
        .rejects.toThrow();
    })
  })

  describe('integration: create, authenticate, and use accounts', () => {
    it('should create multiple accounts and authenticate each independently', async () => {
      const accounts = [
        { username: 'user1', password: 'pass1' },
        { username: 'user2', password: 'pass2' },
        { username: 'user3', password: 'pass3' }
      ]

      const createdAccounts = []

      // Create all accounts
      for (const account of accounts) {
        const result = await createAccount(account.username, account.password, tempRoot)
        createdAccounts.push({ ...account, result })
      }

      // Authenticate each account
      for (const account of createdAccounts) {
        const authResult = await authenticateAccount(
          account.username,
          account.password,
          tempRoot
        )

        expect(authResult.username).toBe(account.username)
        expect(authResult.publicKey).toBe(account.result.publicKey)

        // Verify mnemonic still works
        const seed = seedFromMnemonic(account.result.mnemonic)
        const keyPair = await edKeyPairFromSeed(seed)
        expect(hex(keyPair.publicKey)).toBe(authResult.publicKey)
      }

      // Verify wrong passwords fail
      for (const account of createdAccounts) {
        await expect(
          authenticateAccount(account.username, 'wrongpassword', tempRoot)
        ).rejects.toThrow('Invalid password')
      }
    })
  })
})