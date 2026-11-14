import { createChild } from '../logger.js';
import { hex } from '../utils/crypto.utils.js';
import { DEFAULT_CHUNK_SIZE } from '../constants/global.constants.js';
import type { SessionManager } from './session.manager.js';

const logger = createChild('MuxManager');

export const FrameTypes = {
  JSON: 0x01,
  STREAM: 0x02,
} as const;

export type FrameType = number;

export interface MuxSocket {
  destroyed: boolean;
  write(data: Buffer): boolean;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
  destroy?: () => unknown;
}

export interface MuxConnectionInfo {
  publicKey: Uint8Array;
  topics?: Uint8Array[];
  [key: string]: unknown;
}

export type MuxFrameHandler = (
  socket: MuxSocket,
  data: Buffer,
  info: MuxConnectionInfo,
) => Promise<unknown>;

export interface MuxFrameHandlerRegistration {
  type: FrameType;
  handler: MuxFrameHandler;
}

export interface MuxManagerDependencies {
  sessionManager: Pick<SessionManager, 'getMessageConfig'>;
}

export interface MuxConnectionState {
  buffer: Buffer;
  readQueue: Promise<void>;
  writeQueue: Promise<void>;
  closed: boolean;
}

/**
 * MuxManager helps to simultaneously handle streaming and message data from socket connections.
 * This class calls 'handler' callback for different data types based on the received map.
 *
 * @example
 * // Create a MuxManager instance
 * const muxManager = new MuxManager(new EventEmitter(), { sessionManager });
 *
 * muxManager.setHandlers([
 *   {
 *     type: FrameTypes.JSON,
 *     handler: (socket, data, info) => console.log('Received json data !', data);
 *   },
 *   {
 *     type: FrameTypes.STREAM,
 *     handler: (socket, data, info) => console.log('Received stream bytes !', data);
 *   }
 * ]);
 *
 * swarmInstance.on('connection', (socket, info) => {
 *   const publicKey = hex(info.publicKey);
 *   const topics = info.topics.map(t => hex(t));
 *
 *   // Route all incoming data through the muxManager
 *   socket.on('data', async buffer => {
 *     await muxManager.route(socket, buffer, info);
 *   });
 *
 *   socket.on('close', () => {
 *     muxManager.cleanup(socket, info); // free accumulated buffers for this peer
 *   });
 *
 *   socket.on('error', (err) => {
 *     muxManager.cleanup(socket, info);
 *   });
 * });
 *
 * // NOTE: multiplexer expects custom header for each message to process chunk accumulation.
 * // because of this, data should be sent using muxManager's helper function.
 *
 * // Sending a JSON message
 * async function sendJsonMessage(socket, message) {
 *   const messageStr = JSON.stringify(message);
 *   await muxManager.send(socket, messageStr, FrameTypes.JSON);
 * }
 *
 * // Sending a binary stream
 * async function sendStream(socket, buffer) {
 *   await muxManager.send(socket, buffer, FrameTypes.STREAM);
 */
export class MuxManager {
  sessionManager: MuxManagerDependencies['sessionManager'];
  frameSizeLimit: Map<number, () => number>;
  routingMap: Map<number, MuxFrameHandler>;
  connections: WeakMap<MuxSocket, MuxConnectionState>;

  constructor(_emitter: unknown, managers: MuxManagerDependencies) {
    this.sessionManager = managers.sessionManager;

    this.frameSizeLimit = new Map<number, () => number>([
      [
        FrameTypes.JSON,
        () => this.sessionManager.getMessageConfig().rawLimitSize * 1.2, // 20% tolerance
      ],
      [
        FrameTypes.STREAM,
        () => DEFAULT_CHUNK_SIZE * 1.5, // add 50% tolerance
      ],
    ]);

    /**
     * Used to route frames to data handlers.
     * FrameType => Async function
     */
    this.routingMap = new Map<number, MuxFrameHandler>();

    /**
     * Socket => { buffer, readQueue, writeQueue closed }
     */
    this.connections = new WeakMap<MuxSocket, MuxConnectionState>();
  }

  /**
   * Maps all frame types to indivisual data type handler.
   * @param handlers - List of all handlers with their frame types.
   */
  setHandlers(handlers: MuxFrameHandlerRegistration[]): void {
    for (const record of handlers) {
      this.routingMap.set(record.type, record.handler);
    }
  }

  _getState(socket: MuxSocket): MuxConnectionState {
    let state = this.connections.get(socket);

    if (!state) {
      state = {
        buffer: Buffer.alloc(0),
        readQueue: Promise.resolve(),
        writeQueue: Promise.resolve(),
        closed: false,
      };

      this.connections.set(socket, state);
    }

    return state;
  }

