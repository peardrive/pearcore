import { EventEmitter } from 'node:events';
import { SocketManager } from './sockets.manager.js';
import { SessionManager } from './session.manager.js';
import { MessageManager } from './message.manager.js';
import { ProtocolMapFactory } from '../protocols/map.js';
import { ThrottleManager } from './throttle.manager.js';
import { ConnectionManager } from './connection.manager.js';
import { MuxManager, FrameTypes } from './multiplexer.manager.js';
import { DatabaseSpaceResolver } from './space.resolver.js';
import {
  SpaceFileListManager,
  SpaceFileManager,
} from './files/files.manager.js';
import { NegentropySyncManager } from './negentropy/negentropy.manager.js';
import type { PeerNetworkFactory } from '../types/peer-network.js';

export interface ManagerOptions {
  /**
   * Optional peer network used by the connection manager.
   * Defaults to HyperDHT/Hyperswarm.
   */
  peerNetworkFactory?: PeerNetworkFactory;
}

export function initializeManagers(
  emitter: any = new EventEmitter(),
  options: ManagerOptions = {},
) {
  const sessionManager = new SessionManager();
  const socketManager = new SocketManager();
  const spaceResolver = new DatabaseSpaceResolver(sessionManager);
  const muxManager = new MuxManager(emitter, { sessionManager });

  const spaceFileListManager = new SpaceFileListManager(emitter, {
    sessionManager,
  });

  const throttleManager = new ThrottleManager(emitter, {
    sessionManager,
  });

  const messageManager = new MessageManager(emitter, {
    socketManager,
    sessionManager,
    throttleManager,
    muxManager,
    spaceFileListManager,
  });

  const connectionManager = new ConnectionManager(emitter, {
    sessionManager,
    socketManager,
    messageManager,
    muxManager,
    peerNetworkFactory: options.peerNetworkFactory,
  });

  const spaceFileManager = new SpaceFileManager(emitter, {
    sessionManager,
    socketManager,
    messageManager,
    connectionManager,
    spaceFileListManager,
    muxManager,
  });

  const negentropySyncManager = new NegentropySyncManager(emitter, {
    sessionManager,
    socketManager,
    messageManager,
    spaces: spaceResolver,
  });

  muxManager.setHandlers([
    {
      type: FrameTypes.JSON,
      handler: (socket, data, info) =>
        messageManager.handleIncomingMessage(socket, data, info),
    },
    {
      type: FrameTypes.STREAM,
      handler: (socket, data, info) =>
        spaceFileManager.handleIncomingStream(socket, data, info),
    },
  ]);

  const protocols = ProtocolMapFactory(emitter, {
    socket: socketManager,
    session: sessionManager,
    message: messageManager,
    spaceFileList: spaceFileListManager,
    spaceFiles: spaceFileManager,
    mux: muxManager,
    spaces: spaceResolver,
    sync: negentropySyncManager,
  });

  messageManager.setProtocolMap(protocols);

  return {
    session: sessionManager,
    sockets: socketManager,
    throttle: throttleManager,
    mux: muxManager,
    message: messageManager,
    connection: connectionManager,
    spaceFileList: spaceFileListManager,
    spaceFiles: spaceFileManager,
    spaces: spaceResolver,
    sync: negentropySyncManager,
  };
}
