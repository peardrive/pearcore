import * as EVENTS from '../constants/events.constants.js';
import { validateSpaceContext } from './space.utils.js';
import { validateProfileContext } from './profile.utils.js';
import { validateSpaceFilePath } from './files.utils.js';
import { validateMerkleTree } from './merkletree.utils.js';
import { compareMessageBounds, computeMessageId } from './message.utils.js';
import type { MessageBound } from './message.utils.js';
import {
  hex,
  hash,
  signJSON,
  encryptJSON,
  decryptJSON,
  randomNonce,
  verifySignedJSON,
  verifySignedString,
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
  topicIsValid,
} from './general.utils.js';

/** A signed protocol message after it has been serialized onto the wire. */
export interface SignedProtocolMessage<Payload = unknown> {
  type: string;
  topic: string;
  publicKey: string;
  nonce: string;
  timestamp: number;
  payload: Payload;
  signature: string;
}

/** The common result returned by protocol payload validators. */
export interface ProtocolValidationResult {
  isValid: boolean;
  reason: string;
}

/** An untrusted protocol message, passed to runtime validators. */
export interface ProtocolMessageLike {
  payload: any;
  [key: string]: any;
}

/** Common fields used when creating a signed message. */
export interface MessageSigningFields {
  publicKey: string;
  secretKey: string | Uint8Array;
  nonce?: string;
  timestamp?: number;
}

/** Parameters for creating a base signed message. */
export interface BaseMessageInput<
  Payload = unknown,
> extends MessageSigningFields {
  type: string;
  topic: string;
  payload?: Payload;
}

export interface RejectionMessageInput extends MessageSigningFields {
  topic?: string;
  linkedMessageNonce?: string;
  reason: string;
}

export interface RejectionForMessageInput {
  message: { topic?: string; nonce?: string };
  publicKey: string;
  secretKey: string;
  reason?: string;
}

export interface ProfileUpdateMessageInput extends MessageSigningFields {
  profile: unknown;
  topics: string[];
}

export interface SpaceSyncMessageInput extends MessageSigningFields {
  topic: string;
  space: unknown;
}

export interface SpaceHashListMessageInput extends MessageSigningFields {
  hashList: Array<string | Uint8Array>;
}

export interface SpaceMessageInput extends MessageSigningFields {
  topic: string;
  messagePayload: unknown;
}

export interface SpaceFileEventMessageInput extends MessageSigningFields {
  topic: string;
  events: unknown;
}

export interface SpaceFileRecordInput {
  topic: string;
  path: string;
  publicKey: string | Uint8Array;
  timestamp: number;
  rootHash: string;
  secretKey?: string | Uint8Array;
  signature?: string;
}

export interface SpaceFileTreeRequestInput extends MessageSigningFields {
  topic: string;
  spaceFilePath: string;
  rootHash: string;
}

export interface SpaceFileTreeResponseInput extends MessageSigningFields {
  topic: string;
  tree: unknown;
  lastRequestableLeaf: number;
  replyNonce: string;
}

export interface SpaceFileContentRequestInput extends MessageSigningFields {
  topic: string;
  spaceFilePath: string;
  leafStart: number;
  leafStop: number;
  downloadKey: string;
}

export interface SpaceFileContentCancelInput extends MessageSigningFields {
  topic: string;
  downloadKey: string;
}

export interface NegentropySyncMessageInput extends MessageSigningFields {
  topic: string;
  sessionId: string;
  ranges: unknown;
}

export interface NegentropyContentRequestInput extends MessageSigningFields {
  topic: string;
  assignmentKey: string;
  messageIds: string[];
}

export interface NegentropyContentCancelInput extends MessageSigningFields {
  topic: string;
  assignmentKey: string;
  messageIds?: string[];
}

export interface DeliveredMessage {
  type: string;
  publicKey: string;
  nonce: string;
  timestamp: number;
  signature: string;
  canonicalPayload: string;
}

/** Relevant fields from a message row before delivery. */
export interface StoredMessageLike {
  type: string;
  ownerPublicKey: string;
  nonce: string;
  messageTimestamp: number;
  signature: string;
  payload: string;
}

export interface NegentropyContentDeliveryInput extends MessageSigningFields {
  topic: string;
  assignmentKey: string;
  content: DeliveredMessage;
}

type ProtocolRecord = Record<string, any>;
type ValidationRule = [reason: string, condition: () => boolean];

/**
 * Generates deterministic nonce from object payload
 * @param payload - The payload used to derive the nonce.
 * @returns A 24 character hex string as nonce.
 */
export function generateNonceFromPayoad(payload: unknown): string {
  const str = canonicalStringify(payload);
  const payloadHash = hex(hash(str));
  return payloadHash.slice(0, 24); // only the first 24 characters
}

/**
 * Verify a signed message.
 * @param message - The full signed message
 * @returns True if the signature is valid, false otherwise
 */
export async function verifyMessageSignature(
  message: ProtocolRecord,
): Promise<boolean> {
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

  const isValid = await verifySignedJSON(
    messageContext,
    signature,
    messageContext.publicKey,
  );
  return isValid;
}

/**
 * Encrypt a message payload using the space secret.
 *
 * @param params
 * @param params.payload - Plain JSON payload
 * @param params.spaceSecret - 32-byte hex symmetric key
 * @param params.nonce - 24 character hex string as cipher nonce.
 *
 */
export async function encryptPayload({
  payload,
  spaceSecret,
  nonce,
}: {
  payload: unknown;
  spaceSecret: string;
  nonce: string;
}): Promise<string | null> {
  if (!nonceIsValid(nonce)) throw new Error('nonce is invalid');
  if (!spaceSecretIsValid(spaceSecret))
    throw new Error('spaceSecret is invalid');

  try {
    const encrypted = await encryptJSON(spaceSecret, nonce, payload);

    return encrypted;
  } catch {
    return null;
  }
}

