import * as EVENTS from '../../constants/events.constants.js';
import type { ProtocolMessage } from '../base.js';
import type { SpaceWithWhitelists } from '../../utils/space.utils.js';
import type { ProtocolValidationResult } from '../../utils/protocol.utils.js';
import { validateNegentropyContentDeliveryPayload } from '../../utils/protocol.utils.js';
import type { ProtocolContext } from '../shared/context.js';
import { NegentropyContentBaseHandler } from './negentropy-content.base.js';

/**
 * Requester side: messages delivered for one of our assignments.
 */
export class NegentropyContentDeliveryHandler extends NegentropyContentBaseHandler {
  protected override validatePayload(
    message: ProtocolMessage<any>,
  ): ProtocolValidationResult {
    return validateNegentropyContentDeliveryPayload(message);
  }

  protected override async process(
    ctx: ProtocolContext,
    spaceId: number,
    space: SpaceWithWhitelists,
  ): Promise<void> {
    const { messageId, status } = await this.syncManager!.acceptContentDelivery(
      ctx.message,
      spaceId,
      space,
    );

    this.emitProtocol(EVENTS.NegentropyContentDelivery, ctx, {
      messageId,
      status,
    });
  }
}
