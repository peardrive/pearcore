import * as EVENTS from "../constants/events.constants.js";
import { validateSpaceContext } from './space.utils.js';
import { validateProfileContext } from "./profile.utils.js";
import { validateSpaceFilePath } from "./files.utils.js";
import { validateMerkleTree } from "./merkletree.utils.js";
import {
    hex,
    hash,
    signJSON,
    encryptJSON,
    decryptJSON,
    randomNonce,
    verifySignedJSON,
    canonicalStringify,
} from './crypto.utils.js';
import {
    isNumber,
    isObject,
    isString,
    now,
    validateFilePath,
    validateHexString,
    validateTimestamp,
    notNull,
    notUndefined,
    isDefined,
    nonceIsValid,
    spaceSecretIsValid,
    topicIsValid
} from './general.utils.js';

/**
 * Generates deterministic nonce from object payload
 * @param {Object} payload 
 * @returns {string} Retuns 24 character hex string as nonce
 */
export function generateNonceFromPayoad(payload) {
    const str = canonicalStringify(payload);
    const payloadHash = hex(hash(str));
    return payloadHash.slice(0, 24) // only the first 24 characters
}

/**
 * Verify a signed message.
 * @param {object} message - The full signed message
 * @returns {Promise<boolean>} True if the signature is valid, false otherwise
 */
export async function verifyMessageSignature(message) {
    if (!message.signature || !message.publicKey) {
        throw new Error('Message missing signature or publicKey');
    }

    if (typeof message.signature !== 'string') {
        return false;
    }

    const hexRegex = /^[0-9a-fA-F]+$/;
    if (!hexRegex.test(message.signature) || message.signature.length % 2 !== 0) {
        return false;
    }

    const { signature, ...messageContext } = message;

    const isValid = await verifySignedJSON(messageContext, signature, messageContext.publicKey);
    return isValid;
}

/**
 * Encrypt a message payload using the space secret.
 *
 * @param {Object} params
 * @param {Object} params.payload - Plain JSON payload
 * @param {string} params.spaceSecret - 32-byte hex symmetric key
 * @param {string} params.nonce - 24 character hex string as cipher nonce.
 *
 * @returns {Promise<{ payload: string, nonce: string }>}
 */
export async function encryptPayload({
    payload,
    spaceSecret,
    nonce
}) {

    if (!nonceIsValid(nonce)) throw new Error('nonce is invalid');
    if (!spaceSecretIsValid(spaceSecret)) throw new Error('spaceSecret is invalid');

    try {
        const encrypted = await encryptJSON(
            spaceSecret,
            nonce,
            payload
        );

        return encrypted;
    }
    catch (error) {
        return null;
    }
}

/**
 * Decrypt a message payload using the space secret.
 *
 * @param {Object} params
 * @param {string} params.payload - Encrypted payload (hex/base64 depending on your encryptJSON output)
 * @param {string} params.spaceSecret - 32-byte hex symmetric key
 * @param {string} params.nonce - 12-byte hex nonce used during encryption
 *
 * @returns {Promise<Object>} Decrypted JSON payload
 */
export async function decryptPayload({
    payload,
    spaceSecret,
    nonce
}) {

    if (!nonceIsValid(nonce)) throw new Error('nonce is invalid');
    if (!spaceSecretIsValid(spaceSecret)) throw new Error('spaceSecret is invalid');

    try {
        const decrypted = await decryptJSON(
            spaceSecret,
            nonce,
            payload
        );

        return decrypted;
    }
    catch (error) {
        return null;
    }
}

/**
 * Create a signed base message.
 * If nonce or timestamp are not provided, they are generated.
 *
 * @param {Object} params
 * @param {string} params.type - Message type
 * @param {string} params.topic - Topic name
 * @param {Uint8Array} params.publicKey - Ed25519 public key
 * @param {Uint8Array} params.secretKey - Ed25519 secret key (64 bytes)
 * @param {Object|string} [params.payload]
 * @param {string} [params.nonce] - Hex string
 * @param {number} [params.timestamp]
 *
 * @returns {Promise<object>} Signed message
 */