/**
 * Decrypt a message payload using the space secret.
 *
 * @param params
 * @param params.payload - Encrypted payload (hex/base64 depending on your encryptJSON output)
 * @param params.spaceSecret - 32-byte hex symmetric key
 * @param params.nonce - 12-byte hex nonce used during encryption
 *
 * @returns Decrypted JSON payload
 */
export async function decryptPayload({
  payload,
  spaceSecret,
  nonce,
}: {
  payload: string;
  spaceSecret: string;
  nonce: string;
}): Promise<unknown | null> {
  if (!nonceIsValid(nonce)) throw new Error('nonce is invalid');
  if (!spaceSecretIsValid(spaceSecret))
    throw new Error('spaceSecret is invalid');

  try {
    const decrypted = await decryptJSON(spaceSecret, nonce, payload);

    return decrypted;
  } catch {
    return null;
  }
}

/**
 * Create a signed base message.
 * If nonce or timestamp are not provided, they are generated.
 *
 * @param params
 * @param params.type - Message type
 * @param params.topic - Topic name
 * @param params.publicKey - Ed25519 public key
 * @param params.secretKey - Ed25519 secret key (64 bytes)
 * @param [params.payload]
 * @param [params.nonce] - Hex string
 * @param [params.timestamp]
 *
 * @returns Signed message
 */
export function createBaseMessage<Payload>(
  params: BaseMessageInput<Payload> & { payload: Payload },
): Promise<SignedProtocolMessage<Payload>>;
export function createBaseMessage(
  params: BaseMessageInput,
): Promise<SignedProtocolMessage<unknown | null>>;
export async function createBaseMessage<Payload = unknown>({
  type,
  topic,
  publicKey,
  secretKey,
  payload = null as Payload,
  nonce,
  timestamp,
}: BaseMessageInput<Payload>): Promise<SignedProtocolMessage<Payload | null>> {
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
    payload,
  };

  const signature = await signJSON(unsignedMsg, secretKey);

  return {
    ...unsignedMsg,
    payload: payload as Payload | null,
    signature,
  };
}

/**
 * Validates a base message object against all required fields and constraints
 * @param message - the message object to validate
 */
export function validateBaseMessage(
  message: ProtocolMessageLike,
): ProtocolValidationResult {
  const validationRules: ValidationRule[] = [
    ['type is required', () => isDefined(message.type)],
    ['topic is required', () => isDefined(message.topic)],
    ['publicKey is required', () => isDefined(message.publicKey)],
    ['nonce is required', () => isDefined(message.nonce)],
    ['timestamp is required', () => isDefined(message.timestamp)],
    ['signature is required', () => isDefined(message.signature)],

    ['type should be a string', () => typeof message.type === 'string'],
    [
      'type should not be larger than 64 characters',
      () => message.type.length <= 64,
    ],

    ['topic should be a string', () => typeof message.topic === 'string'],
    [
      'topic should not be larger than 158 characters',
      () => message.topic.length <= 158,
    ],

    [
      'publicKey should be a string',
      () => typeof message.publicKey === 'string',
    ],
    [
      'publicKey should be 64 characters long',
      () => message.publicKey.length === 64,
    ],
    [
      'publicKey should be a valid hex string',
      () => validateHexString(message.publicKey),
    ],

    ['nonce should be a string', () => typeof message.nonce === 'string'],
    ['nonce should be 24 characters long', () => message.nonce.length === 24],
    [
      'nonce should be a valid hex string',
      () => validateHexString(message.nonce),
    ],

    [
      'timestamp should be a valid date',
      () => validateTimestamp(message.timestamp),
    ],

    [
      'signature should be a string',
      () => typeof message.signature === 'string',
    ],
    [
      'signature should be 128 characters long',
      () => message.signature.length === 128,
    ],
    [
      'signature should be a valid hex string',
      () => validateHexString(message.signature),
    ],
  ];

  for (const [reason, condition] of validationRules) {
    if (!condition()) {
      return {
        isValid: false,
        reason: reason,
      };
    }
  }

  return {
    isValid: true,
    reason: 'message is valid',
  };
}

/**
 * Create a signed rejection message.
 *
 * @param params
 * @param params.topic - Topic the rejection belongs to
 * @param params.linkedMessageNonce - Nonce of the message being rejected
 * @param params.reason - Reason for rejection
 * @param params.secretKey - Sender's Ed25519 secret key
 * @param params.publicKey - Sender's Ed25519 public key
 * @param [params.nonce] - Optional pre-generated nonce (hex)
 * @param [params.timestamp] - Optional timestamp override
 *
 * @returns Signed rejection message
 */
export async function createRejectionMessage({
  topic,
  linkedMessageNonce,
  reason,
  secretKey,
  publicKey,
  nonce,
  timestamp,
}: RejectionMessageInput): Promise<
  SignedProtocolMessage<{ linkedMessageNonce: string; reason: string }>
> {
  if (!reason) throw new Error('reason is required');
  if (!secretKey) throw new Error('secretKey is required');
  if (!publicKey) throw new Error('publicKey is required');

  const payload = {
    linkedMessageNonce: linkedMessageNonce || EVENTS.noNonce,
    reason,
  };

  return await createBaseMessage({
    type: EVENTS.Reject,
    topic: topic || EVENTS.noTopic,
    nonce: nonce,
    payload,
    publicKey,
    secretKey,
    timestamp,
  });
}

/**
 * Creates a signed rejection response in reply to a protocol message.
 *
 * @param params
 * @param params.message - Message to reject (must contain topic and nonce)
 * @param [params.reason] - Optional rejection reason
 *
 * @returns Signed rejection message
 */
