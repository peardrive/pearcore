import * as EVENTS from '../constants/events.constants.js';
import { ProfileProtocolHandler } from './profile.protocol.js';
import { RejectionProtocolHandler } from './rejection.protocol.js';
import {
    SpaceHashListHandler,
    SpaceMessageHandler,
    SpaceSyncHandler
} from './space.protocol.js';
import {
    SpaceFileContentRequestHandler,
    SpaceFileEventHandler,
    SpaceFileTreeRequestHandler,
    SpaceFileTreeResponseHandler
} from './files.protocol.js';

export const ProtocolMapFactory = (emitter, managers) => [
    {
        type: EVENTS.Reject,
        handler: new RejectionProtocolHandler(emitter, managers)
    },
    {
        type: EVENTS.ProfileUpdate,
        handler: new ProfileProtocolHandler(emitter, managers)
    },
    {
        type: EVENTS.SpaceHashList,
        handler: new SpaceHashListHandler(emitter, managers)
    },
    {
        type: EVENTS.SpaceSync,
        handler: new SpaceSyncHandler(emitter, managers)
    },
    {
        type: EVENTS.SpaceMessage,
        handler: new SpaceMessageHandler(emitter, managers)
    },
    {
        type: EVENTS.SpaceFileEvent,
        handler: new SpaceFileEventHandler(emitter, managers)
    },
    {
        type: EVENTS.SpaceFileTreeRequest,
        handler: new SpaceFileTreeRequestHandler(emitter, managers)
    },
    {
        type: EVENTS.SpaceFileTreeResponse,
        handler: new SpaceFileTreeResponseHandler(emitter, managers)
    }, 
    {
        type: EVENTS.SpaceFileContentRequest,
        handler: new SpaceFileContentRequestHandler(emitter, managers)
    }
];