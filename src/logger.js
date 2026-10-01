import pino from 'pino';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { DEFAULT_ACCOUNT_DIR, PEARCORE_LOG_LEVEL } from './constants/global.constants.js';
import { registerGracefulShutdown } from "./utils/system.utils.js"

const LOG_DIR = join(DEFAULT_ACCOUNT_DIR, '.logs');
mkdirSync(LOG_DIR, { recursive: true });

const LOG_FILE = join(
  LOG_DIR,
  `${new Date().toISOString().slice(0, 10)}.log`
);

const isProd = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test'

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
    })

// pino's transport is a worker thread; a write error (ENOSPC was the field case) emits
// 'error' with no listener, which throws at the top level and kills the process.
// Logging degrades; it never takes a running sync down with it.
if (transport) transport.on('error', (err) => { try { console.error('[pearcore] logger transport error:', err?.message ?? err) } catch {} });

function wrap(logger) {
  const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];

  for (const level of levels) {
    const original = logger[level].bind(logger);

    logger[level] = (arg1, arg2, ...rest) => {
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
    transport
  )
)

/**
 * Child logger helper
 * Uses structured fields (not string prefixes)
 */
export function createChild(bindings) {
  return logger.child(bindings);
}

/**
 * Optional exports for consumers
 */
export const logDir = LOG_DIR;
export const logFile = LOG_FILE;