export async function createRejectionForMessage({
  message,
  publicKey,
  secretKey,
  reason = 'placeholder reason',
}: RejectionForMessageInput): Promise<SignedProtocolMessage> {
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
 * @param params
 * @param params.profile - User profile metadata object
 * @param params.secretKey - Sender's Ed25519 secret key
 * @param params.publicKey - Sender's Ed25519 public key
 * @param [params.topics] - Optional topic override (defaults to EVENTS.ProfileUpdate)
 * @param [params.nonce] - Optional pre-generated nonce (hex)
 * @param [params.timestamp] - Optional timestamp override
 *
 * @returns Signed profile update message
 */
export async function createProfileUpdateMessage({
  profile,
  topics,
  secretKey,
  publicKey,
  nonce,
  timestamp,
}: ProfileUpdateMessageInput): Promise<SignedProtocolMessage> {
  if (!profile) throw new Error('profile is required');
  if (!topics) throw new Error('Topics are required');
  if (!secretKey) throw new Error('secretKey is required');
  if (!publicKey) throw new Error('publicKey is required');

  const payload = {
    profile: profile,
    topics: topics,
  };

  return await createBaseMessage({
    type: EVENTS.ProfileUpdate,
    topic: EVENTS.noTopic,
    nonce: nonce || generateNonceFromPayoad({ publicKey, payload }),
    payload,
    publicKey,
    secretKey,
    timestamp,
  });
}

/**
 * Validates a profileUpdate payload.
 * @param message - The profileUpdate message
 * @returns - If the profile payload is valid, then isValid would be true.
 */
export function validateProfileUpdateMessagePayload(
  message: ProtocolMessageLike,
): ProtocolValidationResult {
  const { profile, topics } = message.payload;
  const context = validateProfileContext(profile);
  if (!context.isValid) {
    return {
      isValid: false,
      reason: context.reason,
    };
  }

  const topicsRules: ValidationRule[] = [
    ['topics should be an array', () => Array.isArray(topics)],
    [
      'topics should contain 64 character hex strings',
      () => topics.every((item: unknown) => topicIsValid(item)),
    ],
  ];

  for (const [reason, condition] of topicsRules) {
    if (!condition()) {
      return {
        isValid: false,
        reason: reason,
      };
    }
  }

  return {
    isValid: true,
    reason: 'payload is valid',
  };
}

/**
 * Create a signed space sync message.
 *
 * - Additionally message will maintain deterministic nonce from the space payload
 * to lower the duplicated message rate in the network. optionally pass params.nonce value to
 * avoid this behaviour.
 *
 * @param params
 * @param params.topic - Topic the space sync message belongs to
 * @param params.space - Space object
 * @param params.secretKey - Sender's Ed25519 secret key
 * @param params.publicKey - Sender's Ed25519 public key
 * @param [params.nonce] - Optional pre-generated nonce (hex)
 * @param [params.timestamp] - Optional timestamp override
 *
 * @returns Signed space sync message
 */
export async function createSpaceSyncMessage({
  topic,
  space,
  secretKey,
  publicKey,
  nonce,
  timestamp,
}: SpaceSyncMessageInput): Promise<SignedProtocolMessage> {
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
    timestamp,
  });
}

/**
 * Validates a spaceSync payload.
 * @param message - The message object containing the payload to validate
 * @returns Validation result
 * @returns isValid - Whether the payload is valid
 * @returns reason - Reason for validation failure or success
 */
export function validateSpaceSyncMessagePayload(
  message: ProtocolMessageLike,
): ProtocolValidationResult {
  const { payload } = message;

  const spaceValidationResult = validateSpaceContext(payload);
  if (!spaceValidationResult.isValid) {
    return {
      isValid: spaceValidationResult.isValid,
      reason: spaceValidationResult.reason,
    };
  }

  return {
    isValid: true,
    reason: 'Payload is valid',
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
 * @param params
 * @param params.hashList - List of hashed space topic identifiers
 * @param params.secretKey - Sender's Ed25519 secret key
 * @param params.publicKey - Sender's Ed25519 public key
 * @param [params.nonce] - Optional pre-generated nonce (hex)
 * @param [params.timestamp] - Optional timestamp override
 *
 * @returns Signed space-hash list message
 */
export async function createSpaceHashListMessage({
  hashList,
  secretKey,
  publicKey,
  nonce,
  timestamp,
}: SpaceHashListMessageInput): Promise<SignedProtocolMessage> {
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
    timestamp,
  });
}

/**
 * Validates a space hash list payload.
 * @param message - The message object containing the payload to validate
 * @returns Validation result
 * @returns isValid - Whether the payload is valid
 * @returns reason - Reason for validation failure or success
 */
export function validateSpaceHashListPayload(
  message: ProtocolMessageLike,
): ProtocolValidationResult {
  const { payload } = message;

  const validationRules: ValidationRule[] = [
    ['SpaceHashList payload should be an array', () => Array.isArray(payload)],
    [
      'SpaceHashList payload array should not exceed 64 elements',
      () => payload.length <= 64,
    ],
    [
      'SpaceHashList payload should contain only strings',
      () => payload.every((item: unknown) => typeof item === 'string'),
    ],
    [
      'in SpaceHashList, each hash should be 64 characters long',
      () =>
        payload.every((item: unknown) => isString(item) && item.length === 64),
    ],
    [
      'in SpaceHashList, each hash should be a valid hex string',
      () =>
        payload.every(
          (item: unknown) => isString(item) && validateHexString(item),
        ),
    ],
  ];

  for (const [reason, condition] of validationRules) {
    if (!condition()) {
      return {
        isValid: false,
        reason: reason,
      };
    }
  }

  return {
    isValid: true,
    reason: 'Payload is valid',
  };
}

