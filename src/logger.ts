import pino from 'pino';
import type { Bindings, Logger } from 'pino';
import { join } from 'path';
import { mkdirSync } from 'fs';
import {
  DEFAULT_ACCOUNT_DIR,
  PEARCORE_LOG_LEVEL,
} from './constants/global.constants.js';
import { registerGracefulShutdown } from './utils/system.utils.js';

const LOG_DIR = join(DEFAULT_ACCOUNT_DIR, '.logs');
mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

/**
 * Pino transport configuration
 * - Pretty console logs in development
 * - JSON file logs always
 */
const transport = isTest
  ? undefined
  : pino.transport({
      targets: [
        ...(isProd
          ? []
          : [
              {
                target: 'pino-pretty',
                level: PEARCORE_LOG_LEVEL,
                options: {
                  colorize: true,
                  translateTime: 'SYS:standard',
                  ignore: 'pid,hostname',
                },
              },
            ]),
        {
          target: 'pino/file',
          level: PEARCORE_LOG_LEVEL,
          options: {
            destination: LOG_FILE,
            mkdir: true,
          },
        },
      ],
    });

/**
 * Lets log methods also take pino's arguments in reverse order:
 * `logger.warn("message", { data })` behaves like `logger.warn({ data }, "message")`.
 * Pino's own LogFn signature already accepts both call shapes, so the type is unchanged.
 */
function wrap<T extends Logger>(logger: T): T {
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;

  for (const level of levels) {
    const original = logger[level].bind(logger) as (...args: unknown[]) => void;

    logger[level] = (arg1: unknown, arg2?: unknown, ...rest: unknown[]) => {
      // Case: logger.warn("message", { data })
      if (typeof arg1 === 'string' && arg2 && typeof arg2 === 'object') {
        return original(arg2, arg1, ...rest);
      }

      return original(arg1, arg2, ...rest);
    };
  }

  return logger;
}

export const logger = wrap(
  pino(
    {
      level: PEARCORE_LOG_LEVEL,
      enabled: !isTest,
      base: { pid: process.pid },
      serializers: {
        err: pino.stdSerializers.err,
      },
      redact: {
        paths: [
          'password',
          'token',
          'authorization',
          'req.headers.authorization',
        ],
        censor: '[REDACTED]',
      },
    },
    transport,
  ),
);

/**
 * Child logger helper
 * Uses structured fields (not string prefixes). A string is bound as `{ module: name }`;
 * pino would otherwise spread it into one field per character ("0": "S", "1": "p", ...).
 */
export function createChild(bindings: string | Bindings): Logger {
  return logger.child(
    typeof bindings === 'string' ? { module: bindings } : bindings,
  );
}

/**
 * Optional exports for consumers
 */
export const logDir = LOG_DIR;
export const logFile = LOG_FILE;
