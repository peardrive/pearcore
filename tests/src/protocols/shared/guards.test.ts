import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import * as MESSAGES from '../../../../src/constants/messages.constants.js';
import { hexToUint8 } from '../../../../src/utils/crypto.utils.js';
import { BaseProtocolHandler } from '../../../../src/protocols/base.js';
import type { EnforcementResult } from '../../../../src/protocols/base.js';
import type { ProtocolContext } from '../../../../src/protocols/shared/context.js';
import {
  canBroadcast,
  canRead,
  notRelayed,
  subscribed,
  validPayload,
  verified,
} from '../../../../src/protocols/shared/guards.js';
import type { Guard } from '../../../../src/protocols/shared/guards.js';
import type { SocketManager } from '../../../../src/managers/sockets.manager.js';

const alice = 'a'.repeat(64);
const bob = 'b'.repeat(64);

class TestHandler extends BaseProtocolHandler {
  constructor(
    reject: (
      socket: unknown,
      message: unknown,
      reason: string,
    ) => Promise<void> = async () => {},
  ) {
    super(new EventEmitter(), {} as never);
    this.messageManager = { reject } as never;
  }

  run(
    ctx: ProtocolContext,
    guards: readonly Guard[],
  ): Promise<EnforcementResult> {
    return this.enforce(ctx, guards);
  }

  rejectMessage(ctx: ProtocolContext, reason: string): Promise<void> {
    return this.reject(ctx, reason);
  }
}

function context(overrides: Partial<ProtocolContext> = {}): ProtocolContext {
  return {
    socket: {} as ProtocolContext['socket'],
    info: { publicKey: new Uint8Array() },
    senderPublicKey: alice,
    message: {
      type: 'Test',
      topic: 'topic',
      publicKey: alice,
      nonce: '0'.repeat(24),
      timestamp: 0,
      payload: null,
      signature: '0'.repeat(128),
    },
    ...overrides,
  };
}

function space(overrides: Record<string, unknown> = {}) {
  return {
    publicKey: alice,
    permissionRead: true,
    readWhitelist: [] as string[],
    permissionBroadcast: true,
    broadcastWhitelist: [] as string[],
    secret: null,
    ...overrides,
  };
}

describe('protocol guards', () => {
  describe('notRelayed', () => {
    it('allows a message authored by the connected peer', () => {
      expect(notRelayed(context())).toBeNull();
    });

    it('rejects a relayed message', () => {
      const ctx = context();
      ctx.message.publicKey = bob;

      expect(notRelayed(ctx)).toBe(MESSAGES.NO_RELAY_MESSAGE);
    });
  });

  describe('subscribed', () => {
    const topic = 'a'.repeat(64);

    function contextOnTopic(): ProtocolContext {
      const ctx = context();

      return { ...ctx, message: { ...ctx.message, topic } };
    }

    function socketManager(announced: string[] = []): SocketManager {
      return {
        getPeerInfoBySocket: () => ({
          publicKey: alice,
          topics: announced,
        }),
      } as unknown as SocketManager;
    }

    function withConnectionTopics(topics: string[]): ProtocolContext {
      const ctx = contextOnTopic();

      return {
        ...ctx,
        info: {
          publicKey: new Uint8Array(),
          topics: topics.map((item) => hexToUint8(item)),
        },
      };
    }

    it('passes when the connection includes the message topic', () => {
      expect(
        subscribed(socketManager())(withConnectionTopics([topic])),
      ).toBeNull();
    });

    it('passes when the peer announced the message topic', () => {
      expect(subscribed(socketManager([topic]))(contextOnTopic())).toBeNull();
    });

    it('rejects when neither source includes the message topic', () => {
      const ctx = withConnectionTopics(['b'.repeat(64)]);

      expect(subscribed(socketManager(['c'.repeat(64)]))(ctx)).toBe(
        MESSAGES.NOT_SUBSCRIBED_MESSAGE,
      );
    });

    it('uses a custom topic resolver', () => {
      const other = 'c'.repeat(64);
      const ctx = withConnectionTopics([other]);

      expect(subscribed(socketManager(), () => other)(ctx)).toBeNull();
    });

    it('rejects when no topic information is available', () => {
      expect(subscribed(socketManager())(contextOnTopic())).toBe(
        MESSAGES.NOT_SUBSCRIBED_MESSAGE,
      );
    });
  });

  describe('validPayload', () => {
    it('passes when the validator passes', () => {
      const guard = validPayload(() => ({ isValid: true, reason: 'ok' }));
      expect(guard(context())).toBeNull();
    });

    it('rejects with the validator reason', () => {
      const guard = validPayload(() => ({
        isValid: false,
        reason: 'bad payload',
      }));

      expect(guard(context())).toBe('bad payload');
    });
  });

  describe('canRead', () => {
    it('checks the sender by default', () => {
      const ctx = context();
      const policy = space({
        publicKey: bob,
        permissionRead: false,
        readWhitelist: [alice],
      });

      expect(canRead(policy)(ctx)).toBeNull();
    });

    it('can check the author instead of the sender', () => {
      const ctx = context();
      ctx.message.publicKey = bob;
      const policy = space({
        permissionRead: false,
        readWhitelist: [],
      });

      expect(canRead(policy, 'author')(ctx)).toBe(
        MESSAGES.READ_PERMISSION_NOT_ALLOWED_MESSAGE,
      );
    });
  });

  describe('canBroadcast', () => {
    it('checks the author by default', () => {
      const ctx = context();
      ctx.message.publicKey = bob;
      const policy = space({
        publicKey: alice,
        permissionBroadcast: false,
        broadcastWhitelist: [alice],
      });

      expect(canBroadcast(policy)(ctx)).toBe(
        MESSAGES.BROADCAST_PERMISSION_NOT_ALLOWED_MESSAGE,
      );
    });

    it('can check the sender instead', () => {
      const ctx = context();
      ctx.message.publicKey = bob;
      const policy = space({
        permissionBroadcast: false,
        broadcastWhitelist: [alice],
      });

      expect(canBroadcast(policy, 'sender')(ctx)).toBeNull();
    });
  });

  describe('verified', () => {
    it('rejects when the check fails', async () => {
      const guard = verified(async () => false, MESSAGES.BAD_SIGNATURE_MESSAGE);

      await expect(guard(context())).resolves.toBe(
        MESSAGES.BAD_SIGNATURE_MESSAGE,
      );
    });
  });

  describe('enforce', () => {
    it('returns success without rejecting when every guard passes', async () => {
      const reject = vi.fn(async () => {});
      const handler = new TestHandler(reject);

      const outcome = await handler.run(context(), [() => null]);

      expect(outcome).toEqual({ result: true });
      expect(reject).not.toHaveBeenCalled();
    });

    it('returns the first failure reason and performs no rejection', async () => {
      const reject = vi.fn(async () => {});
      const handler = new TestHandler(reject);

      const outcome = await handler.run(context(), [
        () => null,
        () => 'first failure',
        () => 'second failure',
      ]);

      expect(outcome).toEqual({ result: false, reason: 'first failure' });
      expect(reject).not.toHaveBeenCalled();
    });

    it('rejects only when the handler asks it to', async () => {
      const reject = vi.fn(async () => {});
      const handler = new TestHandler(reject);
      const ctx = context();

      await handler.rejectMessage(ctx, MESSAGES.NO_RELAY_MESSAGE);

      expect(reject).toHaveBeenCalledWith(
        ctx.socket,
        ctx.message,
        MESSAGES.NO_RELAY_MESSAGE,
      );
    });
  });
});
