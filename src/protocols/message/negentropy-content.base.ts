import * as MESSAGES from '../../constants/messages.constants.js';
import { BaseProtocolHandler } from '../base.js';
import type { PeerInfo, ProtocolMessage, ProtocolSocket } from '../base.js';
import type { SpaceWithWhitelists } from '../../utils/space.utils.js';
import type { ProtocolValidationResult } from '../../utils/protocol.utils.js';
import type { ProtocolContext } from '../shared/context.js';
import { canRead, notRelayed, validPayload } from '../shared/guards.js';

/**
 * Shared checks of the message-sync handlers: no relaying, a valid payload, a known
 * space and a sender allowed to read it. Subclasses implement `validatePayload` and
 * `process`.
 */
export abstract class NegentropyContentBaseHandler extends BaseProtocolHandler {
  /** Limits applied to content payloads of this session. */
  protected get limits(): { maxIds: number } {
    const { maxIdListSize } =
      this.sessionManager.getMessageConfig().reconciliation;
    return { maxIds: maxIdListSize };
  }

  /**
   * @param message - The protocol message to validate.
   * @returns The payload validation result.
   */
  protected abstract validatePayload(
    message: ProtocolMessage<any>,
  ): ProtocolValidationResult;

  /**
   * @param ctx - Sender and message context.
   * @param spaceId - The resolved local space id.
   * @param space - The resolved space record.
   */
  protected abstract process(
    ctx: ProtocolContext,
    spaceId: number,
    space: SpaceWithWhitelists,
  ): Promise<void>;

  override async handle(
    socket: ProtocolSocket,
    message: ProtocolMessage<any>,
    info: PeerInfo,
  ): Promise<void> {
    const ctx = this.context(socket, message, info);

    const space = await this.spaceResolver.resolve(message.topic);
    if (!space) {
      await this.reject(ctx, MESSAGES.SPACE_NOT_FOUND_MESSAGE);
      return;
    }

    const { result, reason } = await this.enforce(ctx, [
      notRelayed,
      validPayload((payload) => this.validatePayload(payload)),
      canRead(space, 'sender'),
    ]);

    if (!result) {
      await this.reject(ctx, reason);
      return;
    }

    await this.process(ctx, space.id, space);
  }
}