/**
 * Creates a signed space message for broadcasting over the network.
 *
 * This function wraps a payload (list of space topics or related data) into
 * a properly formatted message and signs it using the sender's Ed25519 keys.
 * The resulting message can then be sent to peers or broadcast to a topic.
 *
 * @param params
 * @param params.topic - Topic the message belongs to
 * @param params.messagePayload - Payload for the message (must be JSON-serializable)
 * @param params.secretKey - Sender's Ed25519 secret key
 * @param params.publicKey - Sender's Ed25519 public key
 * @param [params.nonce] - Optional pre-generated nonce (hex)
 * @param [params.timestamp] - Optional timestamp override
 *
 * @returns Signed space message
 */
export async function createSpaceMessage({
  topic,
  messagePayload,
  secretKey,
  publicKey,
  nonce,
  timestamp,
}: SpaceMessageInput): Promise<SignedProtocolMessage> {
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
    timestamp,
  });
}

/**
 * Creates a signed space file event list.
 * @param params
 * @param params.topic - Topic the message belongs
 * @param params.secretKey - Sender's Ed25519 secret key
 * @param params.publicKey - Sender's Ed25519 public key
 * @param params.nonce - Optional pre-generated nonce (hex)
 * @param params.timestamp - Optional timestamp override
 */
export async function createSpaceFileEventMessage({
  topic,
  events,
  publicKey,
  secretKey,
  nonce,
  timestamp,
}: SpaceFileEventMessageInput): Promise<SignedProtocolMessage> {
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
    timestamp,
  });
}

// List of file event actions as an array
const fileEventActions = Object.values(EVENTS.SpaceFileEventOptions);

// validates individual events from spaceFileEvent message
const validateEvent = (event: ProtocolRecord): boolean => {
  if (!fileEventActions.includes(event.action)) return false;
  if (!Array.isArray(event.files)) return false;

  for (const file of event.files) {
    const [filepath, publicKey, timestamp, rootHash, signature] = file;

    if (!isString(filepath) || !validateFilePath(filepath)) return false;
    if (!isString(publicKey) || publicKey.length !== 64) return false;
    if (!validateTimestamp(timestamp)) return false;
    if (!validateHexString(rootHash)) return false;
    if (
      !isString(signature) ||
      signature.length !== 128 ||
      !validateHexString(signature)
    ) {
      return false;
    }
  }

  return true;
};

/**
 * Validates SpaceFileEvent payload.
 * @param message - The SpaceFileEvent message
 */
export function validateSpaceFileEventPayload(
  message: ProtocolMessageLike,
): ProtocolValidationResult {
  // refering to message payload as "events"
  const { payload: events } = message;

  const rules: ValidationRule[] = [
    ['payload should be an array', () => Array.isArray(events)],
    ['payload should contain only objects', () => events.every(isObject)],
    ['event actions should be valid', () => events.every(validateEvent)],
  ];

  for (const [reason, condition] of rules) {
    if (!condition()) {
      return {
        isValid: false,
        reason: reason,
      };
    }
  }

  return {
    isValid: true,
    reason: 'payload is valid',
  };
}

/**
 * Create space file event signature.
 * @param record
 * @param record.topic - Space topic hash.
 * @param record.path - Space file path.
 * @param record.publicKey - 64-character hex string publickey.
 * @param record.timestamp - File record timestamp.
 * @param record.rootHash - File Merkle-tree root hash.
 * @param record.signature - File record signature.
 */
export async function createSpaceFileRecordSignature(
  record: SpaceFileRecordInput & { secretKey: string | Uint8Array },
): Promise<string> {
  const { topic, path, publicKey, timestamp, rootHash, secretKey } = record;
  const payload = { topic, path, publicKey, timestamp, rootHash };
  return await signJSON(payload, secretKey);
}

/**
 * Verify space file event signature.
 * @param record
 * @param record.topic - Space topic hash.
 * @param record.path - Space file path.
 * @param record.publicKey - 64-character hex string publickey.
 * @param record.timestamp - File record timestamp.
 * @param record.rootHash - File Merkle-tree root hash.
 * @param record.signature - File record signature.
 */
export async function verifySpaceFileRecordSignature(
  record: SpaceFileRecordInput & { signature: string },
): Promise<boolean> {
  const { topic, path, publicKey, timestamp, rootHash, signature } = record;
  const payload = { topic, path, publicKey, timestamp, rootHash };
  return await verifySignedJSON(payload, signature, publicKey);
}

/**
 * Creates request message for file Merkle Tree.
 * @param params
 * @param params.topic - Topic the message belongs
 * @param params.spaceFilePath - The file path within the space.
 * @param params.rootHash - The specific root hash of the requested space file.
 * @param params.secretKey - Sender's Ed25519 secret key
 * @param params.publicKey - Sender's Ed25519 public key
 * @param params.nonce - Optional pre-generated nonce (hex)
 * @param params.timestamp - Optional timestamp override
 */
export async function createSpaceFileTreeRequestMessage({
  topic,
  spaceFilePath,
  rootHash,
  publicKey,
  secretKey,
  nonce,
  timestamp,
}: SpaceFileTreeRequestInput): Promise<SignedProtocolMessage> {
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
    timestamp,
  });
}

/**
 * Validates SpaceFileTreeRequest payload.
 * @param message - The SpaceFileTreeRequest message
 */
