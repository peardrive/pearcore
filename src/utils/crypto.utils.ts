import * as b4a from 'b4a';
import bip39 from 'bip39';
import canonicalize from 'canonicalize';
import { scryptAsync } from '@noble/hashes/scrypt.js';
import { blake3 } from '@noble/hashes/blake3.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';
import {
  randomBytes,
  utf8ToBytes,
  hexToBytes,
  bytesToHex,
} from '@noble/hashes/utils.js';

/** An Ed25519 key pair in Hyperswarm layout: `secretKey` is `seed (32) || publicKey (32)`. */
export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * Create 8 bytes big-indiand Uint8 array from 64-bit number.
 */
export function u64(value: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value), false);
  return out;
}

/**
 * Concatenate multiple buffers into single Uint8Array.
 */
export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  let total = 0;

  for (const arr of arrays) {
    if (!(arr instanceof Uint8Array)) {
      throw new Error(`ConcatBytes received unexpected input: ${arr}`);
    }

    total += arr.length;
  }

  const buffer = new Uint8Array(total);

  let offset = 0;
  for (const arr of arrays) {
    buffer.set(arr, offset);
    offset += arr.length;
  }

  return buffer;
}

/**
 * Decode UTF-8 bytes into a string.
 */
export function bytesToUtf8(bytes: Uint8Array): string {
  return b4a.toString(bytes, 'utf8');
}

/**
 * Convert hex string to Uint8Array
 */
export function hexToUint8(hexStr: string): Uint8Array {
  return hexToBytes(hexStr);
}

/**
 * Convert hex string to Buffer
 */
export function hexToBuffer(hexStr: string): Buffer {
  return Buffer.from(hexStr, 'hex');
}

/**
 * Convert a Uint8Array to hex string.
 */
export function hex(bytes: Uint8Array): string {
  return bytesToHex(bytes);
}

/**
 * Convert Buffer into String
 */
export const toUTF8 = (buffer: Uint8Array): string =>
  b4a.toString(buffer, 'utf8');

/**
 * Base64 encode a Uint8Array.
 */
export const toBase64 = (u8: Uint8Array): string => b4a.toString(u8, 'base64');

/**
 * Base64 decode to Uint8Array.
 */
export const fromBase64 = (s: string): Uint8Array =>
  new Uint8Array(Buffer.from(s, 'base64'));

/**
 * Deterministically stringify a JSON-compatible value with stable key ordering.
 * Ensures identical byte output for logically equivalent objects (used for hashing/signing).
 * @param object - JSON-serializable value
 * @returns Canonical JSON string
 */
export function canonicalStringify(object: unknown): string {
  const canonical = canonicalize(object);

  if (canonical === undefined) {
    throw new TypeError(
      'canonicalStringify received a value that cannot be serialized to JSON',
    );
  }

  return canonical;
}

/**
 * Compute BLAKE-3 hash of a string or Uint8Array using @noble/hashes.
 */
export function hash(input: string | Uint8Array): Uint8Array {
  const buf = typeof input === 'string' ? utf8ToBytes(input) : input;

  return blake3(buf);
}

/**
 * Generate a cryptographically secure random secret key (hex encoded)
 *
 * @param bytes - Number of random bytes to generate
 * @returns Hex-encoded random key
 * @throws {TypeError} If bytes is not a positive integer
 */
export function generateRandomSecretKey(bytes: number = 32): string {
  if (!Number.isInteger(bytes) || bytes <= 0) {
    throw new TypeError('bytes must be a positive integer');
  }

  const buffer = randomBytes(bytes);
  return bytesToHex(buffer);
}

/**
 * Random secret generator
 */
export function randomSecret(): Uint8Array {
  return randomBytes(12);
}

/**
 * Random nonce generator
 */
export function randomNonce(): Uint8Array {
  return randomBytes(12);
}

/**
 * Generate a random salt for password key derivation.
 */
export async function randomSalt(): Promise<Uint8Array> {
  return randomBytes(16);
}

/**
 * Generate a new 12-word mnemonic.
 */
