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
import type { NegentropySyncManager } from '../managers/negentropy/negentropy.manager.js';
import type {
  SpaceFileListManager,
  SpaceFileManager,
} from '../managers/files/files.manager.js';
import type { MessageManager } from '../managers/message.manager.js';
import type { SessionManager } from '../managers/session.manager.js';
import type { SpaceResolver } from '../managers/space.resolver.js';
import type { Database } from '../types/database.js';
import type { SignedProtocolMessage } from '../utils/protocol.utils.js';
import type { SpacePolicy } from '../utils/policy.utils.js';
import { publicKeyIsAllowedToRead } from '../utils/policy.utils.js';
import { createProtocolContext } from './shared/context.js';
import type { ProtocolContext } from './shared/context.js';
import type { Guard } from './shared/guards.js';

/**
 * Connection details supplied with a message received from a peer.
 */
export interface PeerInfo {
  publicKey: Uint8Array;
  topics?: Uint8Array[];
  [key: string]: unknown;
}

/**
 * A protocol message with its payload typed by the handler.
 */
export type ProtocolMessage<Payload = unknown> = SignedProtocolMessage<Payload>;

/**
 * A socket that can send both protocol messages and multiplexed streams.
 */
export type ProtocolSocket = ManagedSocket & MuxSocket;

/**
 * Managers made available to protocol handlers by initialization.
 */
export interface ProtocolManagers {
  session: SessionManager;
  socket: SocketManager;
  message: MessageManager;
  spaceFileList: SpaceFileListManager;
  spaceFiles: SpaceFileManager;
  mux: MuxManager;
  /** Resolves space topics to local records; replaceable by a cache-backed port. */
  spaces: SpaceResolver;
  sync?: NegentropySyncManager;
}

/**
 * Outcome of running a stack of guards.
 *
 * A rejection always carries the reason that must be sent to the peer, so a
 * handler can never reject a message without one.
 */
export type EnforcementResult =
  { result: true; reason?: undefined } | { result: false; reason: string };

/**
 * Common base for protocol handlers.
 *
 * Provides per-message context construction, guard execution, and helpers for
 * replying, forwarding and emitting protocol events.
 */
export class BaseProtocolHandler {
  sessionManager: SessionManager;
  socketManager: SocketManager;
  messageManager: MessageManager;
  spaceFileListManager: SpaceFileListManager;
  spaceFileManager: SpaceFileManager;
  muxManager: MuxManager;
  spaceResolver: SpaceResolver;
  syncManager: NegentropySyncManager | undefined;
  emitter: EventEmitter;
  emit: EventEmitter['emit'];

  constructor(emitter: EventEmitter, managers: ProtocolManagers) {
    this.sessionManager = managers.session;
    this.socketManager = managers.socket;
    this.messageManager = managers.message;
    this.spaceFileListManager = managers.spaceFileList;
    this.spaceFileManager = managers.spaceFiles;
    this.muxManager = managers.mux;
    this.spaceResolver = managers.spaces;
    this.syncManager = managers.sync;

    this.emitter = emitter;
    this.emit = (event, callback) => this.emitter.emit(event, callback);
  }

  /** Public and secret keys of the local node. */
  get credentials(): { publicKey: string; secretKey: string } {
    return this.sessionManager.getCredentials() as {
      publicKey: string;
      secretKey: string;
    };
  }

  /** Database connection of the current session. */
  get db(): Database {
    return this.sessionManager.getDatabase().db as Database;
  }

  /**
   * Builds the context shared by a handler and its guards for one message.
   *
   * @param socket - Socket of the delivering peer.
   * @param message - Incoming signed message.
   * @param info - Connection details reported by the transport.
   * @returns The per-message context.
   */
  protected context(
    socket: ProtocolSocket,
    message: ProtocolMessage<any>,
    info: PeerInfo,
  ): ProtocolContext {
    return createProtocolContext(socket, message, info);
  }

