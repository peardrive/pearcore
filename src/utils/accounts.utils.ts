import fs from 'fs/promises';
import path from 'path';
import { directoryExists, fileExists, listSubdirs } from './system.utils.js';
import {
  generateMnemonic,
  seedFromMnemonic,
  edKeyPairFromSeed,
  deriveKeyFromPassword,
  encryptJSON,
  decryptJSON,
  randomSalt,
  randomNonce,
  hex,
  hexToUint8,
} from './crypto.utils.js';
import { isString, now } from './general.utils.js';

/** Contents of `{root}/{username}/.account/meta.json`, as written by addAccount. */
export interface StoredAccountMeta {
  username: string;
  /** Hex-encoded Ed25519 public key. */
  publicKey: string;
  /** Absolute path to the user folder ({root}/{username}). */
  userDirectory: string;
  /** Hex nonce used to encrypt credentials.enc.json. */
  nonce: string;
  /** Hex salt for the password key derivation. */
  salt: string;
  createdAt: number;
}

/** Account metadata as read back from disk: only username and publicKey are guaranteed. */
export type AccountMeta = Pick<StoredAccountMeta, 'username' | 'publicKey'> &
  Partial<StoredAccountMeta>;

/** The decrypted contents of credentials.enc.json. */
export interface AccountCredentials {
  username: string;
  publicKey: string;
  /** Hex-encoded 64-byte Ed25519 secret key. */
  secretKey: string;
}

/** What createAccount / createAccountFromMnemonic return. */
export interface CreatedAccount {
  username: string;
  /** BIP39 mnemonic for the account. */
  mnemonic: string;
  publicKey: string;
  /** Absolute path to the user folder ({root}/{username}). */
  path: string;
}

/**
 * Return the user's root directory: {root}/{username}
 */
export function accountBaseDir(username: string, root: string): string {
  if (!username || typeof username !== 'string') {
    throw new Error('username must be a non-empty string');
  }

  return path.join(root, username);
}

/**
 * Path to the .account sub-folder for local user.
 * @param username - Account username.
 * @param root - Root directory.
 */
export function accountDotDir(username: string, root: string): string {
  return path.join(accountBaseDir(username, root), '.account');
}

/**
 * Path to the account's drive directory.
 * @param username - Account username.
 * @param root - Root directory
 */
export function accountDriveDir(username: string, root: string): string {
  return path.join(accountBaseDir(username, root), 'drive');
}

/**
 * Read and validate the metadata for a single user account.
 *
 * This function attempts to read the `meta.json` file located under the
 * `.account` folder inside the user's root directory. It ensures that the
 * metadata contains the required fields `username` and `publicKey`.
 *
 * Folder expectations:
 * ```
 * {userRoot}/
 *   └── .account/
 *       └── meta.json       ← must exist and contain valid metadata
 * ```
 *
 * Notes:
 * - If the metadata file does not exist, is invalid JSON, or lacks
 *   required fields, the function returns `null`.
 * - This function does **not** throw errors for missing or malformed files;
 *   it safely returns `null` instead.
 *
 * @param userRoot - Absolute path to the user's root folder.
 *
 * @returns - Parsed metadata if valid, otherwise null
 */
export async function readAccountMeta(
  userRoot: string,
): Promise<AccountMeta | null> {
  try {
    const metaPath = path.join(userRoot, '.account', 'meta.json');
    const data = await fs.readFile(metaPath, 'utf-8');
    const meta = JSON.parse(data);

    if (!meta.username || !meta.publicKey) {
      throw new Error('Invalid meta');
    }

    return meta;
  } catch {
    return null;
  }
}

/**
 * Ensure the account exists and return metadata.
 * Throws if account missing or meta invalid.
 * @param username - Account's username
 * @param root - Root path for core's account directory
 */
export async function ensureAccountExists(username: string, root: string ): Promise<AccountMeta> {
  if (!username || typeof username !== 'string') {
    throw new Error('username required');
  }

  const userRoot = path.join(root, username);
  const meta = await readAccountMeta(userRoot);

  if (!meta) {
    throw new Error(`Account "${username}" not found or meta.json invalid`);
  }

  return meta;
}

