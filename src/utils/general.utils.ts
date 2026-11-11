import path from 'path';

// General validation helper functions

export function isNull(obj: unknown): obj is null {
  return obj === null;
}

export function isString(item: unknown): item is string {
  return typeof item === 'string';
}

/**
 * True for safe integers only.
 * Note: despite the name, non-integer numbers are rejected.
 */
export function isNumber(item: unknown): item is number {
  return Number.isSafeInteger(item);
}

export function isBoolean(obj: unknown): obj is boolean {
  return typeof obj === 'boolean';
}

export function isFunction(
  item: unknown,
): item is (...args: any[]) => unknown {
  return typeof item === 'function';
}

export function isObject(item: unknown): item is object {
  return !isNull(item) && typeof item === 'object';
}

export type Binary = 0 | 1;

export function isBinary(obj: unknown): obj is Binary{
  if (typeof obj !== 'number') return false;
  return obj === 0 || obj === 1;
}

export function isBooleanOrBinary(
  obj: unknown,
): obj is boolean | Binary{
  if (isBoolean(obj)) return true;
  return isBinary(obj);
}

export function notNull<T>(obj: T): obj is Exclude<T, null> {
  return obj !== null;
}

export function notUndefined<T>(obj: T): obj is Exclude<T, undefined> {
  return obj !== undefined;
}

export function isDefined<T>(obj: T): obj is NonNullable<T> {
  const isNotNull = notNull(obj);
  const isNotUndefined = notUndefined(obj);
  return isNotNull && isNotUndefined;
}

export function hasExactLength(
  item: { length: number },
  length: number,
): boolean {
  return item.length === length;
}

/** A valid topic is a 64-character hex string. */
export function isValidTopic(item: unknown): item is string {
  if (!isString(item)) {
    return false;
  }

  if (!hasExactLength(item, 64)) {
    return false;
  }

  return validateHexString(item);
}

export function isNullOrHex(obj: unknown): obj is string | null {
  if (isNull(obj)) return true;
  
  return isString(obj) && validateHexString(obj);
}
/**
 * Validates nonce to be 24 character hex string.
 */
export const nonceIsValid = (nonce: unknown): nonce is string =>
  isString(nonce) && validateHexString(nonce) && nonce.length === 24;

/**
 * Validates space topic hash.
 */
export const topicIsValid = (topic: unknown): topic is string =>
  isString(topic) && validateHexString(topic) && topic.length === 64;

/**
 * Validates space secret key to be 64 character hex string.
 */
export const spaceSecretIsValid = (secret: unknown): secret is string =>
  isString(secret) && validateHexString(secret) && secret.length == 64;

/**
 * Validates if a string contains only hexadecimal characters (0-9, a-f, A-F)
 * @param str - The string to validate
 * @returns True if string contains only hex characters, false otherwise
 */
export function validateHexString(str: string): boolean {
  return /^[0-9a-fA-F]+$/.test(str);
}

/**
 * Validate a virtual file path.
 * - Allows optional leading slash (will be stripped for internal checks)
 * - Rejects control characters, backslashes, empty segments, and '.' / '..'
 * - Limits length to prevent abuse
 * - Accepts any printable UTF‑8 characters (extendable)
 *
 * @param filepath - The path to validate
 * @param maxLength - Maximum allowed length (default 2048)
 * @returns - True if valid
 */
export function validateFilePath(
  filepath: string,
  maxLength: number = 2048,
): boolean {
  if (typeof filepath !== 'string') return false;

  const trimmed = filepath.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return false;

  if (/[\x00-\x1f\x7f\\]/.test(trimmed)) return false;

  const normalized = path.posix.normalize(trimmed);

  const withoutLeading = normalized.startsWith('/')
    ? normalized.slice(1)
    : normalized;
  const clean = withoutLeading.endsWith('/')
    ? withoutLeading.slice(0, -1)
    : withoutLeading;

  if (clean.length === 0) return false;

  const segments = clean.split('/');

  for (const seg of segments) {
    if (seg.length === 0) return false;
    if (seg === '.' || seg === '..') return false;
  }

  return true;
}

/**
 * Returns the current timestamp for message broadcasting.
 *
 * This value represents the current time in milliseconds since the Unix epoch
 * and is intended for use as `broadcastTimestamp` in message records.
 *
 * @returns Current time in milliseconds since epoch
 */
export function now(): number {
  return Date.now();
}

/**
 * Validates a timestamp to ensure it's a vlida, finite number.
 * @param timestamp - timestamp to validate in miliseconds
 * @returns True if the timestamp is valid, false otherwise.
 */
export function validateTimestamp(timestamp: number): boolean {
  return (
    isNumber(timestamp) &&
    !isNaN(timestamp) &&
    isFinite(timestamp) &&
    timestamp >= 0
  );
}

