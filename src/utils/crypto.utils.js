import * as b4a from 'b4a';
import bip39 from 'bip39';
import canonicalize from 'canonicalize';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { blake3 } from '@noble/hashes/blake3.js'
import { ed25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes, utf8ToBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils.js';

export function bytesToUtf8(bytes) {
  return b4a.toString(bytes, 'utf8')
}

/**
 * Convert hex string to Uint8Array
 * @param {string} hexStr
 * @returns {Uint8Array}
 */
export function hexToUint8(hexStr) {
  return hexToBytes(hexStr);
}

/**
 * Convert hex string to Buffer
 * @param {string} hexStr
 * @returns {Buffer}
 */
export function hexToBuffer(hexStr) {
  return Buffer.from(hexStr, 'hex');
}


/**
 * Convert a Uint8Array to hex string.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function hex(bytes) {
  return bytesToHex(bytes);
}

/**
 * Convert Buffer into String
 * @param {Uint8Array} buffer 
 * @returns {String}
 */
export const toUTF8 = (buffer) => b4a.toString(buffer, 'utf8');

/**
* Base64 encode a Uint8Array.
* @param {Uint8Array} u8
* @returns {string}
*/
export const toBase64 = (u8) => b4a.toString(u8, 'base64');

/**
* Base64 decode to Uint8Array.
* @param {string} s
* @returns {Uint8Array}
*/
export const fromBase64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));

/**
 * Deterministically stringify a JSON-compatible value with stable key ordering.
 * Ensures identical byte output for logically equivalent objects (used for hashing/signing).
 * @param {Object} obj - JSON-serializable value
 * @returns {String} Canonical JSON string
 */
export function canonicalStringify(object) {
  return canonicalize(object);
}

/**
* Compute BLAKE-3 hash of a string or Uint8Array using @noble/hashes.
* @param {string|Uint8Array} input
* @returns {Uint8Array}
*/
export function hash(input) {
  const buf = typeof input === 'string'
    ? utf8ToBytes(input)
    : input;

  return blake3(buf);
}

/**
 * Generate a cryptographically secure random secret key (hex encoded)
 *
 * @param {number} bytes - Number of random bytes to generate
 * @returns {Promise<string>} Hex-encoded random key
 * @throws {TypeError} If bytes is not a positive integer
 */
export function generateRandomSecretKey(bytes = 32) {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new TypeError('bytes must be a positive integer');
  }

  const buffer = randomBytes(bytes);
  return bytesToHex(buffer);
}


/**
 * Random secret generator
 * @param {Number} length 
 * @returns 
 */
export function randomSecret() {
  return randomBytes(12);
}

/**
 * Random nonce generator
 * @param {Number} length 
 * @returns 
 */
export function randomNonce() {
  return randomBytes(12);
}

/**
* Generate a random salt for password key derivation.
* @returns {Uint8Array}
*/
export async function randomSalt() {
  return randomBytes(16);
}

/**
 * Generate a new 12-word mnemonic.
 * @returns {string}
 */
export function generateMnemonic() {
  return bip39.generateMnemonic(128) // 128 bits entropy → 12 words
}

/**
 * Derive a 32-byte seed from a BIP39 mnemonic.
 * @param {string} mnemonic
 * @returns {Uint8Array}
 */
export function seedFromMnemonic(mnemonic) {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic')
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic)
  return seed.subarray(0, 32)
}

/**
 * Generate an Ed25519 keypair from a 32-byte seed.
 * @param {Uint8Array} seed32
 * @returns {{publicKey: Uint8Array, secretKey: Uint8Array}}
 */
export async function edKeyPairFromSeed(seed32) {
  if (seed32.length !== 32) {
    throw new Error(`Seed must be 32 bytes, got ${seed32.length}`);
  }

  const publicKey = await ed25519.getPublicKey(seed32);

  // Hyperswarm expects: seed || publicKey
  const secretKey = new Uint8Array(64);
  secretKey.set(seed32, 0);
  secretKey.set(publicKey, 32);

  return { publicKey, secretKey };
}

/**
 * Validate a Ed25519 keypair.
 * @param {object} keyPair - { publicKey: Uint8Array, secretKey: Uint8Array }
 * @returns {boolean} - true if valid, throws descriptive error otherwise
 */
export function validateKeypair({ publicKey, secretKey, seedLength=32 }) {
  if (!publicKey || !secretKey) {
    throw new Error('publicKey and secretKey are required');
  }

  if (!(publicKey instanceof Uint8Array) || !(secretKey instanceof Uint8Array)) {
    throw new Error('Invalid keyPair: publicKey, and secretKey must be Uint8Array');
  }

  if (publicKey.length !== seedLength) {
    throw new Error(`Public key must be ${seedLength} bytes, got ${publicKey.length}`);
  }

  if (secretKey.length !== (seedLength * 2)) {
    throw new Error(`Secret key must be ${seedLength * 2} bytes, got ${secretKey.length}. If you have a 32-byte seed, you must expand it: secretKey = seed + publicKey`);
  }

  const seed = secretKey.slice(0, seedLength);
  const secretKeySlice = secretKey.slice(seedLength, secretKey.length)
  const derivedPublicKey = ed25519.getPublicKey(seed);

  if (hex(derivedPublicKey) !== hex(publicKey)) {
    throw new Error('Public key does not match the seed part of secretKey. The key pair is inconsistent.');
  }

  if (!ed25519.utils.isValidPublicKey(publicKey)) {
    throw new Error('Public key is not a valid Ed25519 point.');
  }

  if(!ed25519.utils.isValidSecretKey(secretKeySlice)) {
    throw new Error('Secret key is not a valid Ed25519 point.')
  }

  return true;
}