export async function createBaseMessage({
    type,
    topic,
    publicKey,
    secretKey,
    payload = null,
    nonce,
    timestamp
}) {
    if (!type) throw new Error('type is required');
    if (!topic) throw new Error('topic is required');
    if (!publicKey) throw new Error('publicKey is required');
    if (!secretKey) throw new Error('secretKey is required');

    const finalNonce = nonce ?? hex(randomNonce());
    const finalTimestamp = timestamp ?? now();

    const unsignedMsg = {
        type,
        topic,
        publicKey,
        nonce: finalNonce,
        timestamp: finalTimestamp,
        payload
    };

    const signature = await signJSON(unsignedMsg, secretKey);

    return {
        ...unsignedMsg,
        signature
    };
}

/**
 * Validates a base message object against all required fields and constraints
 * @param {Object} message - the message object to validate
 */
export function validateBaseMessage(message) {
    const validationRules = [
        ['type is required', () => isDefined(message.type)],
        ['topic is required', () => isDefined(message.topic)],
        ['publicKey is required', () => isDefined(message.publicKey)],
        ['nonce is required', () => isDefined(message.nonce)],
        ['timestamp is required', () => isDefined(message.timestamp)],
        ['signature is required', () => isDefined(message.signature)],

        ['type should be a string', () => typeof message.type === 'string'],
        ['type should not be larger than 64 characters', () => message.type.length <= 64],

        ['topic should be a string', () => typeof message.topic === 'string'],
        ['topic should not be larger than 158 characters', () => message.topic.length <= 158],

        ['publicKey should be a string', () => typeof message.publicKey === 'string'],
        ['publicKey should be 64 characters long', () => message.publicKey.length === 64],
        ['publicKey should be a valid hex string', () => validateHexString(message.publicKey)],

        ['nonce should be a string', () => typeof message.nonce === 'string'],
        ['nonce should be 24 characters long', () => message.nonce.length === 24],
        ['nonce should be a valid hex string', () => validateHexString(message.nonce)],

        ['timestamp should be a valid date', () => validateTimestamp(message.timestamp)],

        ['signature should be a string', () => typeof message.signature === 'string'],
        ['signature should be 128 characters long', () => message.signature.length === 128],
        ['signature should be a valid hex string', () => validateHexString(message.signature)],
    ];

    for (const [reason, condition] of validationRules) {
        if (!condition()) {
            return {
                isValid: false,
                reason: reason
            };
        }
    }

    return {
        isValid: true,
        reason: 'message is valid'
    };
}

/**
 * Create a signed rejection message.
 *
 * @param {Object} params
 * @param {string} params.topic - Topic the rejection belongs to
 * @param {string} params.linkedMessageNonce - Nonce of the message being rejected
 * @param {string} params.reason - Reason for rejection
 * @param {Uint8Array} params.secretKey - Sender's Ed25519 secret key
 * @param {Uint8Array} params.publicKey - Sender's Ed25519 public key
 * @param {string} [params.nonce] - Optional pre-generated nonce (hex)
 * @param {number} [params.timestamp] - Optional timestamp override
 *
 * @returns {Promise<object>} Signed rejection message
 */
export async function createRejectionMessage({
    topic,
    linkedMessageNonce,
    reason,
    secretKey,
    publicKey,
    nonce,
    timestamp
}) {
    if (!reason) throw new Error('reason is required');
    if (!secretKey) throw new Error('secretKey is required');
    if (!publicKey) throw new Error('publicKey is required');

    const payload = {
        linkedMessageNonce: linkedMessageNonce || EVENTS.noNonce,
        reason
    };

    return await createBaseMessage({
        type: EVENTS.Reject,
        topic: topic || EVENTS.noTopic,
        nonce: nonce,
        payload,
        publicKey,
        secretKey,
        timestamp
    });
}

/**
 * Creates a signed rejection response in reply to a protocol message.
 *
 * @param {Object} params
 * @param {Object} params.message - Message to reject (must contain topic and nonce)
 * @param {string} [params.reason] - Optional rejection reason
 *
 * @returns {Promise<Object>} Signed rejection message
 */
export async function createRejectionForMessage({
    message,
    publicKey,
    secretKey,
    reason = 'placeholder reason',
}) {
    if (!message) throw new Error('message is required');
    if (!message.topic) throw new Error('message.topic is required');
    if (!message.nonce) throw new Error('message.nonce is required');
    if (!secretKey) throw new Error('secretKey is not available');
    if (!publicKey) throw new Error('publicKey is not available');

    return await createRejectionMessage({
        // message context
        reason,
        topic: message.topic,
        linkedMessageNonce: message.nonce,

        // keypair
        secretKey,
        publicKey,
    });
}

