import * as MESSAGES from '../../constants/messages.constants.js';
import {
  publicKeyIsAllowedToBroadcast,
  publicKeyIsAllowedToRead,
} from '../../utils/policy.utils.js';
import type { SpacePolicy } from '../../utils/policy.utils.js';
import type { ProtocolValidationResult } from '../../utils/protocol.utils.js';
import type { ProtocolContext } from './context.js';

/**
 * Which identity a space permission check applies to.
 *
 * - `sender`: the peer that delivered the message (`ctx.senderPublicKey`).
 * - `author`: the key that signed the message (`ctx.message.publicKey`).
 */
export type PermissionSubject = 'sender' | 'author';

/**
 * A single precondition of a protocol handler.
 *
 * A guard returns `null` when it passes, or the rejection reason when it fails.
 * Guards never send messages themselves: the handler decides what to do with
 * the result and calls its `reject` helper.
 */
export type Guard = (
  ctx: ProtocolContext,
) => string | null | Promise<string | null>;

/** Returns the public key a permission check must evaluate. */
function subjectKey(ctx: ProtocolContext, subject: PermissionSubject): string {
  return subject === 'sender' ? ctx.senderPublicKey : ctx.message.publicKey;
}

/**
 * Rejects messages that a peer tries to relay on behalf of another author.
 * The transport sender must be the same key that signed the message.
 */
export const notRelayed: Guard = (ctx) =>
  ctx.message.publicKey === ctx.senderPublicKey
    ? null
    : MESSAGES.NO_RELAY_MESSAGE;

/**
 * Creates a guard from a protocol payload validator.
 *
 * @param validate - Validator that inspects the message payload.
 * @returns A guard that yields the validator's reason when the payload is invalid.
 */
export const validPayload =
  (validate: (message: any) => ProtocolValidationResult): Guard =>
  (ctx) => {
    const { isValid, reason } = validate(ctx.message);
    return isValid ? null : reason;
  };

/**
 * Checks that an identity is allowed to read a space.
 *
 * @param space - Resolved space record; the handler chooses how to resolve it.
 * @param subject - Identity to check. Defaults to the transport sender.
 * @returns A guard that rejects with the read permission message when denied.
 */
export const canRead =
  (space: SpacePolicy, subject: PermissionSubject = 'sender'): Guard =>
  (ctx) =>
    publicKeyIsAllowedToRead(subjectKey(ctx, subject), space)
      ? null
      : MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE;

/**
 * Checks that an identity is allowed to broadcast into a space.
 *
 * @param space - Resolved space record; the handler chooses how to resolve it.
 * @param subject - Identity to check. Defaults to the message author.
 * @returns A guard that rejects with the broadcast permission message when denied.
 */
export const canBroadcast =
  (space: SpacePolicy, subject: PermissionSubject = 'author'): Guard =>
  (ctx) =>
    publicKeyIsAllowedToBroadcast(subjectKey(ctx, subject), space)
      ? null
      : MESSAGES.BROADCAST_PERMISSION_NOT_ALLOWED_MESSAGE;

/**
 * Creates a guard from an asynchronous signature or membership check.
 *
 * @param check - Returns true when the condition holds.
 * @param reason - Rejection reason sent when the check fails.
 * @returns A guard that yields `reason` on failure.
 */
export const verified =
  (check: (ctx: ProtocolContext) => Promise<boolean>, reason: string): Guard =>
  async (ctx) =>
    (await check(ctx)) ? null : reason;
