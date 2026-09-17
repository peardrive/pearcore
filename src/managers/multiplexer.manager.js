import { createChild } from '../logger.js';
import { hex } from '../utils/crypto.utils.js';
import { DEFAULT_CHUNK_SIZE } from '../constants/global.constants.js';

const logger = createChild('MuxManager');

export const FrameTypes = {
    JSON: 0x01,
    STREAM: 0x02
};

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
    constructor(emitter, managers) {
        this.sessionManager = managers.sessionManager;

        this.frameSizeLimit = new Map([
            [
                FrameTypes.JSON,
                () => this.sessionManager.getMessageConfig().rawLimitSize * 1.20 // 20% tolerance
            ],
            [
                FrameTypes.STREAM,
                () => DEFAULT_CHUNK_SIZE * 1.50 // add 50% tolerance
            ],
        ]);

        /**
         * Used to route frames to data handlers.
         * FrameType => Async function
         * @type {Map<number, Promise>}
         */
        this.routingMap = new Map();

        /**
         * Socket => { buffer, tail, closed }
         * @type {WeakMap<Object, Object>}
         */
        this.connections = new WeakMap();
    }

    /**
     * Maps all frame types to indivisual data type handler.
     * @param {Array<Object>} handlers - List of all handlers with their type.
     */
    setHandlers(handlers) {
        for (const record of handlers) {
            this.routingMap.set(record.type, record.handler);
        }
    }

    _getState(socket) {
        let state = this.connections.get(socket);

        if (!state) {
            state = { buffer: Buffer.alloc(0), tail: Promise.resolve(), closed: false };
            this.connections.set(socket, state);
        }

        return state;
    }

    /**
     * Routes and process all incoming data streams from socket connections.
     * This method will only call the handler once the incoming data in complete (all chunks has been received).
     * @param {Object} socket - The socket object.
     * @param {Buffer|string} data - Incoming buffer.
     * @param {Object} info - Hyperswarm's info object.
     */
    async route(socket, data, info) {
        const state = this._getState(socket);
        if (state.closed) return Promise.resolve(); //dead end

        const publicKey = hex(info.publicKey);

        const next = state.tail
            .then(() => this._process(socket, data, info, publicKey, state))
            .catch(error => {
                console.log('Error processing data received data', {
                    publicKey,
                    error,
                });
            });

        state.tail = next;
        return next;
    }

    /**
     * Disconnect from the socket in case of penalty.
     * @param {Socket} socket 
     */
    async _penalty(socket) {
        await socket.destroy?.();
    }

    async _process(socket, data, info, publicKey, state) {
        let buffer = Buffer.concat([state.buffer, data]);

        try {
            while (buffer.length >= 5) {
                const type = buffer[0];
                const payloadLength = buffer.readUInt32BE(1);
                const totalFrameLength = 5 + payloadLength;

                const limitResolver = this.frameSizeLimit.get(type);
                const maxFrameSize = limitResolver ? limitResolver() : undefined;

                if (maxFrameSize && payloadLength > maxFrameSize) {
                    console.log('maximum allowed frame size has been violated', {
                        type: type,
                        maxFrameSize: maxFrameSize,
                        totalFrameLength: totalFrameLength,
                        publicKey: publicKey
                    });

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

                    await task
                        .catch(error => {
                            console.log('handler failed to process the data', {
                                frameType: type,
                                publicKey: publicKey
                            });

                        });

                } else {
                    console.log('no handler has been registered for the frameType', {
                        frameType: type,
                        publicKey: publicKey
                    });
                }
            }
        } catch (error) {
            console.log('failed to run _process()', {
                publicKey: publicKey,
                error: error
            });
        } finally {
            if (!state.closed) {
                state.buffer = buffer;
            }
        }
    }

    /**
     * Clean and reset buffer stack for individual socket connection.
     * @param {Object} socket - The socket object.
     */
    cleanup(socket) {
        const state = this.connections.get(socket);
        if (state) {
            state.closed = true;
            state.buffer = Buffer.alloc(0);
        }

        this.connections.delete(socket);
    }

    /**
     * Create frame from type and payload
     * @param {number} type - Data type.
     * @param {Buffer|string} data - Input data.
     * @returns {Buffer}
     */
    createFrame(type, data) {
        const payload = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
        const header = Buffer.allocUnsafe(5);
        // allocate frame type (1 byte) + content length (4 bytes)
        header[0] = type;
        header.writeUInt32BE(payload.length, 1);

        return Buffer.concat([header, payload]);
    }

    /**
     * Send framed data payload with the corrent type to the socket.
     * @param {Object} socket - The socket object.
     * @param {Buffer|string} data - The data to send for the receiver.
     * @param {number} frameType - The data type of the data.
     * @returns {Promise<void>} - Resolves when the data has successfully sent to the receiver.
     */
    async send(socket, data, frameType) {
        const frame = this.createFrame(frameType, data);
        return socket.write(frame);
    }
}