/**
 * Create a signed profile update message.
 * 
 * - Additionally message will maintain deterministic nonce from profile payload and publicKey
 * to lower the duplicated message rate in the network. optionally pass params.nonce value to
 * avoid this behaviour.
 *
 * @param {Object} params
 * @param {Object} params.profile - User profile metadata object
 * @param {Uint8Array} params.secretKey - Sender's Ed25519 secret key
 * @param {Uint8Array} params.publicKey - Sender's Ed25519 public key
 * @param {Array<String>} [params.topics] - Optional topic override (defaults to EVENTS.ProfileUpdate)
 * @param {String} [params.nonce] - Optional pre-generated nonce (hex)
 * @param {number} [params.timestamp] - Optional timestamp override
 *
 * @returns {Promise<object>} Signed profile update message
 */
export async function createProfileUpdateMessage({
    profile,
    topics,
    secretKey,
    publicKey,
    nonce,
    timestamp
}) {
    if (!profile) throw new Error('profile is required');
    if (!topics) throw new Error('Topics are required');
    if (!secretKey) throw new Error('secretKey is required');
    if (!publicKey) throw new Error('publicKey is required');

    const payload = {
        profile: profile,
        topics: topics
    };

    return await createBaseMessage({
        type: EVENTS.ProfileUpdate,
        topic: EVENTS.noTopic,
        nonce: nonce || generateNonceFromPayoad({ publicKey, payload }),
        payload,
        publicKey,
        secretKey,
        timestamp
    });
}

/**
 * Validates a profileUpdate payload.
 * @param {Object} message - The profileUpdate message
 * @returns {{isValid: Boolean, reason: String}} - If the profile payload is valid, then isValid would be true.
 */
export function validateProfileUpdateMessagePayload(message) {
    const { profile, topics } = message.payload;
    const context = validateProfileContext(profile);
    if (!context.isValid) {
        return {
            isValid: false,
            reason: context.reason
        };
    }

    const topicsRules = [
        ['topics should be an array', () => Array.isArray(topics)],
        ['topics should contain 64 character hex strings', () => topics.every(item => topicIsValid(item))],
    ];

    for (const [reason, condition] of topicsRules) {
        if (!condition()) {
            return {
                isValid: false,
                reason: reason
            };
        }
    }

    return {
        isValid: true,
        reason: 'payload is valid'
    };
}

/**
 * Create a signed space sync message.
 * 
 * - Additionally message will maintain deterministic nonce from the space payload
 * to lower the duplicated message rate in the network. optionally pass params.nonce value to
 * avoid this behaviour.
 *
 * @param {Object} params
 * @param {string} params.topic - Topic the space sync message belongs to
 * @param {Object} params.space - Space object
 * @param {Uint8Array} params.secretKey - Sender's Ed25519 secret key
 * @param {Uint8Array} params.publicKey - Sender's Ed25519 public key
 * @param {string} [params.nonce] - Optional pre-generated nonce (hex)
 * @param {number} [params.timestamp] - Optional timestamp override
 *
 * @returns {Promise<object>} Signed space sync message
 */
export async function createSpaceSyncMessage({
    topic,
    space,
    secretKey,
    publicKey,
    nonce,
    timestamp
}) {
    if (!topic) throw new Error('topic is required');
    if (!space) throw new Error('space is required');
    if (!secretKey) throw new Error('secretKey is required');
    if (!publicKey) throw new Error('publicKey is required');

    const payload = space;

    return await createBaseMessage({
        type: EVENTS.SpaceSync,
        nonce: nonce || generateNonceFromPayoad(payload),
        topic,
        payload,
        publicKey,
        secretKey,
        timestamp
    })
}

/**
 * Validates a spaceSync payload.
 * @param {Object} message - The message object containing the payload to validate
 * @returns {Object} Validation result
 * @returns {boolean} isValid - Whether the payload is valid
 * @returns {string} reason - Reason for validation failure or success
 */