export function validateSpaceFileTreeRequestPayload(
  message: ProtocolMessageLike,
): ProtocolValidationResult {
  const { spaceFilePath, rootHash } = message.payload;

  const rules: ValidationRule[] = [
    ['rootHash is required', () => isDefined(rootHash)],
    ['spaceFilePath is required', () => isDefined(spaceFilePath)],
    [
      'rootHash should be hex string',
      () => isString(rootHash) && validateHexString(rootHash),
    ],
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
 * @param params
 * @param params.topic - Topic the message belongs
 * @param params.tree - The file path within the space.
 * @param params.lastRequestableLeaf - The specific root hash of the requested space file.
 * @param params.replyNonce - The specific root hash of the requested space file.
 * @param params.secretKey - Sender's Ed25519 secret key
 * @param params.publicKey - Sender's Ed25519 public key
 * @param params.nonce - Optional pre-generated nonce (hex)
 * @param params.timestamp - Optional timestamp override
 */
export async function createSpaceFileTreeResponseMessage({
  topic,
  tree,
  lastRequestableLeaf,
  replyNonce,
  secretKey,
  publicKey,
  nonce,
  timestamp,
}: SpaceFileTreeResponseInput): Promise<SignedProtocolMessage> {
  if (!topic) throw new Error('topic is required');
  if (!tree) throw new Error('tree is required');
  if (!Number.isInteger(lastRequestableLeaf))
    throw new Error('lastRequestableLeaf is required');
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
    timestamp,
  });
}

/**
 * Validates createSpaceFileTreeResponseMessage payload.
 * @param message - The SpaceFileTreeResponse message
 */
export function validateSpaceFileTreeResponsePayload(
  message: ProtocolMessageLike,
): ProtocolValidationResult {
  const { tree, lastRequestableLeaf, replyNonce } = message.payload;

  const rules: ValidationRule[] = [
    ['tree is required', () => isDefined(tree)],
    ['lastRequestableLeaf is required', () => isDefined(lastRequestableLeaf)],
    [
      'lastRequestableLeaf should be a number',
      () => isNumber(lastRequestableLeaf),
    ],
    ['replyNonce is required', () => isDefined(replyNonce)],
    [
      'replNonce should 24 characters string',
      () => isString(replyNonce) && replyNonce.length === 24,
    ],
    [
      'replyNonce should be valid hex string',
      () => validateHexString(replyNonce),
    ],
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
 * @param params
 * @param params.topic - Topic the message belongs
 * @param params.spaceFilePath - Virtual file path in the space.
 * @param params.leafStart - First leaf of the Merkle tree in the sequence.
 * @param params.leafStop - Last leaf of the Merkle tree in the sequence.
 * @param params.downloadKey - Request download key for stream routing.
 * @param params.secretKey - Sender's Ed25519 secret key
 * @param params.publicKey - Sender's Ed25519 public key
 * @param params.nonce - Optional pre-generated nonce (hex)
 * @param params.timestamp - Optional timestamp override
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
  timestamp,
}: SpaceFileContentRequestInput): Promise<SignedProtocolMessage> {
  if (!topic) throw new Error('topic is required');
  if (!spaceFilePath) throw new Error('spaceFilePath is required');
  if (!downloadKey) throw new Error('downloadKey is required');
  if (!Number.isInteger(leafStart))
    throw new Error('leafStart is required and should be number');
  if (!Number.isInteger(leafStop))
    throw new Error('leafStop is required and should be number');
  if (!secretKey) throw new Error('secretKey is required');
  if (!publicKey) throw new Error('publicKey is required');

  const payload = {
    spaceFilePath,
    slice: [leafStart, leafStop],
    key: downloadKey,
  };

  return await createBaseMessage({
    type: EVENTS.SpaceFileContentRequest,
    topic,
    payload: payload,
    secretKey,
    publicKey,
    nonce,
    timestamp,
  });
}

/**
 * Validates createSpaceFileContentRequestMessage payload.
 * @param message - The SpaceFileEvent message
 */
export function validateSpaceFileContentRequestPayload(
  message: ProtocolMessageLike,
): ProtocolValidationResult {
  const { spaceFilePath, slice, key } = message.payload;

  const rules: ValidationRule[] = [
    ['spaceFilePath should be a string', () => isString(spaceFilePath)],
    ['slice should be an array', () => Array.isArray(slice)],
    ['start should be an integer', () => Number.isInteger(slice[0])],
    ['stop should be an integer', () => Number.isInteger(slice[1])],
    ['key should be a string', () => isString(key)],
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
 * @param params
 * @param params.topic - Topic the message belongs
 * @param params.downloadKey - Request download key for stream routing.
 * @param params.secretKey - Sender's Ed25519 secret key
 * @param params.publicKey - Sender's Ed25519 public key
 * @param params.nonce - Optional pre-generated nonce (hex)
 * @param params.timestamp - Optional timestamp override
 */
export async function createSpaceFileContentCancelMessage(
  params: SpaceFileContentCancelInput,
): Promise<SignedProtocolMessage> {
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
    timestamp,
  });
}

/**
 * Validates SpaceFileContentCancel request.
 * @param message
 * @param message.key - the generated download task key.
 */
export function validateSpaceFileContentCancelPayload(
  message: ProtocolMessageLike,
): ProtocolValidationResult {
  const key = message.payload.key;

  if (!isString(key) || !validateHexString(key)) {
    return { isValid: false, reason: 'key should be string' };
  }

  return { isValid: true, reason: 'mesage is valid' };
}

const HEX_64_PATTERN = /^[0-9a-f]{64}$/;
const HEX_32_PATTERN = /^[0-9a-f]{32}$/;

/**
 * Creates signed Negentropy reconciliation message for one session round.
 *
 * @param params
 * @param params.topic - Space topic hash the reconciliation belongs to.
 * @param params.sessionId - 24-char hex session id, created by the initiator.
 * @param params.ranges - Ranges produced by `NegentropySync` (empty array ends the session).
 * @param params.publicKey - Sender's public key.
 * @param params.secretKey - Sender's secret key.
 * @param [params.nonce] - Optional pre-generated nonce (hex).
 * @param [params.timestamp] - Optional timestamp override.
 */