export function generateMnemonic(): string {
  return bip39.generateMnemonic(128); // 128 bits entropy → 12 words
}

/**
 * Derive a 32-byte seed from a BIP39 mnemonic.
 */
export function seedFromMnemonic(mnemonic: string): Uint8Array {
  if (!bip39.validateMnemonic(mnemonic)) {
    throw new Error('Invalid mnemonic');
  }

  const seed = bip39.mnemonicToSeedSync(mnemonic);
  return seed.subarray(0, 32);
}

/**
 * Generate an Ed25519 keypair from a 32-byte seed.
 */
export async function edKeyPairFromSeed(seed32: Uint8Array): Promise<KeyPair> {
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
 * @param keyPair - { publicKey: Uint8Array, secretKey: Uint8Array }
 * @returns - true if valid, throws descriptive error otherwise
 */
export function validateKeypair({
  publicKey,
  secretKey,
  seedLength = 32,
}: KeyPair & { seedLength?: number }): boolean {
  if (!publicKey || !secretKey) {
    throw new Error('publicKey and secretKey are required');
  }

  if (
    !(publicKey instanceof Uint8Array) ||
    !(secretKey instanceof Uint8Array)
  ) {
    throw new Error(
      'Invalid keyPair: publicKey, and secretKey must be Uint8Array',
    );
  }

  if (publicKey.length !== seedLength) {
    throw new Error(
      `Public key must be ${seedLength} bytes, got ${publicKey.length}`,
    );
  }

  if (secretKey.length !== seedLength * 2) {
    throw new Error(
      `Secret key must be ${seedLength * 2} bytes, got ${secretKey.length}. If you have a 32-byte seed, you must expand it: secretKey = seed + publicKey`,
    );
  }

  // secretKey layout (Hyperswarm / libsodium): seed (32) || publicKey (32)
  const seed = secretKey.subarray(0, seedLength);
  const embeddedPublicKey = secretKey.subarray(seedLength);

  // 1. The secret part (seed) must be a valid Ed25519 secret key.
  if (!ed25519.utils.isValidSecretKey(seed)) {
    throw new Error('Secret key seed is not a valid Ed25519 secret key.');
  }

  // 2. The seed must actually produce publicKey.
  const derivedPublicKey = ed25519.getPublicKey(seed);
  if (hex(derivedPublicKey) !== hex(publicKey)) {
    throw new Error(
      'Public key does not match the seed part of secretKey. The key pair is inconsistent.',
    );
  }

  // 3. The public key copy embedded in secretKey must match too. libsodium
  //    (used by Hyperswarm) reads it when signing, so a mismatch produces
  //    invalid signatures even though the seed is correct.
  if (hex(embeddedPublicKey) !== hex(publicKey)) {
    throw new Error(
      'The second half of secretKey does not match publicKey (expected layout: seed || publicKey).',
    );
  }

  if (!ed25519.utils.isValidPublicKey(publicKey)) {
    throw new Error('Public key is not a valid Ed25519 point.');
  }

  return true;
}

/**
 * Sign a JSON object using Ed25519 secret key.
 * - If secretKey is hex string, convert to Uint8Array
 * - Must be 64 bytes after conversion
 * @param secretKey - 64-byte Uint8Array or 128-character hex string
 * @returns signature hex
 */
export async function signJSON(
  obj: unknown,
  secretKey: Uint8Array | string,
): Promise<string> {
  return signString(canonicalStringify(obj), secretKey);
}

/**
 * Sign an already serialized string (e.g. canonical JSON) using Ed25519 secret key.
 * Signing the exact bytes avoids serializing the same object twice.
 * @param secretKey - 64-byte Uint8Array or 128-character hex string
 * @returns signature hex
 */
export async function signString(
  str: string,
  secretKey: Uint8Array | string,
): Promise<string> {
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

  const signature = ed25519.sign(utf8ToBytes(str), secretKey);
  return bytesToHex(signature);
}

/**
 * Verify a signed JSON object using Ed25519.
 * - Converts publicKey hex → Uint8Array if needed
 * - Validates publicKey length
 * @param publicKey - 32-byte Uint8Array or 64-character hex string
 * @returns true if signature is valid
 */
export async function verifySignedJSON(
  obj: unknown,
  signatureHex: string,
  publicKey: Uint8Array | string,
): Promise<boolean> {
  return verifySignedString(canonicalStringify(obj), signatureHex, publicKey);
}

/**
 * Verify an Ed25519 signature over an already serialized string (e.g. canonical JSON).
 * @param publicKey - 32-byte Uint8Array or 64-character hex string
 * @returns true if signature is valid
 */
export async function verifySignedString(
  str: string,
  signatureHex: string,
  publicKey: Uint8Array | string,
): Promise<boolean> {
  // Convert hex to Uint8Array if needed
  if (typeof publicKey === 'string') {
    publicKey = hexToUint8(publicKey);
  }

  const signature = hexToUint8(signatureHex);
  return ed25519.verify(signature, utf8ToBytes(str), publicKey);
}

/**
 * Encrypt a JSON object with a symmetric key using ChaCha20-Poly1305.
 * @param keyHex - 32-byte key as hex string
 * @param nonceHex - 12-byte nonce as hex string
 * @param data - JSON object to encrypt
 * @returns ciphertext as hex string
 */
export async function encryptJSON(
  keyHex: string,
  nonceHex: string,
  data: unknown,
): Promise<string> {
  const key = hexToUint8(keyHex);
  const nonce = hexToUint8(nonceHex);

  if (nonce.length !== 12) {
    throw new Error(
      `Invalid nonce length: expected 12 bytes for ChaCha20-Poly1305, got ${nonce.length}`,
    );
  }

  const plaintext = utf8ToBytes(canonicalStringify(data));
  const cipher = chacha20poly1305(key, nonce);
  const ciphertext = cipher.encrypt(plaintext);

  return hex(ciphertext);
}

/**
 * Decrypt a JSON object with a symmetric key using ChaCha20-Poly1305.
 * @param keyHex - 32-byte key as hex string
 * @param nonceHex - 12-byte nonce as hex string
 * @param ciphertextHex - Ciphertext as hex string
 * @returns decrypted JSON
 */
export async function decryptJSON<T = unknown>(
  keyHex: string,
  nonceHex: string,
  ciphertextHex: string,
): Promise<T> {
  const key = hexToUint8(keyHex);
  const nonce = hexToUint8(nonceHex);
  // Validate nonce size for ChaCha20-Poly1305
  if (nonce.length !== 12) {
    throw new Error(
      `Invalid nonce length: expected 12 bytes for ChaCha20-Poly1305, got ${nonce.length}`,
    );
  }

  const cipher = chacha20poly1305(key, nonce);
  const plaintext = cipher.decrypt(hexToUint8(ciphertextHex));

  if (!plaintext) {
    throw new Error(
      'Decryption failed: authentication tag verification failed',
    );
  }

  return JSON.parse(bytesToUtf8(plaintext)) as T;
}

/**
 * Derive a symmetric key from a password using the scrypt key derivation function.
 * By default the key length is 32 to match the required length for ChaCha20-Poly1305.
 *
 * @param password - The password to derive the key from.
 * @param salt - A unique salt for key derivation (must be 16 bytes).
 * @param [keyLen=32] - Desired length of the derived key in bytes.
 * @returns - The derived symmetric key.
 *
 * @example
 * const salt = await randomSalt(); // 16 bytes
 * const key = await deriveKeyFromPassword('myPassword123', salt, 32);
 */
export async function deriveKeyFromPassword(
  password: string | Uint8Array,
  salt: Uint8Array,
  keyLen: number = 32,
): Promise<Uint8Array> {
  if (salt.length !== 16) {
    throw new Error(
      `Invalid salt length: expected 16 bytes, got ${salt.length}`,
    );
  }

  const passwordBytes =
    typeof password === 'string' ? utf8ToBytes(password) : password;

  const cipher = await scryptAsync(passwordBytes, salt, {
    N: 8192, // CPU/memory cost
    r: 8, // block size
    p: 1, // parallelism
    dkLen: keyLen, // output length
  });

  return cipher;
}