/**
 * Sign a JSON object using Ed25519 secret key.
 * - If secretKey is hex string, convert to Uint8Array
 * - Must be 64 bytes after conversion
 * @param {Object} obj
 * @param {Uint8Array|string} secretKey - 64-byte Uint8Array or 128-character hex string
 * @returns {string} signature hex
 */
export async function signJSON(obj, secretKey) {
  // Convert hex string to Uint8Array if needed
  if (typeof secretKey === 'string') {
    secretKey = hexToUint8(secretKey);
  }

  if (secretKey.length === 64) {
    secretKey = secretKey.subarray(0, 32); // extract seed
  }

  if (secretKey.length !== 32) {
    throw new Error(`Invalid ed25519 secretKey length ${secretKey.length}`);
  }

  const message = utf8ToBytes(canonicalStringify(obj));
  const signature = ed25519.sign(message, secretKey);

  return bytesToHex(signature);
}


/**
 * Verify a signed JSON object using Ed25519.
 * - Converts publicKey hex → Uint8Array if needed
 * - Validates publicKey length
 * @param {Object} obj
 * @param {string} signatureHex
 * @param {Uint8Array|string} publicKey - 32-byte Uint8Array or 64-character hex string
 * @returns {boolean} true if signature is valid
 */
export async function verifySignedJSON(obj, signatureHex, publicKey) {
  // Convert hex to Uint8Array if needed
  if (typeof publicKey === 'string') {
    publicKey = hexToUint8(publicKey);
  }

  const message = utf8ToBytes(canonicalStringify(obj));
  const signature = hexToUint8(signatureHex);

  return ed25519.verify(signature, message, publicKey);
}

/**
 * Encrypt a JSON object with a symmetric key using ChaCha20-Poly1305.
 * @param {string} keyHex - 32-byte key as hex string
 * @param {string} nonceHex - 12-byte nonce as hex string
 * @param {Object} data - JSON object to encrypt
 * @returns {string} ciphertext as hex string
 */
export async function encryptJSON(key, nonce, data) {
  key = hexToUint8(key)
  nonce = hexToUint8(nonce)

  if (nonce.length !== 12) {
    throw new Error(`Invalid nonce length: expected 12 bytes for ChaCha20-Poly1305, got ${nonce.length}`);
  }

  const plaintext = utf8ToBytes(canonicalStringify(data));
  const cipher = chacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  return hex(ciphertext)
}


/**
 * Decrypt a JSON object with a symmetric key using ChaCha20-Poly1305.
 * @param {string} key - 32-byte key as hex string
 * @param {string} nonce - 12-byte nonce as hex string  
 * @param {string} ciphertextHex - Ciphertext as hex string
 * @returns {Object} decrypted JSON
 */
export async function decryptJSON(key, nonce, encrypted) {
  key = hexToUint8(key)
  nonce = hexToUint8(nonce)
  // Validate nonce size for ChaCha20-Poly1305
  if (nonce.length !== 12) {
    throw new Error(`Invalid nonce length: expected 12 bytes for ChaCha20-Poly1305, got ${nonce.length}`);
  }

  const cipher = chacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(hexToUint8(encrypted));

  if (!plaintext) {
    throw new Error('Decryption failed: authentication tag verification failed');
  }

  return JSON.parse(bytesToUtf8(plaintext));
}


/**
* Derive a symmetric key from a password using the scrypt key derivation function.
* By default the key length is 32 to match the required length for ChaCha20-Poly1305.
*
* @param {string|Uint8Array} password - The password to derive the key from.
* @param {Uint8Array} salt - A unique salt for key derivation (must be 16 bytes).
* @param {number} [keyLen=32] - Desired length of the derived key in bytes.
* @returns {Promise<Uint8Array>} - The derived symmetric key.
*
* @example
* const salt = await randomSalt(); // 16 bytes
* const key = await deriveKeyFromPassword('myPassword123', salt, 32);
*/
export async function deriveKeyFromPassword(password, salt, keyLen = 32) {
  if (salt.length !== 16) {
    throw new Error(`Invalid salt length: expected 16 bytes, got ${salt.length}`);
  }

  const passwordBytes = typeof password === 'string'
    ? utf8ToBytes(password)
    : password;

  const cipher = await scryptAsync(passwordBytes, salt, {
    N: 8192,       // CPU/memory cost
    r: 8,          // block size
    p: 1,          // parallelism
    dkLen: keyLen  // output length
  });

  return cipher;
}