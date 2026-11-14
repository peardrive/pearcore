import type BetterSqlite3 from 'better-sqlite3';
import type { Database } from '../types/database.js';

export interface AccountSession {
  username?: string;
  directory?: string;
  [key: string]: unknown;
}

export interface CredentialsSession {
  publicKey?: string;
  secretKey?: string;
}

export interface DatabaseSession {
  db?: Database;
  sqlite?: BetterSqlite3.Database;
}

export interface ConnectionSession {
  enableHandshake: boolean;
  [key: string]: unknown;
}

export interface ReconciliationSession {
  idListThreshold: number;
  bucketCount: number;
  maxRanges: number;
  maxRounds: number;
  maxIdListSize: number;
  sessionTimeout: number;
  heartbeatInterval: number;
  requestBatchSize: number;
  requestTimeout: number;
}

export interface MessagingSession {
  rawLimitSize: number;
  frequencyThrottle: number;
  maxQuarantineTime: number;
  allowThrottleRejection: boolean;
  recordMessagesForEvents: string[];
  reconciliation: ReconciliationSession;
  [key: string]: unknown;
}

export interface FilesSession {
  localChangeBackoff: {
    baseDelay: number;
    maxDelay: number;
    backoffIncrement: number;
  };
  broadcastThrottleTime: number;
  [key: string]: unknown;
}

export interface DownloadSession {
  heatbeatInterval: number;
  requestTimeout: number;
  assignedChunkSize: number;
  [key: string]: unknown;
}

export interface SessionState {
  account: AccountSession;
  credentials: CredentialsSession;
  database: DatabaseSession;
  bootstrap?: string;
  connection: ConnectionSession;
  messaging: MessagingSession;
  files: FilesSession;
  download: DownloadSession;
  [key: string]: unknown;
}

export interface SessionFacade extends SessionState {
  get<T = unknown>(path: string): T | undefined;
  set(path: string, value: unknown): void;
  update(section: string, updates: Record<string, unknown>): void;
}

export interface DatabaseSessionInput {
  db?: Database;
  sqlite?: BetterSqlite3.Database;
}

export interface CredentialsSessionInput {
  publicKey?: string;
  secretKey?: string;
}

export type AccountSessionInput = Partial<AccountSession>;
export type MessagingSessionInput = Partial<MessagingSession>;

export class SessionManager {
  STATIC_SESSION: SessionState;
  session: SessionFacade;

  constructor(defaultSession?: SessionState | Record<string, unknown>) {
    this.STATIC_SESSION = (defaultSession as SessionState | undefined) || {
      account: {
        username: undefined,
        directory: undefined, // account's file directory
      },

      // these parameter will be updated after successful account login (accountService.authenticate())
      credentials: {
        publicKey: undefined,
        secretKey: undefined,
      },

      // these parameter will be updated after successful account login (accountService.authenticate())
      database: {
        db: undefined,
        sqlite: undefined,
      },

      // optional parameter to use custom DHT node for peer discovery
      // format (IPv4:Port) - example: 192.168.100.23:8000
      bootstrap: undefined,

      connection: {
        // early handshake with the connected peer for space hash list and profile update.
        // if false, the connection would have limited functinality without additional manual handshake
        enableHandshake: true,
      },

      // all static variables related to p2p messaging
      messaging: {
        // maximum allowed buffer size for incoming json payload to be processed
        rawLimitSize: 10 * 1024 * 1024, // 10MB as default
        // number of messages in on minute to hit the throttling point for connected peer
        frequencyThrottle: 256,
        // the quarantine time that throttled peer is not allowed to any new send message.
        maxQuarantineTime: 500,
        /**
         * send rejection message to quarantine peer as a form of notification.
         * set to `false` to avoid potential abuse in un-trusted enviroment.
         */
        allowThrottleRejection: true,

        // limit the number of messages that are stored per event type to prevent
        // excessive disk consumption and maintain system performance.
        recordMessagesForEvents: [],

        reconciliation: {
          //  ranges holding fewer messages than this value are sent as id list instead of range splits.
          idListThreshold: 32,
          // number of sub-ranges a mismatch range is split into.
          bucketCount: 16,
          // mixumum ranges allowed within single message
          maxRanges: 1024,
          // maximum number of exchanges rounds for single session
          maxRounds: 64,
          // maximum number of message ids accepted within a single range
          maxIdListSize: 4096,
          // a session without any exchange for this long is dropped
          sessionTimeout: 30000, // 30 seconds
          // interval of the reconciliation manager housekeeping (timeouts, assignments)
          heartbeatInterval: 5000, // 5 seconds
          // number of message ids requested from a single peer at once
          requestBatchSize: 128,
          // maximum time for a peer to deliver a requested batch before it is reassigned
          requestTimeout: 15000, // 15 seconds
        },
      },

      files: {
        localChangeBackoff: {
          // minimum wait time before hashing a changed file. Resets on each new change.
          baseDelay: 500, //500ms
          // maximum backoff cap. No matter how frantic the writes, we wait at most this long.
          maxDelay: 30000, // 30 seconds
          // additional delay added per rapid change (e.g., 2s => 4s => 6s ... up to maxDelayMs).
          backoffIncrement: 2000, // 2 seconds
        },
        broadcastThrottleTime: 1000, // 1-second,
      },

      download: {
        heatbeatInterval: 5000,
        // The maximum time in miliseconds for provider to finish assigments
        requestTimeout: 64000, // 64-seconds - 100KB/s for 16MB chunk assigned for delivery
        // number of leaves assigned to provider each cycle
        assignedChunkSize: 64, // 64 x 256KB => 16MB
      },
    };

    this.session = this.STATIC_SESSION as SessionFacade;
    this._createProxyInterface();
  }