export async function createNegentropySyncMessage({
  topic,
  sessionId,
  ranges,
  publicKey,
  secretKey,
  nonce,
  timestamp,
}: NegentropySyncMessageInput): Promise<SignedProtocolMessage> {
  if (!topic) throw new Error('topic is required');
  if (!nonceIsValid(sessionId))
    throw new Error('sessionId should be 24 character hex string');
  if (!Array.isArray(ranges)) throw new Error('ranges should be an array');
  if (!secretKey) throw new Error('secretKey is required');
  if (!publicKey) throw new Error('publicKey is required');

  return await createBaseMessage({
    type: EVENTS.NegentropySync,
    topic,
    payload: { sessionId, ranges },
    secretKey,
    publicKey,
    nonce,
    timestamp,
  });
}

function isValidRangeBound(bound: ProtocolRecord): boolean {
  return (
    isObject(bound) &&
    bound !== null &&
    Number.isSafeInteger(bound.timestamp) &&
    bound.timestamp >= 0 &&
    isString(bound.messageId) &&
    HEX_64_PATTERN.test(bound.messageId)
  );
}

/**
 * Validates a single Negentropy range.
 * @param range
 * @param previousBound - Upper bound of the previous range.
 * @param isLast - True for the last range of the message.
 * @param maxIdListSize
 * @returns The failure reason, or null if the range is valid.
 */
function validateNegentropyRange(
  range: ProtocolRecord,
  previousBound: ProtocolRecord | null,
  isLast: boolean,
  maxIdListSize: number,
): string | null {
  if (!isObject(range) || range === null) return 'range should be an object';

  const { upperBound, mode } = range;

  if (upperBound === null) {
    if (!isLast) return 'only the last range can be open-ended';
  } else {
    if (!isValidRangeBound(upperBound)) return 'invalid range bound';
    if (
      previousBound &&
      !compareMessageBounds(
        previousBound as MessageBound,
        upperBound as MessageBound,
      )
    ) {
      return 'range bounds should be strictly increasing';
    }
  }

  switch (mode) {
    case EVENTS.NegentropyModeOptions.SKIP:
      return null;

    case EVENTS.NegentropyModeOptions.FINGERPRINT:
      return isString(range.fingerprint) &&
        HEX_32_PATTERN.test(range.fingerprint)
        ? null
        : 'invalid range fingerprint';

    case EVENTS.NegentropyModeOptions.ID_LIST:
    case EVENTS.NegentropyModeOptions.ID_LIST_RESPONSE:
      if (!Array.isArray(range.ids)) return 'range ids should be an array';
      if (range.ids.length > maxIdListSize) return 'range id list is too large';
      if (
        !range.ids.every(
          (id: unknown) => isString(id) && HEX_64_PATTERN.test(id),
        )
      )
        return 'invalid message id';
      return null;

    default:
      return 'unknown range mode';
  }
}

/**
 * Validates NegentropySync message payload.
 *
 * Ranges are contiguous: each range starts where the previous one ended (the first one
 * starts at -infinity) and ends at its exclusive `upperBound` (`null` = +infinity, only
 * allowed on the last range). An empty ranges list ends the session.
 *
 * @param message - The NegentropySync message.
 * @param [limits]
 * @param [limits.maxRanges=1024] - Maximum ranges per message.
 * @param [limits.maxIdListSize=4096] - Maximum message ids per range.
 */
export function validateNegentropySyncPayload(
  message: ProtocolMessageLike,
  limits: { maxRanges?: number; maxIdListSize?: number } = {},
): ProtocolValidationResult {
  const { maxRanges = 1024, maxIdListSize = 4096 } = limits;
  const payload = message.payload;

  const rules: ValidationRule[] = [
    [
      'payload should be an object',
      () => isObject(payload) && payload !== null,
    ],
    [
      'sessionId should be 24 character hex string',
      () => nonceIsValid(payload.sessionId),
    ],
    ['ranges should be an array', () => Array.isArray(payload.ranges)],
    ['too many ranges', () => payload.ranges.length <= maxRanges],
  ];

  for (const [reason, condition] of rules) {
    if (!condition()) {
      return { isValid: false, reason };
    }
  }

  let previousBound = null;
  for (let index = 0; index < payload.ranges.length; index++) {
    const range = payload.ranges[index];
    const isLast = index === payload.ranges.length - 1;

    const reason = validateNegentropyRange(
      range,
      previousBound,
      isLast,
      maxIdListSize,
    );
    if (reason) {
      return { isValid: false, reason };
    }

    previousBound = range.upperBound;
  }

  return { isValid: true, reason: 'message is valid' };
}

const HEX_128_PATTERN = /^[0-9a-f]{128}$/;

const isPlainObject = (item: unknown): boolean =>
  isObject(item) && item !== null && !Array.isArray(item);

/**
 * Builds the exact string a base message is signed over (`canonicalStringify` of the
 * unsigned message) from its header fields and the canonical JSON of its payload.
 *
 * RFC 8785 sorts the keys (nonce, payload, publicKey, timestamp, topic, type) and
 * serializes primitives like `JSON.stringify`, so splicing the already canonical payload
 * gives byte-identical output without parsing or re-serializing the payload.
 *
 * @param header
 * @param canonicalPayload - Canonical JSON of the payload (as stored in the messages table).
 */
