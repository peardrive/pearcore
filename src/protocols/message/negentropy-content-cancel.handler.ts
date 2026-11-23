import * as EVENTS from '../../constants/events.constants.js';
import type { ProtocolMessage } from '../base.js';
import type { ProtocolValidationResult } from '../../utils/protocol.utils.js';
import { validateNegentropyContentCancelPayload } from '../../utils/protocol.utils.js';
import type { ProtocolContext } from '../shared/context.js';
import { NegentropyContentBaseHandler } from './negentropy-content.base.js';

/**
 * Both sides: cancellation of an assignment (requester gave it up, or provider cannot deliver).
 */
export class NegentropyContentCancelHandler extends NegentropyContentBaseHandler {
  protected override validatePayload(
    message: ProtocolMessage<any>,
  ): ProtocolValidationResult {
    return validateNegentropyContentCancelPayload(message, this.limits);
  }

  protected override async process(ctx: ProtocolContext): Promise<void> {
    const { role, messageIds } = this.syncManager!.handleContentCancel(
      ctx.message,
    );

    this.emitProtocol(EVENTS.NegentropyContentCancel, ctx, {
      role,
      messageIds,
    });
  }
}
