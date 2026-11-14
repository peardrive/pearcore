import type { EventEmitter } from 'node:events';
import type {
  ManagedSocket,
  SocketManager,
} from '../managers/sockets.manager.js';
import {
  FrameTypes,
  type MuxManager,
  type MuxSocket,
} from '../managers/multiplexer.manager.js';
import type { FileContentDeliveryManager } from '../managers/delivery.manager.js';
import type { NegentropySyncManager } from '../managers/negentropy/negentropy.manager.js';
import type {
  SpaceFileListManager,
  SpaceFileManager,
} from '../managers/files/files.manager.js';
import type { MessageManager } from '../managers/message.manager.js';
import type { SessionManager } from '../managers/session.manager.js';
import type { Database } from '../types/database.js';
import type { SignedProtocolMessage } from '../utils/protocol.utils.js';

/** Connection details supplied with a message received from a peer. */
export interface PeerInfo {
  publicKey: Uint8Array;
  topics?: Uint8Array[];
  [key: string]: unknown;
}

/** A protocol message with its payload typed by the handler. */
export type ProtocolMessage<Payload = unknown> = SignedProtocolMessage<Payload>;

/** A socket that can send both protocol messages and multiplexed streams. */
export type ProtocolSocket = ManagedSocket & MuxSocket;

/** Managers made available to protocol handlers by initialization. */
export interface ProtocolManagers {
  session: SessionManager;
  socket: SocketManager;
  message: MessageManager;
  spaceFileList: SpaceFileListManager;
  spaceFiles?: SpaceFileManager;
  delivery?: FileContentDeliveryManager;
  mux: MuxManager;
  sync?: NegentropySyncManager;
}

/** Common base for protocol handlers. */
export class BaseProtocolHandler {
  sessionManager: SessionManager;
  socketManager: SocketManager;
  messageManager: MessageManager;
  spaceFileListManager: SpaceFileListManager;
  spaceFileManager: SpaceFileManager | undefined;
  deliveryManager: FileContentDeliveryManager | undefined;
  muxManager: MuxManager;
  syncManager: NegentropySyncManager | undefined;
  emitter: Pick<EventEmitter, 'emit'>;
  emit: EventEmitter['emit'];

  constructor(emitter: Pick<EventEmitter, 'emit'>, managers: ProtocolManagers) {
    this.sessionManager = managers.session;
    this.socketManager = managers.socket;
    this.messageManager = managers.message;
    this.spaceFileListManager = managers.spaceFileList;
    this.spaceFileManager = managers.spaceFiles;
    this.deliveryManager = managers.delivery;
    this.muxManager = managers.mux;
    this.syncManager = managers.sync;

    this.emitter = emitter;
    this.emit = (event, callback) => this.emitter.emit(event, callback);
  }

  get credentials(): { publicKey: string; secretKey: string } {
    return this.sessionManager.getCredentials() as {
      publicKey: string;
      secretKey: string;
    };
  }

  get db(): Database {
    return this.sessionManager.getDatabase().db as Database;
  }

  async sendStreamToSocket(
    stream: Buffer | string,
    socket: ProtocolSocket,
  ): Promise<void> {
    await this.muxManager.send(socket, stream, FrameTypes.STREAM);
  }

  async handle(
    _socket: ProtocolSocket,
    _message: ProtocolMessage,
    _info: PeerInfo,
  ): Promise<void> {
    throw new Error('Handle method must be implemented by subclass');
  }
}
