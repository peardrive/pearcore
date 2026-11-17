import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  MuxManager,
  FrameTypes,
} from '../../../src/managers/multiplexer.manager.js';
import type {
  MuxConnectionInfo,
  MuxFrameHandler,
} from '../../../src/managers/multiplexer.manager.js';
import { getMockSocket } from '../../helpers/general.utils.js';
import { EventEmitter } from 'node:stream';
import { SessionManager } from '../../../src/managers/session.manager.js';

describe('MuxManager', () => {
  let muxManager: MuxManager;
  let socket: ReturnType<typeof getMockSocket>;
  let info: MuxConnectionInfo;

  beforeEach(() => {
    const emitter = new EventEmitter();
    const sessionManager = new SessionManager();
    muxManager = new MuxManager(emitter, { sessionManager });
    socket = getMockSocket();
    info = {
      publicKey: Buffer.from('mockPublicKey123'),
    };
  });

  describe('send', () => {
    it('should send JSON data with correct format', async () => {
      const data = JSON.stringify({ foo: 'bar' });
      await muxManager.send(socket, data, FrameTypes.JSON);

      expect(socket.write).toBeCalled();

      // frame: <type 1-byte> <length 4-bytes> <payload ..>
      const frame = (socket.write.mock.calls as unknown as [Buffer][])[0]![0];
      expect(frame[0]).toBe(FrameTypes.JSON);

      const payloadLength = frame.readUInt32BE(1);
      expect(payloadLength).toBe(Buffer.byteLength(data, 'utf8'));

      // <type + length 5-bytes> <payload ..>
      const payload = frame.subarray(5).toString('utf8');
      expect(payload).toBe(data);
    });

    it('should send binary stream data with correct frame format', async () => {
      const bufferData = Buffer.from([0x01, 0x02, 0x03]);
      await muxManager.send(socket, bufferData, FrameTypes.STREAM);

      expect(socket.write).toBeCalled();

      const frame = (socket.write.mock.calls as unknown as [Buffer][])[0]![0];
      expect(frame[0]).toBe(FrameTypes.STREAM);
      expect(frame.readUInt32BE(1)).toBe(3);
      expect(frame.subarray(5)).toEqual(bufferData);
    });
  });

  describe('route', () => {
    let jsonHandler: ReturnType<typeof vi.fn>;
    let streamHandler: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      jsonHandler = vi.fn(async () => {});
      streamHandler = vi.fn(async () => {});
      muxManager.setHandlers([
        {
          type: FrameTypes.JSON,
          handler: jsonHandler as unknown as MuxFrameHandler,
        },
        {
          type: FrameTypes.STREAM,
          handler: streamHandler as unknown as MuxFrameHandler,
        },
      ]);
    });

    it('should route a complete JSON frame and call the JSON handler', async () => {
      const payload = JSON.stringify({ foo: 'bar' });
      const frame = muxManager.createFrame(FrameTypes.JSON, payload);
      await muxManager.route(socket, frame, info);

      expect(jsonHandler).toBeCalled();
      expect(jsonHandler).toHaveBeenCalledWith(
        socket,
        Buffer.from(payload),
        info,
      );
      expect(streamHandler).not.toHaveBeenCalled();
    });

    it('should route a complete STREAM frame and call the stream handler', async () => {
      const payload = Buffer.from([0x01, 0x02, 0x03]);
      const frame = muxManager.createFrame(FrameTypes.STREAM, payload);
      await muxManager.route(socket, frame, info);

      expect(streamHandler).toHaveBeenCalled();
      expect(streamHandler).toHaveBeenCalledWith(socket, payload, info);
      expect(jsonHandler).not.toHaveBeenCalled();
    });

    it('should accumulate chunks and call handler only when full frame is received', async () => {
      const payload = JSON.stringify({ chunked: 'message' });
      const frame = muxManager.createFrame(FrameTypes.JSON, payload);

      const chunkOne = frame.subarray(0, 2);
      const chunkTwo = frame.subarray(2);

      await muxManager.route(socket, chunkOne, info);
      expect(jsonHandler).not.toHaveBeenCalled();

      await muxManager.route(socket, chunkTwo, info);
      expect(jsonHandler).toHaveBeenCalled();
      expect(jsonHandler).toHaveBeenCalledWith(
        socket,
        Buffer.from(payload, 'utf-8'),
        info,
      );
    });
  });
});