export function validateSpaceSyncMessagePayload(message) {
    const { payload } = message;

    const spaceValidationResult = validateSpaceContext(payload);
    if (!spaceValidationResult.isValid) {
        return {
            isValid: spaceValidationResult.isValid,
            reason: spaceValidationResult.reason
        };
    }

    return {
        isValid: true,
        reason: 'Payload is valid'
    };
}

/**
 * Create a signed space-hash list message.
 *
 * This message is used during socket connection initialization to advertise
 * the set of spaces a node is interested in. The payload contains a list of
 * hashed space topics derived from local space metadata.
 *
 * By exchanging this message, both peers can determine which space topics
 * they have in common and therefore which topics they are permitted to
 * broadcast messages to each other on.
 *
 * The event name is intentionally reused as the message topic, as this
 * message is protocol-scoped rather than space-scoped.
 *
 * @param {Object} params
 * @param {Uint8Array[] | string[]} params.hashList - List of hashed space topic identifiers
 * @param {Uint8Array} params.secretKey - Sender's Ed25519 secret key
 * @param {Uint8Array} params.publicKey - Sender's Ed25519 public key
 * @param {string} [params.nonce] - Optional pre-generated nonce (hex)
 * @param {number} [params.timestamp] - Optional timestamp override
 *
 * @returns {Promise<object>} Signed space-hash list message
 */
export async function createSpaceHashListMessage({
    hashList,
    secretKey,
    publicKey,
    nonce,
    timestamp
}) {
    if (!hashList) throw new Error('hashList is required');
    if (!secretKey) throw new Error('secretKey is required');
    if (!publicKey) throw new Error('publicKey is required');

    return await createBaseMessage({
        type: EVENTS.SpaceHashList,
        topic: EVENTS.noTopic,
        payload: hashList,
        nonce: nonce,
        secretKey,
        publicKey,
        timestamp
    });
}


/**
 * Validates a space hash list payload.
 * @param {Object} message - The message object containing the payload to validate
 * @returns {Object} Validation result
 * @returns {boolean} isValid - Whether the payload is valid
 * @returns {string} reason - Reason for validation failure or success
 */
export function validateSpaceHashListPayload(message) {
    const { payload } = message;

    const validationRules = [
        ['SpaceHashList payload should be an array', () => Array.isArray(payload)],
        ['SpaceHashList payload array should not exceed 64 elements', () => payload.length <= 64],
        ['SpaceHashList payload should contain only strings', () => payload.every(item => typeof item === 'string')],
        ['in SpaceHashList, each hash should be 64 characters long', () => payload.every(item => item.length === 64)],
        ['in SpaceHashList, each hash should be a valid hex string', () => payload.every(item => validateHexString(item))]
    ];

    for (const [reason, condition] of validationRules) {
        if (!condition()) {
            return {
                isValid: false,
                reason: reason
            };
        }
    }

    return {
        isValid: true,
        reason: 'Payload is valid'
    };
}

/**
 * Creates a signed space message for broadcasting over the network.
 *
 * This function wraps a payload (list of space topics or related data) into
 * a properly formatted message and signs it using the sender's Ed25519 keys.
 * The resulting message can then be sent to peers or broadcast to a topic.
 *
 * @param {Object} params
 * @param {string} params.topic - Topic the message belongs to
 * @param {Uint8Array[] | string[] | Object} params.messagePayload - Payload for the message (must be JSON-serializable)
 * @param {Uint8Array} params.secretKey - Sender's Ed25519 secret key
 * @param {Uint8Array} params.publicKey - Sender's Ed25519 public key
 * @param {string} [params.nonce] - Optional pre-generated nonce (hex)
 * @param {number} [params.timestamp] - Optional timestamp override
 *
 * @returns {Promise<object>} Signed space message
 */
export async function createSpaceMessage({
    topic,
    messagePayload,
    secretKey,
    publicKey,
    nonce,
    timestamp
}) {
    if (!topic) throw new Error('topic is required');
    if (!messagePayload) throw new Error('messagePayload is required');
    if (!secretKey) throw new Error('secretKey is required');
    if (!publicKey) throw new Error('publicKey is required');

    return await createBaseMessage({
        type: EVENTS.SpaceMessage,
        topic,
        payload: messagePayload,
        secretKey,
        publicKey,
        nonce,
        timestamp
    });
}

