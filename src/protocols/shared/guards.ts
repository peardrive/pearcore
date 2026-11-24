import * as MESSAGES from '../../constants/messages.constants.js';
import {
  publicKeyIsAllowedToBroadcast,
  publicKeyIsAllowedToRead,
} from '../../utils/policy.utils.js';
import type { SpacePolicy } from '../../utils/policy.utils.js';
import type { ProtocolValidationResult } from '../../utils/protocol.utils.js';
import { hex } from '../../utils/crypto.utils.js';
import type { SocketManager } from '../../managers/sockets.manager.js';
import type { ProtocolContext } from './context.js';

/**
 * Which identity a space permission check applies to.
 *
 * - `sender`: the peer that delivered the message (`ctx.senderPublicKey`).
 * - `author`: the key that signed the message (`ctx.message.publicKey`).
 */
export type PermissionSubject = 'sender' | 'author';

/**
 * The outcome of a single guard.
 *
 * `null` means the guard passed. Any string is the reason the message must be
 * rejected.
 */
export type GuardResult = string | null;

/**
 * A single precondition of a protocol handler.
 *
 * Guards never send messages themselves: the handler decides what to do with
 * the result and calls its `reject` helper.
 */
export type Guard = (
  ctx: ProtocolContext,
) => GuardResult | Promise<GuardResult>;

/**
 * Payload validator accepted by {@link validPayload}.
 */
export type PayloadValidator = (message: any) => ProtocolValidationResult;

/**
 * Resolves the topic a subscription check should evaluate for a message.
 */
export type TopicResolver = (ctx: ProtocolContext) => string;

/** Returns the public key a permission check must evaluate. */
function subjectKey(ctx: ProtocolContext, subject: PermissionSubject): string {
  if (subject === 'sender') {
    return ctx.senderPublicKey;
  }

  return ctx.message.publicKey;
}

/** Returns true when the selected identity may read the space. */
function isReadAllowed(
  ctx: ProtocolContext,
  space: SpacePolicy,
  subject: PermissionSubject,
): boolean {
  return publicKeyIsAllowedToRead(subjectKey(ctx, subject), space);
}

/** Returns true when the selected identity may broadcast into the space. */
function isBroadcastAllowed(
  ctx: ProtocolContext,
  space: SpacePolicy,
  subject: PermissionSubject,
): boolean {
  return publicKeyIsAllowedToBroadcast(subjectKey(ctx, subject), space);
}

/**
 * Rejects messages that a peer tries to relay on behalf of another author.
 * The transport sender must be the same key that signed the message.
 *
 * @param ctx - Context of the incoming message.
 * @returns The rejection reason, or `null` when the message is not relayed.
 */
export function notRelayed(ctx: ProtocolContext): GuardResult {
  const authoredBySender = ctx.message.publicKey === ctx.senderPublicKey;

  if (authoredBySender) {
    return null;
  }

  return MESSAGES.NO_RELAY_MESSAGE;
}

/**
 * Checks that the delivering peer is subscribed to a topic.
 *
 * Two sources are consulted because neither is complete on its own:
 *
 * - the connection reports the topics it was established over, which covers
 *   peers that joined a space topic before they knew the space;
 * - the socket registry carries the topics the peer announced through the
 *   space hash-list handshake.
 *
 * @param socketManager - Registry that tracks peers and their announced topics.
 * @param topic - Resolves the topic to check. Defaults to the message topic.
 * @returns A guard that rejects peers that are not subscribed to the topic.
 */
export function subscribed(
  socketManager: SocketManager,
  topic: TopicResolver = (ctx) => ctx.message.topic,
): Guard {
  return function subscribedGuard(ctx: ProtocolContext): GuardResult {
    const expectedTopic = topic(ctx);
    const connectionTopics = (ctx.info.topics ?? []).map((item) => hex(item));

    if (connectionTopics.includes(expectedTopic)) {
      return null;
    }

    let announcedTopics: string[];

    try {
      announcedTopics = socketManager.getPeerInfoBySocket(ctx.socket).topics;
    } catch {
      announcedTopics = [];
    }

    if (announcedTopics.includes(expectedTopic)) {
      return null;
    }

    return MESSAGES.NOT_SUBSCRIBED_MESSAGE;
  };
}

/**
 * Creates a guard from a protocol payload validator.
 *
 * @param validate - Validator that inspects the message payload.
 * @returns A guard that yields the validator's reason when the payload is invalid.
 */
export function validPayload(validate: PayloadValidator): Guard {
  return function payloadGuard(ctx: ProtocolContext): GuardResult {
    const validation = validate(ctx.message);

    if (validation.isValid) {
      return null;
    }

    return validation.reason;
  };
}

/**
 * Checks that an identity is allowed to read a space.
 *
 * @param space - Resolved space record; the handler chooses how to resolve it.
 * @param subject - Identity to check. Defaults to the transport sender.
 * @returns A guard that rejects with the read permission message when denied.
 */
export function canRead(
  space: SpacePolicy,
  subject: PermissionSubject = 'sender',
): Guard {
  return function readGuard(ctx: ProtocolContext): GuardResult {
    if (isReadAllowed(ctx, space, subject)) {
      return null;
    }

    return MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE;
  };
}

/**
 * Checks that an identity is allowed to broadcast into a space.
 *
 * @param space - Resolved space record; the handler chooses how to resolve it.
 * @param subject - Identity to check. Defaults to the message author.
 * @returns A guard that rejects with the broadcast permission message when denied.
 */
export function canBroadcast(
  space: SpacePolicy,
  subject: PermissionSubject = 'author',
): Guard {
  return function broadcastGuard(ctx: ProtocolContext): GuardResult {
    if (isBroadcastAllowed(ctx, space, subject)) {
      return null;
    }

    return MESSAGES.BROADCAST_PERMISSION_NOT_ALLOWED_MESSAGE;
  };
}

/**
 * Creates a guard from an asynchronous signature or membership check.
 *
 * @param check - Returns true when the condition holds.
 * @param reason - Rejection reason sent when the check fails.
 * @returns A guard that yields `reason` on failure.
 */
export function verified(
  check: (ctx: ProtocolContext) => Promise<boolean>,
  reason: string,
): Guard {
  return async function verifiedGuard(
    ctx: ProtocolContext,
  ): Promise<GuardResult> {
    const passed = await check(ctx);

    if (passed) {
      return null;
    }

    return reason;
  };
}
