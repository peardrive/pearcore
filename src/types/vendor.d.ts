/**
 * Minimal type declarations for dependencies that don't ship their own.
 * Only the surface PearCore actually uses is declared; extend as the
 * migration reaches more call sites.
 */

declare module 'b4a' {
  type Encoding = 'utf8' | 'utf-8' | 'hex' | 'base64' | 'base64url' | 'ascii' | 'latin1' | 'binary' | 'ucs2' | 'utf16le';

  export function toString(buffer: Uint8Array, encoding?: Encoding, start?: number, end?: number): string;
}

declare module 'hyperdht' {
  import { EventEmitter } from 'events';

  export interface DHTKeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }

  export interface DHTNodeAddress {
    host: string;
    port: number;
  }

  export interface HyperDHTOptions {
    bootstrap?: Array<string | DHTNodeAddress>;
    port?: number;
    host?: string;
    ephemeral?: boolean;
    firewalled?: boolean;
    keyPair?: DHTKeyPair;
  }

  export default class HyperDHT extends EventEmitter {
    constructor(opts?: HyperDHTOptions);
    static bootstrapper(port: number, host: string, opts?: HyperDHTOptions): HyperDHT;
    static keyPair(seed?: Uint8Array): DHTKeyPair;

    readonly destroyed: boolean;
    readonly ephemeral: boolean;

    ready(): Promise<void>;
    fullyBootstrapped(): Promise<void>;
    destroy(opts?: { force?: boolean }): Promise<void>;
  }
}

declare module 'hyperswarm' {
  import { EventEmitter } from 'events';
  import type HyperDHT from 'hyperdht';
  import type { DHTKeyPair, DHTNodeAddress } from 'hyperdht';

  export interface HyperswarmOptions {
    keyPair?: DHTKeyPair;
    seed?: Uint8Array;
    bootstrap?: Array<string | DHTNodeAddress>;
    dht?: HyperDHT;
    maxPeers?: number;
    firewall?: (remotePublicKey: Uint8Array) => boolean;
  }

  export interface JoinOptions {
    server?: boolean;
    client?: boolean;
    announce?: boolean;
    lookup?: boolean;
  }

  export interface PeerDiscovery {
    flushed(): Promise<void>;
    refresh(opts?: JoinOptions): Promise<void>;
    destroy(): Promise<void>;
  }

  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: HyperswarmOptions);

    readonly keyPair: DHTKeyPair;
    readonly dht: HyperDHT;
    readonly destroyed: boolean;

    join(topic: Uint8Array, opts?: JoinOptions): PeerDiscovery;
    leave(topic: Uint8Array): Promise<void>;
    flush(): Promise<void>;
    destroy(opts?: { force?: boolean }): Promise<void>;
  }
}