/**
 * Creates a signed space file event list.
 * @param {Object} params
 * @param {string} params.topic - Topic the message belongs
 * @param {Array} params.events - List of events in format of { action, files }
 * @param {Uint8Array} params.secretKey - Sender's Ed25519 secret key
 * @param {Uint8Array} params.publicKey - Sender's Ed25519 public key
 * @param {string} params.nonce - Optional pre-generated nonce (hex)
 * @param {number} params.timestamp - Optional timestamp override
 * @returns 
 */
export async function createSpaceFileEventMessage({
    topic,
    events,
    publicKey,
    secretKey,
    nonce,
    timestamp
}) {
    if (!topic) throw new Error('topic is required');
    if (!events) throw new Error('events is required');
    if (!secretKey) throw new Error('secretKey is required');
    if (!publicKey) throw new Error('publicKey is required');

    return await createBaseMessage({
        type: EVENTS.SpaceFileEvent,
        topic,
        payload: events,
        secretKey,
        publicKey,
        nonce,
        timestamp
    });
}

// List of file event actions as an array
const fileEventActions = Object.values(EVENTS.SpaceFileEventOptions);

// validates individual events from spaceFileEvent message
const validateEvent = event => {
    if (!fileEventActions.includes(event.action)) return false;
    if (!Array.isArray(event.files)) return false;

    for (const file of event.files) {
        const [filepath, publicKey, timestamp, rootHash, signature] = file;

        if (!isString(filepath) || !validateFilePath(filepath)) return false;
        if (!isString(publicKey) || publicKey.length !== 64) return false;
        if (!validateTimestamp(timestamp)) return false;
        if (
            !isString(signature) ||
            signature.length !== 128 ||
            !validateHexString(signature)
        ) {
            return false;
        }
    }

    return true;
}

/**
 * Validates SpaceFileEvent payload.
 * @param {Object} message - The SpaceFileEvent message
 * @returns {{ isValid: Boolean, reason: string }}
 */
export function validateSpaceFileEventPayload(message) {
    // refering to message payload as "events"
    const { payload: events } = message;

    const rules = [
        ['payload should be an array', () => Array.isArray(events)],
        ['payload should contain only objects', () => events.every(isObject)],
        ['event actions should be valid', () => events.every(validateEvent)]
    ];

    for (const [reason, condition] of rules) {
        if (!condition()) {
            return {
                isValid: false,
                reason: reason
            };
        }
    }

    return {
        isValid: true,
        reason: 'payload is valid'
    };
}

/**
 * Create space file event signature.
 * @param {Object} record 
 * @param {string} record.topic - Space topic hash.
 * @param {string} record.path - Space file path.
 * @param {string} record.publicKey - 64-character hex string publickey.
 * @param {number} record.timestamp - File record timestamp.
 * @param {string} record.rootHash - File Merkle-tree root hash.
 * @param {string} record.signature - File record signature.
 * @returns {Promise<string>}
 */
export async function createSpaceFileRecordSignature(record) {
    const { topic, path, publicKey, timestamp, rootHash, secretKey } = record;
    const payload = { topic, path, publicKey, timestamp, rootHash };
    return await signJSON(payload, secretKey);
}

/**
 * Verify space file event signature.
 * @param {Object} record 
 * @param {string} record.topic - Space topic hash.
 * @param {string} record.path - Space file path.
 * @param {string} record.publicKey - 64-character hex string publickey.
 * @param {number} record.timestamp - File record timestamp.
 * @param {string} record.rootHash - File Merkle-tree root hash.
 * @param {string} record.signature - File record signature.
 * @returns {Promise<boolean>}
 */
export async function verifySpaceFileRecordSignature(record) {
    const { topic, path, publicKey, timestamp, rootHash, signature } = record;
    const payload = { topic, path, publicKey, timestamp, rootHash };
    return await verifySignedJSON(payload, signature, publicKey);
}

/**
 * Creates request message for file Merkle Tree.
 * @param {Object} params
 * @param {string} params.topic - Topic the message belongs
 * @param {Array} params.spaceFilePath - The file path within the space.
 * @param {Array} params.rootHash - The specific root hash of the requested space file.
 * @param {Uint8Array} params.secretKey - Sender's Ed25519 secret key
 * @param {Uint8Array} params.publicKey - Sender's Ed25519 public key
 * @param {string} params.nonce - Optional pre-generated nonce (hex)
 * @param {number} params.timestamp - Optional timestamp override
 * @returns {Promise<Object>}
 */
