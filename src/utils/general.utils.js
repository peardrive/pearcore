// General validation helper functions
export const notNull = (obj) => obj !== null;
export const notUndefined = (obj) => obj !== undefined;
export const isDefined = (obj) => notNull(obj) && notUndefined(obj);
export const isBoolean = (obj) => typeof obj === 'boolean';
export const isBinary = (obj) => typeof obj === 'number' && [0, 1].includes(obj);
export const isBooleanOrBinary = (obj) => isBoolean(obj) || isBinary(obj);

export const isNull = obj => obj === null;
export const isNullOrHex = obj => isNull(obj) || (isString(obj) && validateHexString(obj));
export const isString = item => typeof item === 'string';
export const isNumber = item => typeof item === 'number';
export const isObject = item => typeof item === 'object';
export const isFunction = item => typeof item === 'function';
export const hasExactLength = (item, length) => item.length === length;
export const isValidTopic = item => {
    return isString(item) && containsCharacters(item, 64) && validateHexString(item)
};

/**
 * Validates nonce to be 24 character hex string.
 * @param {string} nonce 
 * @returns {Boolean}
 */
export const nonceIsValid = nonce =>
    isString(nonce) &&
    validateHexString(nonce) &&
    nonce.length === 24;

/**
 * Validates space topic hash.
 * @param {string} topic 
 * @returns 
 */
export const topicIsValid = topic =>
    isString(topic) &&
    validateHexString(topic) &&
    topic.length === 64;

/**
 * Validates space secret key to be 64 character hex string.
 * @param {string} secret 
 * @returns 
 */
export const spaceSecretIsValid = secret =>
    isString(secret) &&
    validateHexString(secret) &&
    secret.length == 64;

/**
 * Validates if a string contains only hexadecimal characters (0-9, a-f, A-F)
 * @param {string} str - The string to validate
 * @returns {boolean} True if string contains only hex characters, false otherwise
 */
export function validateHexString(str) {
    return /^[0-9a-fA-F]+$/.test(str);
}

/**
 * Validates space file path string.
 * @param {string} filepath - space file path
 * @returns {Boolean}
 */
export function validateFilePath(filepath) {
    if (typeof filepath !== 'string') return false;
    // Allow: /filename.ext or /dir/subdir/file.ext
    // Disallow empty, relative, or special chars
    return /^\/[a-zA-Z0-9_.-]+(\/[a-zA-Z0-9_.-]+)*$/.test(filepath);
}

/**
 * Returns the current timestamp for message broadcasting.
 *
 * This value represents the current time in milliseconds since the Unix epoch
 * and is intended for use as `broadcastTimestamp` in message records.
 *
 * @returns {number} Current time in milliseconds since epoch
 */
export function now() {
    return Date.now()
}

/**
 * Validates a timestamp to ensure it's a vlida, finite number.
 * @param {number} timestamp - timestamp to validate in miliseconds
 * @returns {boolean} True if the timestamp is valid, false otherwise.
 */
export function validateTimestamp(timestamp) {
    return (
        typeof timestamp === 'number' &&
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
 * @param {number} candidateTs
 * @param {number|null|undefined} existingTs
 * @returns {boolean} true if candidateTs is strictly greater than existingTs
 */
export function isTimestampNewer(candidateTs, existingTs) {
    return Number(candidateTs) > Number(existingTs);
}

/**
 * Compare timestamps to determine if candidate is equal.
 *
 * Timestamps expected as integers (seconds since epoch).
 *
 * @param {number} candidateTs
 * @param {number|null|undefined} existingTs
 * @returns {boolean} true if candidateTs is strictly greater than existingTs
 */
export function isTimestampEqual(candidateTs, existingTs) {
    if (existingTs === null || existingTs === undefined) throw new Error('invalid timestamp');
    return Number(candidateTs) === Number(existingTs);
}

/**
 * Shortens a string by keeping a few characters at the start and end,
 * replacing the middle with dots.
 *
 * @param {string} str - The original string
 * @param {number} startLen - Number of characters to keep at the start
 * @param {number} endLen - Number of characters to keep at the end
 * @param {string} [dots='..'] - The string to put in the middle
 * @returns {string} Shortened string
 */
export function shortenHash(str, startLen, endLen, dots = '..') {
    if (typeof str !== 'string') return ''
    if (startLen + endLen >= str.length) return str // no need to shorten
    const start = str.slice(0, startLen)
    const end = str.slice(-endLen)
    return `${start}${dots}${end}`
}

export const shortenHashBy4 = (str) => shortenHash(str, 4, 4)

/**
 * Removes the `id` property from each object in a query result set, if it exists.
 *
 * This function does not mutate the original objects; instead, it returns
 * shallow copies with the `id` field omitted. Objects without an `id` field
 * are returned unchanged.
 *
 * @param {Array<object>} rows - Array of query result objects.
 * @returns {Array<object>} New array with `id` removed from each object.
 */
export function stripIds(object = {}) {
    const { id, ...rest } = object
    return rest
}

/**
 * Calculates the size of an incoming message buffer in bytes
 * @param {Buffer|Uint8Array|ArrayBuffer|string|any} raw - The raw message data to calculate size for
 * @returns {number} The size of the message in bytes, or 0 if invalid input
 * @example
 * const size = calculateMessageSize(new Uint8Array([1,2,3,4])); // returns 4
 * const size = calculateMessageSize("hello"); // returns 5 (bytes)
 * const size = calculateMessageSize(null); // returns 0
 */
export function calculateMessageSize(raw) {
    if (!raw) return 0;

    // Handle different buffer types
    if (typeof raw === 'string') {
        // For string data, get byte length
        return new TextEncoder().encode(raw).length;
    }

    if (ArrayBuffer.isView(raw)) {
        // For typed arrays like Uint8Array, Buffer, etc.
        return raw.length;
    }

    if (raw instanceof ArrayBuffer) {
        // For plain ArrayBuffer
        return raw.byteLength;
    }

    // Fallback - try to get length property
    if (raw.length !== undefined) {
        return raw.length;
    }

    return 0;
}

/**
 * Checks is the address is a valid URL.
 * @param {ُString} address
 * @returns {Boolean}
 */
export function isValidURL(address) {
    try {
        const url = new URL(address);
        return true;
    }
    catch (error) {
        return false;
    }
}

export function validateBootstrapString(str) {
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
            reason: 'Invalid format. Expected IPv4:Port (e.g., 192.168.100.23:8000)'
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
                reason: 'Invalid IP address. Each octet must be between 0 and 255'
            };
        }
    }

    // Validate port range (1-65535)
    if (portNum < 1 || portNum > 65535) {
        return {
            valid: false,
            reason: 'Invalid port number. Must be between 1 and 65535'
        };
    }

    return { valid: true, ip, port };
}