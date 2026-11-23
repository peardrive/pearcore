import * as EVENTS from '../../constants/events.constants.js';
import type { ProtocolMessage } from '../base.js';
import type { ProtocolValidationResult } from '../../utils/protocol.utils.js';
import { validateNegentropyContentRequestPayload } from '../../utils/protocol.utils.js';
import type { ProtocolContext } from '../shared/context.js';
import { NegentropyContentBaseHandler } from './negentropy-content.base.js';

/**
 * Provider side: a peer requests the contents of messages it is missing.
 * The delivery runs in the background; it is not awaited.
 */
export class NegentropyContentRequestHandler extends NegentropyContentBaseHandler {
  protected override validatePayload(
    message: ProtocolMessage<any>,
  ): ProtocolValidationResult {
    return validateNegentropyContentRequestPayload(message, this.limits);
  }

  protected override async process(
    ctx: ProtocolContext,
    spaceId: number,
  ): Promise<void> {
    this.emitProtocol(EVENTS.NegentropyContentRequest, ctx);
    this.syncManager!.serveContentRequest(ctx.socket, ctx.message, spaceId);
  }
}