/**
 * Compare timestamps to determine if candidate is newer.
 *
 * Timestamps expected as integers (seconds since epoch).
 *
 * @returns true if candidateTs is strictly greater than existingTs
 */
export function isTimestampNewer(
  candidateTs: number,
  existingTs: number | null | undefined,
): boolean {
  return Number(candidateTs) > Number(existingTs);
}

/**
 * Compare timestamps to determine if candidate is equal.
 *
 * Timestamps expected as integers (seconds since epoch).
 *
 * @returns true if candidateTs is strictly greater than existingTs
 */
export function isTimestampEqual(
  candidateTs: number,
  existingTs: number | null | undefined,
): boolean {
  if (existingTs === null || existingTs === undefined)
    throw new Error('invalid timestamp');
  return Number(candidateTs) === Number(existingTs);
}

/**
 * Shortens a string by keeping a few characters at the start and end,
 * replacing the middle with dots.
 *
 * @param str - The original string
 * @param startLen - Number of characters to keep at the start
 * @param endLen - Number of characters to keep at the end
 * @param [dots='..'] - The string to put in the middle
 * @returns Shortened string
 */
export function shortenHash(
  str: string,
  startLen: number,
  endLen: number,
  dots: string = '..',
): string {
  if (typeof str !== 'string') return '';
  if (startLen + endLen >= str.length) return str; // no need to shorten
  const start = str.slice(0, startLen);
  const end = str.slice(-endLen);
  return `${start}${dots}${end}`;
}

export const shortenHashBy4 = (str: string): string => shortenHash(str, 4, 4);

/**
 * Removes the `id` property from an object (e.g. a database row), if it exists.
 *
 * This function does not mutate the original objects; instead, it returns
 * shallow copies with the `id` field omitted. Objects without an `id` field
 * are returned unchanged.
 *
 * @param object - A query result object.
 * @returns A shallow copy without `id`.
 */
export function stripIds<T extends object>(object: T = {} as T): Omit<T, 'id'> {
  const { id, ...rest } = object as T & { id?: unknown };
  return rest;
}

/**
 * Calculates the size of an incoming message buffer in bytes
 * @param raw - The raw message data to calculate size for
 * @returns The size of the message in bytes, or 0 if invalid input
 * @example
 * const size = calculateMessageSize(new Uint8Array([1,2,3,4])); // returns 4
 * const size = calculateMessageSize("hello"); // returns 5 (bytes)
 * const size = calculateMessageSize(null); // returns 0
 */
export function calculateMessageSize(raw: unknown): number {
  if (!raw) return 0;

  // Handle different buffer types
  if (typeof raw === 'string') {
    // For string data, get byte length
    return new TextEncoder().encode(raw).length;
  }

  if (ArrayBuffer.isView(raw)) {
    // For typed arrays like Uint8Array, Buffer, etc.
    return (raw as Uint8Array).length;
  }

  if (raw instanceof ArrayBuffer) {
    // For plain ArrayBuffer
    return raw.byteLength;
  }

  // Fallback - try to get length property
  const { length } = raw as { length?: number };
  if (length !== undefined) {
    return length;
  }

  return 0;
}

/**
 * Checks is the address is a valid URL.
 */
export function isValidURL(address: string | URL): boolean {
  try {
    const url = new URL(address);
    return true;
  } catch (error) {
    return false;
  }
}

export type BootstrapValidation =
  | { valid: true; reason: string }
  | { valid: true; ip: string; port: string }
  | { valid: false; reason: string };

/**
 * Validates a bootstrap node address in `IPv4:port` form.
 * An empty value is valid (no bootstrap node configured).
 */
export function validateBootstrapString(
  str: string | null | undefined,
): BootstrapValidation {
  // Handle undefined/null cases
  if (!str || str === 'undefined') {
    return { valid: true, reason: 'No bootstrap node specified' };
  }

  // Regex pattern for IPv4:Port format
  const regex = /^(\d{1,3}\.){3}\d{1,3}:\d+$/;

  // Check if string matches the pattern
  if (!regex.test(str)) {
    return {
      valid: false,
      reason: 'Invalid format. Expected IPv4:Port (e.g., 192.168.100.23:8000)',
    };
  }

  // Split and validate IP address ranges
  const [ip, port] = str.split(':');
  const ipParts = ip.split('.').map(Number);
  const portNum = parseInt(port);

  // Validate IP octets (0-255 range)
  for (const part of ipParts) {
    if (part < 0 || part > 255) {
      return {
        valid: false,
        reason: 'Invalid IP address. Each octet must be between 0 and 255',
      };
    }
  }

  // Validate port range (1-65535)
  if (portNum < 1 || portNum > 65535) {
    return {
      valid: false,
      reason: 'Invalid port number. Must be between 1 and 65535',
    };
  }

  return { valid: true, ip, port };
}