export async function createSpaceFileTreeRequestMessage({
    topic,
    spaceFilePath,
    rootHash,
    publicKey,
    secretKey,
    nonce,
    timestamp
}) {
    if (!topic) throw new Error('topic is required');
    if (!rootHash) throw new Error('rootHash is required');
    if (!spaceFilePath) throw new Error('spaceFilePath is required');
    if (!secretKey) throw new Error('secretKey is required');
    if (!publicKey) throw new Error('publicKey is required');

    const payload = { spaceFilePath, rootHash };

    return await createBaseMessage({
        type: EVENTS.SpaceFileTreeRequest,
        topic,
        payload: payload,
        secretKey,
        publicKey,
        nonce,
        timestamp
    })
}

/**
 * Validates SpaceFileTreeRequest payload.
 * @param {Object} message - The SpaceFileTreeRequest message
 * @returns {{ isValid: Boolean, reason: string }}
 */
export function validateSpaceFileTreeRequestPayload(message) {
    const { spaceFilePath, rootHash } = message.payload;

    const rules = [
        ['rootHash is required', () => isDefined(rootHash)],
        ['spaceFilePath is required', () => isDefined(spaceFilePath)],
        ['rootHash should be hex string', () => isString(rootHash) && validateHexString(rootHash)],
        ['spaceFilePath should be string', () => isString(spaceFilePath)],
    ];

    for (const [reason, condition] of rules) {
        if (!condition()) {
            return { isValid: false, reason };
        }
    }

    const pathStatus = validateSpaceFilePath(spaceFilePath);
    if (!pathStatus.isValid) return pathStatus;

    return { isValid: true, reason: 'request is valid' };
}

/**
 * Creates request message for file Merkle Tree.
 * @param {Object} params
 * @param {string} params.topic - Topic the message belongs
 * @param {Array} params.tree - The file path within the space.
 * @param {Array} params.lastRequestableLeaf - The specific root hash of the requested space file.
 * @param {Array} params.replyNonce - The specific root hash of the requested space file.
 * @param {Uint8Array} params.secretKey - Sender's Ed25519 secret key
 * @param {Uint8Array} params.publicKey - Sender's Ed25519 public key
 * @param {string} params.nonce - Optional pre-generated nonce (hex)
 * @param {number} params.timestamp - Optional timestamp override
 * @returns {Promise<Object>}
 */
export async function createSpaceFileTreeResponseMessage({
    topic,
    tree,
    lastRequestableLeaf,
    replyNonce,
    secretKey,
    publicKey,
    nonce,
    timestamp
}) {
    if (!topic) throw new Error('topic is required');
    if (!tree) throw new Error('tree is required');
    if (!Number.isInteger(lastRequestableLeaf)) throw new Error('lastRequestableLeaf is required');
    if (!replyNonce) throw new Error('replyNonce is required');
    if (!secretKey) throw new Error('secretKey is required');
    if (!publicKey) throw new Error('publicKey is required');

    const payload = { tree, lastRequestableLeaf, replyNonce };

    return await createBaseMessage({
        type: EVENTS.SpaceFileTreeResponse,
        topic,
        payload: payload,
        secretKey,
        publicKey,
        nonce,
        timestamp
    })
}

/**
 * Validates createSpaceFileTreeResponseMessage payload.
 * @param {Object} message - The SpaceFileTreeResponse message
 * @returns {{ isValid: Boolean, reason: string }}
 */
export function validateSpaceFileTreeResponsePayload(message) {
    const { tree, lastRequestableLeaf, replyNonce } = message.payload;

    const rules = [
        ['tree is required', () => isDefined(tree)],
        ['lastRequestableLeaf is required', () => isDefined(lastRequestableLeaf)],
        ['lastRequestableLeaf should be a number', () => isNumber(lastRequestableLeaf)],
        ['replyNonce is required', () => isDefined(replyNonce)],
        ['replNonce should 24 characters string', () => isString(replyNonce) && replyNonce.length === 24],
        ['replyNonce should be valid hex string', () => validateHexString(replyNonce)]
    ];

    for (const [reason, condition] of rules) {
        if (!condition()) {
            return { isValid: false, reason };
        }
    }

    const treeStatus = validateMerkleTree(tree);
    if (!tree.isValid) return treeStatus;

    return { isValid: true, reason: 'response is valid' };
}