/**
 * List all local user accounts with their metadata.
 *
 * This function scans the given root directory for subfolders, reads the
 * account metadata (`meta.json`) for each user, and returns an array of
 * valid accounts along with their absolute paths.
 *
 * Folder expectations:
 * ```
 * {root}/{username}/
 *   ├── .account/
 *   │   └── meta.json       ← must exist and contain valid metadata
 *   └── drive/              ← optional, user's drive/watch folder
 * ```
 *
 * Notes:
 * - Only directories with a valid `meta.json` file containing a `username`
 *   and `publicKey` are included.
 * - Invalid or incomplete accounts (missing `meta.json` or required fields)
 *   are ignored.
 * - The `username` is inferred from the folder name, but the returned metadata
 *   comes from `meta.json`.
 *
 * @param [root] - The base directory containing user folders.
 *
 * @returns - Array of accounts with metadata
 *
 * @throws {Error} If:
 *   - root cannot be accessed or created
 *   - filesystem operations fail
 */
export async function listAccountsWithMeta(
  root: string 
): Promise<Array<AccountMeta & { path: string }>> {
  // throw error if the root directory does not exist
  await directoryExists(root);

  const dirs = await listSubdirs(root);
  const results: Array<AccountMeta & { path: string }> = [];

  for (const username of dirs) {
    const userRoot = path.join(root, username);
    const meta = await readAccountMeta(userRoot);

    if (meta) {
      results.push({
        ...meta,
        path: userRoot,
      });
    }
  }

  return results;
}

/**
 * Setup account with predefined credentials.
 * @param username - Local username.
 * @param password - Auth password.
 * @param publicKey - Public key (64-char hex).
 * @param secretKey - Secret key (128-char hex).
 * @param root - Base directory.
 */
export async function addAccount(
  username: string,
  password: string,
  publicKey: string,
  secretKey: string,
  root: string,
): Promise<StoredAccountMeta> {
  const processedUsername = username.trim();

  if (!isString(username) || processedUsername === '') {
    throw new Error('Username required');
  }

  if (!isString(password) || password.toLowerCase().trim() === '') {
    throw new Error('Password required');
  }

  await directoryExists(root);

  const dirs = await listSubdirs(root);
  if (dirs.includes(processedUsername))
    throw new Error('Account already exists');

  // user root folder
  const userRoot = path.join(root, processedUsername);
  const accountDir = path.join(userRoot, '.account');
  const driveDir = path.join(userRoot, 'drive');

  await directoryExists(accountDir);
  await directoryExists(driveDir);

  const salt = await randomSalt();
  const key = await deriveKeyFromPassword(password, salt);
  const credentials: AccountCredentials = {
    username: processedUsername,
    publicKey: publicKey,
    secretKey: secretKey,
  };

  const nonce = randomNonce();
  const encrypted = await encryptJSON(hex(key), hex(nonce), credentials);

  await fs.writeFile(
    path.join(accountDir, 'credentials.enc.json'),
    JSON.stringify(encrypted, null, 2),
  );

  const meta: StoredAccountMeta = {
    username: processedUsername,
    userDirectory: userRoot,
    publicKey: publicKey,
    nonce: hex(nonce),
    salt: hex(salt),
    createdAt: now(),
  };

  await fs.writeFile(
    path.join(accountDir, 'meta.json'),
    JSON.stringify(meta, null, 2),
  );

  return meta;
}

/**
 * Create a new local user account with password-protected credentials.
 *
 * This function generates a new mnemonic, derives a seed and Ed25519 key pair,
 * encrypts the credentials using the provided password, and stores the account
 * metadata and encrypted credentials on the local filesystem.
 *
 * The folder structure created is:
 * ```
 * {root}/{username}/
 *   ├── .account/               // stores account credentials and metadata
 *   │   ├── credentials.enc.json  // encrypted {username, publicKey, secretKey}
 *   │   └── meta.json             // account metadata (username, publicKey, createdAt)
 *   └── drive/                  // user's local drive/watch folder
 * ```
 *
 * Notes:
 * - The `username` is trimmed (case is preserved).
 * - If the username already exists, an error is thrown.
 * - The password is used to derive an encryption key via scrypt.
 * - Credentials are encrypted with ChaCha20-Poly1305 using the derived key.
 * - A random salt is generated for the password key derivation and stored
 *   (hex-encoded) in meta.json.
 * - Public and private keys are Ed25519 keys derived deterministically from
 *   the generated mnemonic.
 *
 * @param username - Local account name (required, non-empty, unique).
 * @param password - Password used for encrypting credentials (required).
 * @param [root] - Base directory where user folders are stored.
 *
 */
export async function createAccount(
  username: string,
  password: string,
  root: string,
): Promise<CreatedAccount> {
  const mnemonic = generateMnemonic();
  const seed = seedFromMnemonic(mnemonic);
  const { publicKey, secretKey } = await edKeyPairFromSeed(seed);

  const info = await addAccount(
    username,
    password,
    hex(publicKey),
    hex(secretKey),
    root,
  );

  return {
    mnemonic,
    username: info.username,
    path: info.userDirectory,
    publicKey: hex(publicKey),
  };
}