  /**
   * Routes and process all incoming data streams from socket connections.
   * This method will only call the handler once the incoming data in complete (all chunks has been received).
   * @param socket - The socket object.
   * @param data - Incoming buffer.
   * @param info - Hyperswarm's info object.
   */
  async route(
    socket: MuxSocket,
    data: Buffer,
    info: MuxConnectionInfo,
  ): Promise<void> {
    const state = this._getState(socket);
    if (state.closed) return Promise.resolve(); //dead end

    const publicKey = hex(info.publicKey);

    const next = state.readQueue
      .then(() => this._process(socket, data, info, publicKey, state))
      .catch((error) => {
        logger.warn(
          { publicKey, error },
          'Error processing data received data',
        );
      });

    state.readQueue = next;
    return next;
  }

  /**
   * Disconnect from the socket in case of penalty.
   * @param socket
   */
  async _penalty(socket: MuxSocket): Promise<void> {
    await socket.destroy?.();
  }

  async _process(
    socket: MuxSocket,
    data: Buffer,
    info: MuxConnectionInfo,
    publicKey: string,
    state: MuxConnectionState,
  ): Promise<void> {
    let buffer = Buffer.concat([state.buffer, data]);

    try {
      while (buffer.length >= 5) {
        const type = buffer[0]!;
        const payloadLength = buffer.readUInt32BE(1);
        const totalFrameLength = 5 + payloadLength;

        const limitResolver = this.frameSizeLimit.get(type);
        const maxFrameSize = limitResolver ? limitResolver() : undefined;

        if (maxFrameSize && payloadLength > maxFrameSize) {
          logger.warn(
            {
              type,
              maxFrameSize,
              totalFrameLength,
              publicKey,
            },
            'maximum allowed frame size has been violated',
          );

          this.cleanup(socket, info);
          await this._penalty(socket);
          return;
        }

        if (buffer.length < totalFrameLength) break;

        const payload = buffer.subarray(5, totalFrameLength);
        buffer = buffer.subarray(totalFrameLength);

        const handler = this.routingMap.get(type);
        if (handler) {
          const task = handler(socket, payload, info);

          await task.catch((error) => {
            logger.warn(
              { frameType: type, publicKey },
              'handler failed to process the data',
            );
          });
        } else {
          logger.warn(
            { frameType: type, publicKey },
            'no handler has been registered for the frameType',
          );
        }
      }
    } catch (error) {
      logger.warn({ publicKey, error }, 'failed to run _process()');
    } finally {
      if (!state.closed) {
        state.buffer = buffer;
      }
    }
  }

  /**
   * Clean and reset buffer stack for individual socket connection.
   * @param socket - The socket object.
   */
  cleanup(socket: MuxSocket, _info?: MuxConnectionInfo): void {
    const state = this.connections.get(socket);
    if (state) {
      state.closed = true;
      state.buffer = Buffer.alloc(0);
    }

    this.connections.delete(socket);
  }

  /**
   * Create frame from type and payload
   * @param type - Data type.
   * @param data - Input data.
   * @returns The encoded frame.
   */
  createFrame(type: FrameType, data: Buffer | string): Buffer {
    const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const header = Buffer.allocUnsafe(5);
    // allocate frame type (1 byte) + content length (4 bytes)
    header[0] = type;
    header.writeUInt32BE(payload.length, 1);

    return Buffer.concat([header, payload]);
  }

  /**
   * Creates a promise that is only resolved once the socket connection is safe to write.
   * this mechanism respects the socket bandwidth and avoids buffer pressure building up.
   *
   */
  _waitForDrain(socket: MuxSocket): Promise<void> {
    return new Promise<void>((resolve) => {
      const handler = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        socket.off('drain', handler);
        socket.off('close', handler);
        socket.off('error', handler);
      };

      socket.once('drain', handler);
      socket.once('close', handler);
      socket.once('error', handler);
    });
  }

  /**
   * Write buffer to socket with consideration that if the stream buffer
   * is maxxed out, then the function waits for the stream to 'drain' before resolving the promise.
   * @param socket - The destination socket.
   * @param frame - The encoded frame.
   */
  async _writeFrame(socket: MuxSocket, frame: Buffer): Promise<void> {
    if (socket.destroyed) {
      throw new Error('cannot write to a destroyed socket');
    }

    const canWriteMore = socket.write(frame);
    if (!canWriteMore) {
      await this._waitForDrain(socket);
    }
  }

  /**
   * Send framed data payload with the corrent type to the socket.
   * @param socket - The socket object.
   * @param data - The data to send for the receiver.
   * @param frameType - The data type of the data.
   * @returns Resolves when the data has successfully sent to the receiver.
   */
  async send(
    socket: MuxSocket,
    data: Buffer | string,
    frameType: FrameType,
  ): Promise<void> {
    const frame = this.createFrame(frameType, data);
    const state = this._getState(socket);

    const next = state.writeQueue.then(() => this._writeFrame(socket, frame));

    state.writeQueue = next.catch(() => {});
    return next;
  }
}