/**
 * Creates signed space file content request.
 * @param {Object} params
 * @param {string} params.topic - Topic the message belongs
 * @param {string} params.spaceFilePath - Virtual file path in the space.
 * @param {number} params.leafStart - First leaf of the Merkle tree in the sequence.
 * @param {number} params.leafStop - Last leaf of the Merkle tree in the sequence.
 * @param {string} params.downloadKey - Request download key for stream routing.
 * @param {Uint8Array} params.secretKey - Sender's Ed25519 secret key
 * @param {Uint8Array} params.publicKey - Sender's Ed25519 public key
 * @param {string} params.nonce - Optional pre-generated nonce (hex)
 * @param {number} params.timestamp - Optional timestamp override
 * @returns {Promise<Object>} 
 */
export async function createSpaceFileContentRequestMessage({
    topic,
    spaceFilePath,
    leafStart,
    leafStop,
    downloadKey,
    secretKey,
    publicKey,
    nonce,
    timestamp
}) {
    if (!topic) throw new Error('topic is required');
    if (!spaceFilePath) throw new Error('spaceFilePath is required');
    if (!downloadKey) throw new Error('downloadKey is required');
    if (!Number.isInteger(leafStart)) throw new Error('leafStart is required and should be number');
    if (!Number.isInteger(leafStop)) throw new Error('leafStop is required and should be number');
    if (!secretKey) throw new Error('secretKey is required');
    if (!publicKey) throw new Error('publicKey is required');

    const payload = { spaceFilePath, slice: [leafStart, leafStop], key: downloadKey };

    return await createBaseMessage({
        type: EVENTS.SpaceFileContentRequest,
        topic,
        payload: payload,
        secretKey,
        publicKey,
        nonce,
        timestamp
    })
}

/**
 * Validates createSpaceFileContentRequestMessage payload.
 * @param {Object} message - The SpaceFileEvent message
 * @returns {{ isValid: Boolean, reason: string }}
 */
export function validateSpaceFileContentRequestPayload(message) {
    const { spaceFilePath, slice, key } = message.payload;

    const rules = [
        ['spaceFilePath should be a string', () => isString(spaceFilePath)],
        ['slice should be an array', () => Array.isArray(slice)],
        ['start should be an integer', () => Number.isInteger(slice[0])],
        ['stop should be an integer', () => Number.isInteger(slice[1])],
        ['key should be a string', () => isString(key)]
    ];

    for (const [reason, condition] of rules) {
        if (!condition()) {
            return { isValid: false, reason };
        }
    }

    return { isValid: true, reason: 'message is valid' };
}

/**
 * Creates signed space file content 'cancel' request.
 * @param {Object} params
 * @param {string} params.topic - Topic the message belongs
 * @param {string} params.downloadKey - Request download key for stream routing.
 * @param {Uint8Array} params.secretKey - Sender's Ed25519 secret key
 * @param {Uint8Array} params.publicKey - Sender's Ed25519 public key
 * @param {string} params.nonce - Optional pre-generated nonce (hex)
 * @param {number} params.timestamp - Optional timestamp override
 * @returns {Promise<Object>} 
 */
export async function createSpaceFileContentCancelMessage(params) {
    const { topic, downloadKey, publicKey, secretKey, nonce, timestamp } = params;

    if (!topic) throw new Error('topic is required');
    if (!downloadKey) throw new Error('key is required');
    if (!secretKey) throw new Error('secretKey is required');
    if (!publicKey) throw new Error('publicKey is required');

    const payload = { key: downloadKey };
    return await createBaseMessage({
        type: EVENTS.SpaceFileContentCancel,
        topic,
        payload: payload,
        secretKey,
        publicKey,
        nonce,
        timestamp
    });
}

/**
 * Validates SpaceFileContentCancel request.
 * @param {Object} message 
 * @param {String} message.key - the generated download task key.
 * @returns {{isValid: Boolean, reason: String}}
 */
export function validateSpaceFileContentCancelPayload(message) {
    const key = message.payload.key;

    if (!isString(key) || !validateHexString(key)) {
        return { isValid: false, reason: 'key should be string' };
    }

    return { isValid: true, reason: 'mesage is valid' };
}