/**
 * Create a new local user account from existing BIP39 mnemonic.
 * @param username - account's username
 * @param password - account's password
 * @param mnemonic - 12 or 24-word BIP39 mnemonic phrases
 * @param root - Base directory for account
 *
 */
export async function createAccountFromMnemonic(
  username: string,
  password: string,
  mnemonic: string,
  root: string,
): Promise<CreatedAccount> {
  if (!username || typeof username !== 'string' || username.trim() === '') {
    throw new Error('Username required');
  }

  if (!password || typeof password !== 'string' || password.trim() === '') {
    throw new Error('Password required');
  }

  if (!mnemonic || typeof mnemonic !== 'string' || mnemonic.trim() === '') {
    throw new Error('Mnemonic required');
  }

  const seed = seedFromMnemonic(mnemonic);
  const { publicKey, secretKey } = await edKeyPairFromSeed(seed);

  const info = await addAccount(
    username,
    password,
    hex(publicKey),
    hex(secretKey),
    root,
  );

  return {
    mnemonic,
    username: info.username,
    path: info.userDirectory,
    publicKey: hex(publicKey),
  };
}

/**
 * Delete a local user account.
 * The username is trimmed like on creation; it used to be lowercased too, which
 * missed mixed-case accounts on case-sensitive filesystems (Linux).
 * @param username - Account username
 * @param root - Root directory for accounts
 * @returns - Resolves when account directory gets fully deleted.
 */
export async function deleteAccount(
  username: string,
  root: string,
): Promise<void> {
  username = username.trim();
  if (!username) {
    throw new Error('Username required');
  }

  const userRoot = path.join(root, username);

  const exists = await fileExists(userRoot);
  if (!exists) throw new Error(`Account '${username}' does not exist`);

  await fs.rm(userRoot, { recursive: true, force: true });
}

/**
 * Authenticate a user by decrypting their stored credentials.
 *
 * Reads the account's encrypted credentials file and metadata,
 * derives the encryption key from the provided password and stored salt,
 * and attempts to decrypt the credentials.
 *
 * @param username - Account username (case-insensitive, trimmed)
 * @param password - Password used during account creation
 * @param root - Base directory containing user accounts
 *
 * @returns
 *          Decrypted account credentials
 *
 * @throws {Error} If account doesn't exist, metadata is invalid, password is wrong,
 *                 or credentials are corrupted
 *
 * @example
 * const creds = await authenticateAccount('alice', 'secret123', '/accounts');
 * // creds = { username: 'alice', publicKey: 'abc123...', secretKey: 'def456...' }
 */
export async function authenticateAccount(
  username: string,
  password: string,
  root: string,
): Promise<AccountCredentials> {
  username = username.trim();

  if (!username) {
    throw new Error('Username required.');
  }

  if (!password) {
    throw new Error('Password required.');
  }

  const userAccountRoot = path.join(root, username);
  const accountDirectory = path.join(userAccountRoot, '.account');
  const metaFilePath = path.join(accountDirectory, 'meta.json');

  let metaFileExists = await fileExists(metaFilePath);
  if (!metaFileExists) {
    throw new Error('Account meta.json file not found.');
  }

  const meta = JSON.parse(await fs.readFile(metaFilePath, 'utf-8'));
  if (!meta.username || !meta.publicKey || !meta.nonce || !meta.salt) {
    throw new Error('Account metadata is invalid');
  }

  const credentialsPath = path.join(accountDirectory, 'credentials.enc.json');

  let credentialFileExists = await fileExists(credentialsPath);
  if (!credentialFileExists) {
    throw new Error('Account credentials is invalid');
  }

  const encryptedCredentials: string = JSON.parse(
    await fs.readFile(credentialsPath, 'utf-8'),
  );

  const salt = hexToUint8(meta.salt);
  const key = await deriveKeyFromPassword(password, salt);

  try {
    const decrypted = await decryptJSON<AccountCredentials>(
      hex(key),
      meta.nonce,
      encryptedCredentials,
    );

    // Verify decrypted data matches metadata
    if (decrypted.username !== username) {
      console.log({ internal: decrypted.username, username });
      throw new Error('Username mismatch in credentials');
    }

    if (decrypted.publicKey !== meta.publicKey) {
      throw new Error('Publickey mismatch');
    }

    return {
      username: decrypted.username,
      publicKey: decrypted.publicKey,
      secretKey: decrypted.secretKey,
    };
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('invalid tag')) {
      throw new Error('Invalid password');
    }
    throw new Error(`Authentication failed: ${message}`);
  }
}
