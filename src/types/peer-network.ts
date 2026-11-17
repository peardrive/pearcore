/**
 * Transport-independent peer network contract.
 *
 * Production wires this to Hyperswarm (`hyperswarmPeerNetworkFactory`), while
 * tests can provide an in-memory implementation. Keys and topics are hex
 * strings so consumers never deal with the transport's binary representation.
 */

/**
 * A duplex stream to a single peer.
 */
export interface PeerSocket {
  destroyed: boolean;
  write(data: Buffer): boolean;
  destroy(): void;
  on(event: 'data', listener: (data: Buffer) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
  once(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}

/**
 * Context delivered together with an incoming peer connection.
 */
export interface PeerConnectionInfo {
  /** Remote peer public key, hex encoded. */
  publicKey: string;
  /** Topics both peers share at connection time, hex encoded. */
  topics: string[];
}

/**
 * Handle for an active topic subscription.
 */
export interface PeerTopicSubscription {
  destroy(): Promise<void>;
}

export interface PeerNetworkOptions {
  keyPair: {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  };
  bootstrap?: {
    host?: string;
    port?: string | number;
  };
}

/**
 * A peer discovery network bound to one identity.
 *
 * Joining a topic announces and looks up peers. Established sockets are not
 * closed when a subscription is destroyed; only `destroy()` tears them down.
 */
export interface PeerNetwork {
  onConnection(
    listener: (socket: PeerSocket, info: PeerConnectionInfo) => void,
  ): void;
  join(topic: string): Promise<PeerTopicSubscription>;
  connect(publicKey: string): void;
  destroy(): Promise<void>;
}

export type PeerNetworkFactory = (options: PeerNetworkOptions) => PeerNetwork;