  /**
   * Runs guards in order without performing side effects.
   *
   * The first failing guard stops the stack and its reason is returned, so the
   * handler can decide how to reject the message.
   *
   * @param ctx - Context of the incoming message.
   * @param guards - Guards to evaluate, in protocol-specific order.
   * @returns `{ result: true }` when all guards pass, otherwise a failure with
   * the mandatory rejection reason.
   */
  protected async enforce(
    ctx: ProtocolContext,
    guards: readonly Guard[],
  ): Promise<EnforcementResult> {
    for (const guard of guards) {
      const reason = await guard(ctx);

      if (reason !== null) {
        return { result: false, reason };
      }
    }

    return { result: true };
  }

  /**
   * Sends a rejection for the message carried by the context.
   *
   * @param ctx - Context of the message to reject.
   * @param reason - Explanation sent to the peer; always required.
   */
  protected async reject(ctx: ProtocolContext, reason: string): Promise<void> {
    await this.messageManager.reject(ctx.socket, ctx.message, reason);
  }

  /**
   * Signs a message with the local credentials and sends it to the sender.
   *
   * @param ctx - Context of the incoming message.
   * @param build - Builds the message from the local credentials.
   */
  protected async reply(
    ctx: ProtocolContext,
    build: (credentials: {
      publicKey: string;
      secretKey: string;
    }) => Promise<SignedProtocolMessage>,
  ): Promise<void> {
    const message = await build(this.credentials);
    await this.sendToSocket(ctx, message);
  }

  /**
   * Sends an already built message to the sender of the incoming message.
   *
   * @param ctx - Context of the incoming message.
   * @param message - Message to send.
   */
  protected async sendToSocket(
    ctx: ProtocolContext,
    message: SignedProtocolMessage,
  ): Promise<void> {
    await this.messageManager.sendMessageToSocket(message, ctx.socket);
  }

  /**
   * Broadcasts a message to peers that may read a space.
   *
   * The transport sender and the message author are always excluded.
   *
   * @param ctx - Context of the incoming message.
   * @param message - Message to forward.
   * @param options - Topic, permission space and additional exclusions.
   */
  protected async forward(
    ctx: ProtocolContext,
    message: SignedProtocolMessage,
    options: { topic: string; space: SpacePolicy; exclude?: string[] },
  ): Promise<unknown> {
    const excluded = new Set([
      ctx.senderPublicKey,
      ctx.message.publicKey,
      ...(options.exclude ?? []),
    ]);

    const peers = this.socketManager.getPeerKeys(
      (publicKey) =>
        publicKeyIsAllowedToRead(publicKey, options.space) &&
        !excluded.has(publicKey),
    );

    return this.forwardTo(message, peers, [options.topic]);
  }

  /**
   * Sends a message to an explicit peer and topic selection.
   *
   * @param message - Message to send.
   * @param peers - Public keys of the target peers.
   * @param topics - Topics the targets must be subscribed to.
   */
  protected async forwardTo(
    message: SignedProtocolMessage,
    peers: string[],
    topics: string[],
  ): Promise<unknown> {
    const sockets = this.socketManager.getConnectedSockets({
      peers,
      topics,
    });

    return this.messageManager.broadcastMessageToSockets(message, sockets);
  }

  /**
   * Emits a protocol event with the context consumers expect.
   *
   * @param event - Event name.
   * @param ctx - Context of the incoming message.
   * @param extra - Additional event fields.
   */
  protected emitProtocol(
    event: string,
    ctx: ProtocolContext,
    extra: Record<string, unknown> = {},
  ): void {
    this.emit(event, { info: ctx.info, message: ctx.message, ...extra });
  }

  /**
   * Sends a stream frame to a socket through the multiplexer.
   *
   * @param stream - Buffered stream data.
   * @param socket - Target socket.
   */
  async sendStreamToSocket(
    stream: Buffer | string,
    socket: ProtocolSocket,
  ): Promise<void> {
    await this.muxManager.send(socket, stream, FrameTypes.STREAM);
  }

  /**
   * Handles one protocol message. Implemented by every concrete handler.
   *
   * @param _socket - Socket of the delivering peer.
   * @param _message - Incoming signed message.
   * @param _info - Connection details reported by the transport.
   */
  async handle(
    _socket: ProtocolSocket,
    _message: ProtocolMessage,
    _info: PeerInfo,
  ): Promise<void> {
    throw new Error('Handle method must be implemented by subclass');
  }
}