export function buildCanonicalMessageString(
  {
    type,
    topic,
    publicKey,
    nonce,
    timestamp,
  }: {
    type: string;
    topic: string;
    publicKey: string;
    nonce: string;
    timestamp: number;
  },
  canonicalPayload: string,
): string {
  return (
    '{"nonce":' +
    JSON.stringify(nonce) +
    ',"payload":' +
    canonicalPayload +
    ',"publicKey":' +
    JSON.stringify(publicKey) +
    ',"timestamp":' +
    JSON.stringify(timestamp) +
    ',"topic":' +
    JSON.stringify(topic) +
    ',"type":' +
    JSON.stringify(type) +
    '}'
  );
}

/**
 * Verifies a message signature from its header and canonical payload, without
 * materializing (or re-serializing) the payload object.
 * The header fields must be validated beforehand (hex keys, integer timestamp).
 * @param header
 * @param canonicalPayload
 * @param signature - 128-char hex signature.
 */
export async function verifyCanonicalMessageSignature(
  header: {
    type: string;
    topic: string;
    publicKey: string;
    nonce: string;
    timestamp: number;
  },
  canonicalPayload: string,
  signature: string,
): Promise<boolean> {
  try {
    return await verifySignedString(
      buildCanonicalMessageString(header, canonicalPayload),
      signature,
      header.publicKey,
    );
  } catch (error) {
    return false;
  }
}

/**
 * Converts a stored message row into the form carried by `NegentropyContentDelivery`.
 * The canonical payload string is forwarded as-is: the provider never parses it.
 * The topic is not repeated: it is the topic of the carrying message.
 * @param record - Row of the messages table.
 */
export function toDeliverableMessage(
  record: StoredMessageLike,
): DeliveredMessage {
  return {
    type: record.type,
    publicKey: record.ownerPublicKey,
    nonce: record.nonce,
    timestamp: record.messageTimestamp,
    signature: record.signature,
    canonicalPayload: record.payload,
  };
}

/**
 * Network-wide id of a delivered message (same derivation as stored records).
 * @param message
 */
export function computeDeliveredMessageId(
  message: Pick<
    DeliveredMessage,
    'type' | 'publicKey' | 'nonce' | 'timestamp' | 'canonicalPayload'
  >,
): string {
  return computeMessageId({
    type: message.type,
    publicKey: message.publicKey,
    timestamp: message.timestamp,
    nonce: message.nonce,
    payload: message.canonicalPayload,
  });
}

/**
 * Verifies the original author's signature of a delivered message.
 * @param topic - Topic of the carrying message (the space topic).
 * @param message - Delivered message, see `toDeliverableMessage`.
 */
export function verifyDeliveredMessage(
  topic: string,
  message: DeliveredMessage,
): Promise<boolean> {
  return verifyCanonicalMessageSignature(
    {
      type: message.type,
      topic,
      publicKey: message.publicKey,
      nonce: message.nonce,
      timestamp: message.timestamp,
    },
    message.canonicalPayload,
    message.signature,
  );
}

/**
 * Creates a signed request for message contents (client -> provider).
 * @param params
 * @param params.topic - Space topic hash.
 * @param params.assignmentKey - 24-char hex key of the scheduler assignment.
 * @param params.messageIds - Requested message ids.
 * @param params.publicKey - Sender's public key.
 * @param params.secretKey - Sender's secret key.
 * @param [params.nonce] - Optional pre-generated nonce (hex).
 * @param [params.timestamp] - Optional timestamp override.
 */
export async function createNegentropyContentRequestMessage({
  topic,
  assignmentKey,
  messageIds,
  publicKey,
  secretKey,
  nonce,
  timestamp,
}: NegentropyContentRequestInput): Promise<SignedProtocolMessage> {
  if (!topic) throw new Error('topic is required');
  if (!nonceIsValid(assignmentKey))
    throw new Error('assignmentKey should be 24 character hex string');
  if (!Array.isArray(messageIds) || messageIds.length === 0)
    throw new Error('messageIds should be a non-empty array');
  if (!secretKey) throw new Error('secretKey is required');
  if (!publicKey) throw new Error('publicKey is required');

  return await createBaseMessage({
    type: EVENTS.NegentropyContentRequest,
    topic,
    payload: { assignmentKey, messageIds },
    secretKey,
    publicKey,
    nonce,
    timestamp,
  });
}

/**
 * Validates NegentropyContentRequest payload.
 * @param message
 * @param [limits]
 * @param [limits.maxIds=4096] - Maximum message ids per request.
 */
export function validateNegentropyContentRequestPayload(
  message: ProtocolMessageLike,
  limits: { maxIds?: number } = {},
): ProtocolValidationResult {
  const { maxIds = 4096 } = limits;
  const payload = message.payload;

  const rules: ValidationRule[] = [
    ['payload should be an object', () => isPlainObject(payload)],
    [
      'assignmentKey should be 24 character hex string',
      () => nonceIsValid(payload.assignmentKey),
    ],
    ['messageIds should be an array', () => Array.isArray(payload.messageIds)],
    ['messageIds should not be empty', () => payload.messageIds.length > 0],
    ['too many message ids', () => payload.messageIds.length <= maxIds],
    [
      'invalid message id',
      () =>
        payload.messageIds.every(
          (id: unknown) => isString(id) && HEX_64_PATTERN.test(id),
        ),
    ],
  ];

  for (const [reason, condition] of rules) {
    if (!condition()) {
      return { isValid: false, reason };
    }
  }

  return { isValid: true, reason: 'message is valid' };
}

/**
 * Creates a signed cancellation of an assignment. It travels in both directions:
 * - client -> provider: stop delivering (the assignment was reclaimed).
 * - provider -> client: these messages cannot be delivered (no longer available).
 *
 * @param params
 * @param params.topic - Space topic hash.
 * @param params.assignmentKey - Key of the cancelled assignment.
 * @param [params.messageIds] - Only cancel these ids; omitted cancels the whole assignment.
 * @param params.publicKey - Sender's public key.
 * @param params.secretKey - Sender's secret key.
 * @param [params.nonce] - Optional pre-generated nonce (hex).
 * @param [params.timestamp] - Optional timestamp override.
 */