  set(path: string, value: unknown): void {
    this.session.set(path, value);
  }

  get<T = unknown>(path: string): T | undefined {
    return this.session.get<T>(path);
  }

  reset(): void {
    this.session = this.STATIC_SESSION as SessionFacade;
    this._createProxyInterface();
  }

  setBootstrapperEndpoint(bootstrapper: string): void {
    this.session.set('bootstrap', bootstrapper);
  }

  getBootstrapperEndpoint(): string | undefined {
    return this.session.get<string>('bootstrap');
  }

  setDatabase({ db, sqlite }: DatabaseSessionInput): void {
    this.session.set('database.db', db);
    this.session.set('database.sqlite', sqlite);
  }

  getDatabase(): DatabaseSession {
    return {
      db: this.session.get<Database>('database.db'),
      sqlite: this.session.get<BetterSqlite3.Database>('database.sqlite'),
    };
  }

  getCredentials(): CredentialsSession {
    return {
      publicKey: this.session.get<string>('credentials.publicKey'),
      secretKey: this.session.get<string>('credentials.secretKey'),
    };
  }

  setCredentials({ publicKey, secretKey }: CredentialsSessionInput): void {
    this.session.set('credentials.publicKey', publicKey);
    this.session.set('credentials.secretKey', secretKey);
  }

  getAccount(): AccountSession | undefined {
    return this.session.get<AccountSession>('account');
  }

  setAccount(params: AccountSessionInput): void {
    const setting = this.session.get<AccountSession>('account') ?? {};
    this.session.set('account', { ...setting, ...params });
  }

  getConnectionConfig(): ConnectionSession {
    return { ...this.session.connection };
  }

  getMessageConfig(): MessagingSession {
    return { ...this.session.messaging };
  }

  setMessageConfig(params: MessagingSessionInput): void {
    const config = this.getMessageConfig();
    this.session.set('messaging', { ...config, ...params });
  }

  getDownloadConfig(): DownloadSession {
    return this.session.download;
  }

  _createProxyInterface(): void {
    const sessionProxy = new Proxy(this.session, {
      get: (target, prop: string | symbol, receiver) => {
        if (prop === 'get') return this._getProperty.bind(this);
        if (prop === 'set') return this._setProperty.bind(this);
        if (prop === 'update') return this._updateSection.bind(this);
        return Reflect.get(target, prop, receiver);
      },
    });

    this.session = sessionProxy as SessionFacade;
  }

  _getProperty<T = unknown>(path: string): T | undefined {
    const keys = path.split('.');
    let current = this.session as unknown as Record<string, unknown>;

    for (let i = 0; i < keys.length - 1; i++) {
      const value = current[keys[i]!];
      if (!value) return undefined;
      current = value as Record<string, unknown>;
    }

    return current[keys[keys.length - 1]!] as T | undefined;
  }

  _setProperty(path: string, value: unknown): void {
    const keys = path.split('.');
    let current = this.session as unknown as Record<string, unknown>;

    for (let i = 0; i < keys.length - 1; i++) {
      const key = keys[i]!;
      if (!current[key]) {
        current[key] = {};
      }
      current = current[key] as Record<string, unknown>;
    }

    current[keys[keys.length - 1]!] = value;
  }

  _updateSection(section: string, updates: Record<string, unknown>): void {
    const current = this.session[section];
    if (current) {
      Object.assign(current, updates);
    } else {
      this.session[section] = updates;
    }
  }
}
