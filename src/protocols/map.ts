import type { EventEmitter } from 'node:events';
import * as EVENTS from '../constants/events.constants.js';
import type { BaseProtocolHandler, ProtocolManagers } from './base.js';
import { ProfileProtocolHandler } from './profile/update.handler.js';
import { RejectionProtocolHandler } from './rejection/reject.handler.js';
import { SpaceHashListHandler } from './space/hash-list.handler.js';
import { SpaceSyncHandler } from './space/sync.handler.js';
import { SpaceMessageHandler } from './message/space-message.handler.js';
import { NegentropySyncHandler } from './message/negentropy-sync.handler.js';
import { NegentropyContentRequestHandler } from './message/negentropy-content-request.handler.js';
import { NegentropyContentCancelHandler } from './message/negentropy-content-cancel.handler.js';
import { NegentropyContentDeliveryHandler } from './message/negentropy-content-delivery.handler.js';
import { SpaceFileEventHandler } from './files/file-event.handler.js';
import { SpaceFileTreeRequestHandler } from './files/tree-request.handler.js';
import { SpaceFileTreeResponseHandler } from './files/tree-response.handler.js';
import { SpaceFileContentRequestHandler } from './files/content-request.handler.js';
import { SpaceFileContentCancelHandler } from './files/content-cancel.handler.js';

export interface ProtocolMapEntry {
  type: string;
  handler: BaseProtocolHandler;
}

type HandlerConstructor = new (
  emitter: EventEmitter,
  managers: ProtocolManagers,
) => BaseProtocolHandler;

/** Every protocol type served by this node, and the handler that owns it. */
const PROTOCOL_HANDLERS: Record<string, HandlerConstructor> = {
  [EVENTS.Reject]: RejectionProtocolHandler,
  [EVENTS.ProfileUpdate]: ProfileProtocolHandler,
  [EVENTS.SpaceHashList]: SpaceHashListHandler,
  [EVENTS.SpaceSync]: SpaceSyncHandler,
  [EVENTS.SpaceMessage]: SpaceMessageHandler,
  [EVENTS.NegentropySync]: NegentropySyncHandler,
  [EVENTS.NegentropyContentRequest]: NegentropyContentRequestHandler,
  [EVENTS.NegentropyContentDelivery]: NegentropyContentDeliveryHandler,
  [EVENTS.NegentropyContentCancel]: NegentropyContentCancelHandler,
  [EVENTS.SpaceFileEvent]: SpaceFileEventHandler,
  [EVENTS.SpaceFileTreeRequest]: SpaceFileTreeRequestHandler,
  [EVENTS.SpaceFileTreeResponse]: SpaceFileTreeResponseHandler,
  [EVENTS.SpaceFileContentRequest]: SpaceFileContentRequestHandler,
  [EVENTS.SpaceFileContentCancel]: SpaceFileContentCancelHandler,
};

export const ProtocolMapFactory = (
  emitter: EventEmitter,
  managers: ProtocolManagers,
): ProtocolMapEntry[] =>
  Object.entries(PROTOCOL_HANDLERS).map(([type, Handler]) => ({
    type,
    handler: new Handler(emitter, managers),
  }));