export async function createNegentropyContentCancelMessage({
  topic,
  assignmentKey,
  messageIds,
  publicKey,
  secretKey,
  nonce,
  timestamp,
}: NegentropyContentCancelInput): Promise<SignedProtocolMessage> {
  if (!topic) throw new Error('topic is required');
  if (!nonceIsValid(assignmentKey))
    throw new Error('assignmentKey should be 24 character hex string');
  if (
    messageIds !== undefined &&
    (!Array.isArray(messageIds) || messageIds.length === 0)
  ) {
    throw new Error('messageIds should be a non-empty array when provided');
  }
  if (!secretKey) throw new Error('secretKey is required');
  if (!publicKey) throw new Error('publicKey is required');

  const payload =
    messageIds === undefined
      ? { assignmentKey }
      : { assignmentKey, messageIds };

  return await createBaseMessage({
    type: EVENTS.NegentropyContentCancel,
    topic,
    payload,
    secretKey,
    publicKey,
    nonce,
    timestamp,
  });
}

/**
 * Validates NegentropyContentCancel payload.
 * @param message
 * @param [limits]
 * @param [limits.maxIds=4096] - Maximum message ids per cancellation.
 */
export function validateNegentropyContentCancelPayload(
  message: ProtocolMessageLike,
  limits: { maxIds?: number } = {},
): ProtocolValidationResult {
  const { maxIds = 4096 } = limits;
  const payload = message.payload;
  const isPartial = () => payload.messageIds !== undefined;

  const rules: ValidationRule[] = [
    ['payload should be an object', () => isPlainObject(payload)],
    [
      'assignmentKey should be 24 character hex string',
      () => nonceIsValid(payload.assignmentKey),
    ],
    [
      'messageIds should be an array',
      () => !isPartial() || Array.isArray(payload.messageIds),
    ],
    [
      'messageIds should not be empty',
      () => !isPartial() || payload.messageIds.length > 0,
    ],
    [
      'too many message ids',
      () => !isPartial() || payload.messageIds.length <= maxIds,
    ],
    [
      'invalid message id',
      () =>
        !isPartial() ||
        payload.messageIds.every(
          (id: unknown) => isString(id) && HEX_64_PATTERN.test(id),
        ),
    ],
  ];

  for (const [reason, condition] of rules) {
    if (!condition()) {
      return { isValid: false, reason };
    }
  }

  return { isValid: true, reason: 'message is valid' };
}

/**
 * Creates a signed delivery of ONE stored message for an assignment (provider -> client).
 * Messages are delivered one per frame, so neither side holds more than one payload at a time.
 * @param params
 * @param params.topic - Space topic hash.
 * @param params.assignmentKey - Key of the assignment being served.
 * @param params.content - The delivered message, see `toDeliverableMessage`.
 * @param params.publicKey - Sender's public key.
 * @param params.secretKey - Sender's secret key.
 * @param [params.nonce] - Optional pre-generated nonce (hex).
 * @param [params.timestamp] - Optional timestamp override.
 */
export async function createNegentropyContentDeliveryMessage({
  topic,
  assignmentKey,
  content,
  publicKey,
  secretKey,
  nonce,
  timestamp,
}: NegentropyContentDeliveryInput): Promise<
  SignedProtocolMessage<{ assignmentKey: string; content: DeliveredMessage }>
> {
  if (!topic) throw new Error('topic is required');
  if (!nonceIsValid(assignmentKey))
    throw new Error('assignmentKey should be 24 character hex string');
  if (!isPlainObject(content)) throw new Error('content should be an object');
  if (!secretKey) throw new Error('secretKey is required');
  if (!publicKey) throw new Error('publicKey is required');

  return await createBaseMessage({
    type: EVENTS.NegentropyContentDelivery,
    topic,
    payload: { assignmentKey, content },
    secretKey,
    publicKey,
    nonce,
    timestamp,
  });
}

/**
 * Validates NegentropyContentDelivery payload (structure only, the author's signature
 * of the content is checked separately, see `verifyDeliveredMessage`).
 * @param message
 */
export function validateNegentropyContentDeliveryPayload(
  message: ProtocolMessageLike,
): ProtocolValidationResult {
  const payload = message.payload;
  const content = () => payload.content;

  const rules: ValidationRule[] = [
    ['payload should be an object', () => isPlainObject(payload)],
    [
      'assignmentKey should be 24 character hex string',
      () => nonceIsValid(payload.assignmentKey),
    ],
    ['content should be an object', () => isPlainObject(content())],
    [
      'invalid content type',
      () =>
        isString(content().type) &&
        content().type.length > 0 &&
        content().type.length <= 64,
    ],
    [
      'invalid content publicKey',
      () =>
        isString(content().publicKey) &&
        HEX_64_PATTERN.test(content().publicKey),
    ],
    ['invalid content nonce', () => nonceIsValid(content().nonce)],
    ['invalid content timestamp', () => validateTimestamp(content().timestamp)],
    [
      'invalid content signature',
      () =>
        isString(content().signature) &&
        HEX_128_PATTERN.test(content().signature),
    ],
    [
      'invalid content payload',
      () =>
        isString(content().canonicalPayload) &&
        content().canonicalPayload.length > 0,
    ],
  ];

  for (const [reason, condition] of rules) {
    if (!condition()) {
      return { isValid: false, reason };
    }
  }

  return { isValid: true, reason: 'message is valid' };
}
