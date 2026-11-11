// crypto.utils.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  bytesToUtf8,
  hexToUint8,
  hex,
  toBase64,
  fromBase64,
  hash,
  generateRandomSecretKey,
  randomSecret,
  randomNonce,
  randomSalt,
  generateMnemonic,
  seedFromMnemonic,
  edKeyPairFromSeed,
  signJSON,
  verifySignedJSON,
  encryptJSON,
  decryptJSON,
  deriveKeyFromPassword,
  validateKeypair,
} from '../../src/utils/crypto.utils.js';
import type { KeyPair } from '../../src/utils/crypto.utils.js';

describe('crypto.utils', () => {
  describe('bytesToUtf8', () => {
    it('should convert Uint8Array to UTF-8 string', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
      const result = bytesToUtf8(bytes);
      expect(result).toBe('Hello');
    });

    it('should handle empty Uint8Array', () => {
      const bytes = new Uint8Array([]);
      const result = bytesToUtf8(bytes);
      expect(result).toBe('');
    });
  });

  describe('hexToUint8', () => {
    it('should convert hex string to Uint8Array', () => {
      const hexStr = '48656c6c6f'; // "Hello"
      const result = hexToUint8(hexStr);
      expect(result).toEqual(new Uint8Array([72, 101, 108, 108, 111]));
    });

    it('should handle empty hex string', () => {
      const result = hexToUint8('');
      expect(result).toEqual(new Uint8Array([]));
    });
  });

  describe('hex', () => {
    it('should convert Uint8Array to hex string', () => {
      const bytes = new Uint8Array([72, 101, 108, 108, 111]);
      const result = hex(bytes);
      expect(result).toBe('48656c6c6f');
    });

    it('should handle empty Uint8Array', () => {
      const bytes = new Uint8Array([]);
      const result = hex(bytes);
      expect(result).toBe('');
    });
  });

  describe('toBase64 and fromBase64', () => {
    it('should correctly encode and decode base64', () => {
      const original = new Uint8Array([
        72, 101, 108, 108, 111, 32, 87, 111, 114, 108, 100,
      ]);
      const encoded = toBase64(original);
      const decoded = fromBase64(encoded);
      expect(decoded).toEqual(original);
    });

    it('should handle empty Uint8Array', () => {
      const original = new Uint8Array([]);
      const encoded = toBase64(original);
      const decoded = fromBase64(encoded);
      expect(decoded).toEqual(original);
    });
  });

  describe('hash', () => {
    it('should hash string input', () => {
      const input = 'test message';
      const result = hash(input);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32); // SHA-256 produces 32 bytes
    });

    it('should hash Uint8Array input', () => {
      const input = new Uint8Array([1, 2, 3, 4, 5]);
      const result = hash(input);
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(32);
    });

    it('should produce deterministic hashes', () => {
      const input = 'same input';
      const hash1 = hash(input);
      const hash2 = hash(input);
      expect(hash1).toEqual(hash2);
    });
  });

  describe('generateRandomSecretKey', () => {
    it('should generate hex string of specified length', () => {
      const result = generateRandomSecretKey(32);
      expect(typeof result).toBe('string');
      expect(result.length).toBe(64); // 32 bytes = 64 hex chars
    });

    it('should generate different keys each time', () => {
      const key1 = generateRandomSecretKey(32);
      const key2 = generateRandomSecretKey(32);
      expect(key1).not.toBe(key2);
    });

    it('should throw error for invalid byte length', () => {
      expect(() => generateRandomSecretKey(0)).toThrow(TypeError);
      expect(() => generateRandomSecretKey(-1)).toThrow(TypeError);
      expect(() => generateRandomSecretKey(3.14)).toThrow(TypeError);
    });
  });

  describe('randomSecret', () => {
    it('should generate 12-byte Uint8Array', () => {
      const result = randomSecret();
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(12);
    });

    it('should generate different secrets each time', () => {
      const secret1 = randomSecret();
      const secret2 = randomSecret();
      expect(secret1).not.toEqual(secret2);
    });
  });

  describe('randomNonce', () => {
    it('should generate 12-byte Uint8Array for ChaCha20', () => {
      const result = randomNonce();
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(12);
    });

    it('should generate different nonces each time', () => {
      const nonce1 = randomNonce();
      const nonce2 = randomNonce();
      expect(nonce1).not.toEqual(nonce2);
    });
  });

  describe('randomSalt', () => {
    it('should generate 16-byte Uint8Array', async () => {
      const result = await randomSalt();
      expect(result).toBeInstanceOf(Uint8Array);
      expect(result.length).toBe(16);
    });

    it('should generate different salts each time', async () => {
      const salt1 = await randomSalt();
      const salt2 = await randomSalt();
      expect(salt1).not.toEqual(salt2);
    });
  });

  describe('generateMnemonic', () => {
    it('should generate 12-word mnemonic', () => {
      const mnemonic = generateMnemonic();
      const words = mnemonic.split(' ');
      expect(words.length).toBe(12);
    });

    it('should generate valid BIP39 mnemonic', () => {
      const mnemonic = generateMnemonic();
      // Simple validation - check all words are in BIP39 wordlist
      const words = mnemonic.split(' ');
      expect(
        words.every((word) => typeof word === 'string' && word.length > 0),
      ).toBe(true);
    });
  });

  describe('seedFromMnemonic', () => {
    it('should derive 32-byte seed from valid mnemonic', () => {
      const mnemonic = generateMnemonic();
      const seed = seedFromMnemonic(mnemonic);
      expect(seed).toBeInstanceOf(Uint8Array);
      expect(seed.length).toBe(32);
    });

    it('should throw error for invalid mnemonic', () => {
      expect(() => seedFromMnemonic('invalid mnemonic words')).toThrow(
        'Invalid mnemonic',
      );
    });
  });

  describe('edKeyPairFromSeed', () => {
    it('should generate keypair from 32-byte seed', async () => {
      const seed = new Uint8Array(32).fill(1);
      const keypair = await edKeyPairFromSeed(seed);

      expect(keypair).toHaveProperty('publicKey');
      expect(keypair).toHaveProperty('secretKey');
      expect(keypair.publicKey).toBeInstanceOf(Uint8Array);
      expect(keypair.publicKey.length).toBe(32);
      expect(keypair.secretKey).toBeInstanceOf(Uint8Array);
      expect(keypair.secretKey.length).toBe(64);
    });

    it('should throw error for non-32-byte seed', async () => {
      const shortSeed = new Uint8Array(31);
      const longSeed = new Uint8Array(33);

      await expect(edKeyPairFromSeed(shortSeed)).rejects.toThrow(
        'Seed must be 32 bytes',
      );
      await expect(edKeyPairFromSeed(longSeed)).rejects.toThrow(
        'Seed must be 32 bytes',
      );
    });
  });

  describe('signJSON and verifySignedJSON', () => {
    let keypair: KeyPair;
    let testData: { message: string; timestamp: number; id: number };

    beforeEach(async () => {
      const seed = new Uint8Array(32).fill(42);
      keypair = await edKeyPairFromSeed(seed);
      testData = { message: 'test', timestamp: Date.now(), id: 123 };
    });

    it('should sign and verify JSON object', async () => {
      const signature = await signJSON(testData, keypair.secretKey);

      expect(typeof signature).toBe('string');
      expect(signature.length).toBe(128); // 64 bytes = 128 hex chars

      const isValid = await verifySignedJSON(
        testData,
        signature,
        keypair.publicKey,
      );
      expect(isValid).toBe(true);
    });

    it('should work with hex string keys', async () => {
      const secretKeyHex = hex(keypair.secretKey);
      const publicKeyHex = hex(keypair.publicKey);

      const signature = await signJSON(testData, secretKeyHex);
      const isValid = await verifySignedJSON(testData, signature, publicKeyHex);

      expect(isValid).toBe(true);
    });

    it('should reject invalid signature', async () => {
      const signature = await signJSON(testData, keypair.secretKey);
      const tamperedData = { ...testData, message: 'tampered' };

      const isValid = await verifySignedJSON(
        tamperedData,
        signature,
        keypair.publicKey,
      );
      expect(isValid).toBe(false);
    });

    it('should reject wrong public key', async () => {
      const signature = await signJSON(testData, keypair.secretKey);
      const wrongKey = new Uint8Array(32).fill(99);

      const isValid = await verifySignedJSON(testData, signature, wrongKey);
      expect(isValid).toBe(false);
    });

    it('should throw error for invalid key lengths', async () => {
      const invalidSecretKey = new Uint8Array(31);

      await expect(signJSON(testData, invalidSecretKey)).rejects.toThrow();

      await expect(
        verifySignedJSON(testData, 'signature', new Uint8Array(31)),
      ).rejects.toThrow();
    });

    it('should produce canonical signatures (same object structure)', async () => {
      const obj1 = { b: 2, a: 1, c: 3 };
      const obj2 = { c: 3, b: 2, a: 1 };

      const sig1 = await signJSON(obj1, keypair.secretKey);
      const sig2 = await signJSON(obj2, keypair.secretKey);

      expect(sig1).toBe(sig2);
    });
  });

  describe('deriveKeyFromPassword', () => {
    const salt = new Uint8Array(16).fill(1);

    it('should derive key from string password', async () => {
      const key = await deriveKeyFromPassword('myPassword123', salt, 32);

      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('should derive key from Uint8Array password', async () => {
      const passwordBytes = new TextEncoder().encode('myPassword123');
      const key = await deriveKeyFromPassword(passwordBytes, salt, 32);

      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('should produce same key with same inputs', async () => {
      const key1 = await deriveKeyFromPassword('password', salt, 32);
      const key2 = await deriveKeyFromPassword('password', salt, 32);

      expect(key1).toEqual(key2);
    });

    it('should produce different key with different salt', async () => {
      const salt2 = new Uint8Array(16).fill(2);
      const key1 = await deriveKeyFromPassword('password', salt, 32);
      const key2 = await deriveKeyFromPassword('password', salt2, 32);

      expect(key1).not.toEqual(key2);
    });

    it('should produce different key with different password', async () => {
      const key1 = await deriveKeyFromPassword('password1', salt, 32);
      const key2 = await deriveKeyFromPassword('password2', salt, 32);

      expect(key1).not.toEqual(key2);
    });

    it('should derive different key lengths', async () => {
      const key16 = await deriveKeyFromPassword('password', salt, 16);
      const key64 = await deriveKeyFromPassword('password', salt, 64);

      expect(key16.length).toBe(16);
      expect(key64.length).toBe(64);
    });
  });

  describe('encryptJSON and decryptJSON', () => {
    let key: string;
    let nonce: string;
    let testData: Record<string, unknown>;

    beforeEach(async () => {
      key = '00'.repeat(32);
      nonce = '00'.repeat(12);
      testData = {
        message: 'Hello World',
        number: 42,
        nested: { foo: 'bar' },
        array: [1, 2, 3],
      };
    });

    it('should encrypt and decrypt JSON object', async () => {
      const ciphertext = await encryptJSON(key, nonce, testData);

      expect(typeof ciphertext).toBe('string');
      expect(ciphertext.length).toBeGreaterThan(0);

      const decrypted = await decryptJSON(key, nonce, ciphertext);
      expect(decrypted).toEqual(testData);
    });

    it('should throw error for invalid nonce length', async () => {
      const invalidNonce = new Uint8Array(11);

      await expect(
        encryptJSON(key, hex(invalidNonce), testData),
      ).rejects.toThrow('Invalid nonce length');
    });

    it('should throw error for wrong nonce during decryption', async () => {
      const ciphertext = await encryptJSON(key, nonce, testData);
      const wrongNonce = new Uint8Array(12).fill(1);

      await expect(
        decryptJSON(key, hex(wrongNonce), ciphertext),
      ).rejects.toThrow('invalid tag');
    });

    it('should throw error for wrong key during decryption', async () => {
      const ciphertext = await encryptJSON(key, nonce, testData);
      const wrongKey = new Uint8Array(32).fill(1);

      await expect(
        decryptJSON(hex(wrongKey), nonce, ciphertext),
      ).rejects.toThrow('invalid tag');
    });

    it('should throw error for tampered ciphertext', async () => {
      const ciphertext = await encryptJSON(key, nonce, testData);
      const tampered = ciphertext.slice(0, -2) + 'ff'; // Modify last byte

      await expect(decryptJSON(key, nonce, tampered)).rejects.toThrow(
        'invalid tag',
      );
    });

    it('should produce different ciphertexts with same key but different nonce', async () => {
      const nonce2 = new Uint8Array(12).fill(1);
      const ciphertext1 = await encryptJSON(key, nonce, testData);
      const ciphertext2 = await encryptJSON(key, hex(nonce2), testData);

      expect(ciphertext1).not.toBe(ciphertext2);
    });

    it('should encrypt empty object', async () => {
      const emptyData = {};
      const ciphertext = await encryptJSON(key, nonce, emptyData);
      const decrypted = await decryptJSON(key, nonce, ciphertext);

      expect(decrypted).toEqual(emptyData);
    });
  });

  describe('validateKeypair', () => {
    let keypair: KeyPair;

    beforeEach(async () => {
      keypair = await edKeyPairFromSeed(new Uint8Array(32).fill(7));
    });

    it('should accept a consistent keypair', () => {
      expect(validateKeypair(keypair)).toBe(true);
    });

    it('should reject a secretKey whose seed does not produce publicKey', () => {
      const secretKey = new Uint8Array(keypair.secretKey);
      secretKey[0] ^= 0xff; // corrupt the seed half

      expect(() =>
        validateKeypair({ publicKey: keypair.publicKey, secretKey }),
      ).toThrow('Public key does not match the seed part of secretKey');
    });

    it('should reject a secretKey whose embedded public key does not match', () => {
      const secretKey = new Uint8Array(keypair.secretKey);
      secretKey.fill(0xab, 32, 64); // seed stays correct, second half is garbage

      expect(() =>
        validateKeypair({ publicKey: keypair.publicKey, secretKey }),
      ).toThrow('The second half of secretKey does not match publicKey');
    });

    it('should reject keys with wrong lengths', () => {
      expect(() =>
        validateKeypair({
          publicKey: keypair.publicKey.subarray(0, 31),
          secretKey: keypair.secretKey,
        }),
      ).toThrow('Public key must be 32 bytes');

      expect(() =>
        validateKeypair({
          publicKey: keypair.publicKey,
          secretKey: keypair.secretKey.subarray(0, 32),
        }),
      ).toThrow('Secret key must be 64 bytes');
    });
  });

  describe('integration test', () => {
    it('should handle full crypto workflow', async () => {
      // 1. Generate mnemonic
      const mnemonic = generateMnemonic();

      // 2. Derive seed
      const seed = seedFromMnemonic(mnemonic);
      expect(seed.length).toBe(32);

      // 3. Generate keypair
      const keypair = await edKeyPairFromSeed(seed);

      // 4. Sign data
      const data = { action: 'test', id: 1 };
      const signature = await signJSON(data, keypair.secretKey);

      // 5. Verify signature
      const isValid = await verifySignedJSON(
        data,
        signature,
        keypair.publicKey,
      );
      expect(isValid).toBe(true);

      // 6. Generate encryption key from password
      const salt = await randomSalt();
      const password = 'securePassword123';
      const encryptionKey = await deriveKeyFromPassword(password, salt, 32);

      // 7. Encrypt sensitive data
      const sensitiveData = {
        privateKey: hex(keypair.secretKey),
        notes: 'confidential',
      };
      const nonce = randomNonce();
      const ciphertext = await encryptJSON(
        hex(encryptionKey),
        hex(nonce),
        sensitiveData,
      );

      // 8. Decrypt data
      const decrypted = await decryptJSON(
        hex(encryptionKey),
        hex(nonce),
        ciphertext,
      );
      expect(decrypted).toEqual(sensitiveData);
    });
  });
});
