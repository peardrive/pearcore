import { EventEmitter } from 'node:events';
import { hex } from '../src/utils/crypto.utils.js';
import type {
  PeerConnectionInfo,
  PeerNetwork,
  PeerNetworkFactory,
  PeerNetworkOptions,
  PeerSocket,
  PeerTopicSubscription,
} from '../src/types/peer-network.js';

export interface InMemorySettleOptions {
  timeout?: number;
  quietTurns?: number;
}

interface InMemoryLink {
  key: string;
  a: InMemorySocket;
  b: InMemorySocket;
  topics: Set<string>;
  closed: boolean;
}

function linkKey(publicKeyA: string, publicKeyB: string): string {
  return publicKeyA < publicKeyB
    ? `${publicKeyA}:${publicKeyB}`
    : `${publicKeyB}:${publicKeyA}`;
}

/**
 * Stream-like socket between two in-memory peers.
 *
 * Written chunks are queued on the peer and delivered on a later turn of the
 * event loop, preserving FIFO order. Chunks stay buffered until a `data`
 * listener exists, so a handshake cannot be lost while the connection handler
 * is attaching.
 */
class InMemorySocket extends EventEmitter implements PeerSocket {
  destroyed = false;
  peer: InMemorySocket | null = null;
  owner = '';
  link: InMemoryLink | null = null;

  #network: InMemoryNetwork;
  #queue: Buffer[] = [];
  #scheduled = false;

  constructor(network: InMemoryNetwork) {
    super();
    this.#network = network;
  }

  write(data: Buffer): boolean {
    if (this.destroyed || !this.peer || this.peer.destroyed) return false;

    this.peer._enqueue(data);
    return true;
  }

  destroy(): void {
    this.#network._closeLink(this.link);
  }

  override on(eventName: string | symbol, listener: (...args: any[]) => void) {
    super.on(eventName, listener);
    if (eventName === 'data') this.#schedule();
    return this;
  }

  override once(eventName: string | symbol, listener: (...args: any[]) => void) {
    super.once(eventName, listener);
    if (eventName === 'data') this.#schedule();
    return this;
  }

  _enqueue(data: Buffer): void {
    if (this.destroyed) return;

    this.#queue.push(data);
    this.#network.pendingDeliveries++;
    this.#schedule();
  }

  #schedule(): void {
    if (this.#scheduled || this.destroyed || this.listenerCount('data') === 0) {
      return;
    }

    this.#scheduled = true;
    setImmediate(() => {
      this.#scheduled = false;

      // Dispatch the whole burst in one turn, like a real stream: every
      // handler reaches its first await before the next chunk is emitted.
      while (this.#queue.length > 0 && !this.destroyed) {
        const chunk = this.#queue.shift()!;
        this.#network.pendingDeliveries--;
        this.emit('data', chunk);
      }
    });
  }

  _close(): void {
    if (this.destroyed) return;

    this.destroyed = true;
    this.#network.pendingDeliveries -= this.#queue.length;
    this.#queue.length = 0;
    this.peer = null;
    this.emit('close');
  }
}

/**
 * One peer in the in-memory network.
 */
class InMemoryNode implements PeerNetwork {
  readonly publicKey: string;

  #network: InMemoryNetwork;
  #listener:
    | ((socket: PeerSocket, info: PeerConnectionInfo) => void)
    | null = null;
  #topics = new Set<string>();

  constructor(network: InMemoryNetwork, options: PeerNetworkOptions) {
    this.#network = network;
    this.publicKey = hex(options.keyPair.publicKey);
  }

  onConnection(
    listener: (socket: PeerSocket, info: PeerConnectionInfo) => void,
  ): void {
    this.#listener = listener;
  }

  async join(topic: string): Promise<PeerTopicSubscription> {
    this.#topics.add(topic);
    const members = this.#network.memberships.get(topic) ?? new Set<string>();
    members.add(this.publicKey);
    this.#network.memberships.set(topic, members);

    // Connect existing members in the background, like DHT discovery.
    this.#network._scheduleTopic(topic);

    return {
      destroy: async () => {
        this.#topics.delete(topic);

        const current = this.#network.memberships.get(topic);
        current?.delete(this.publicKey);
        if (current && current.size === 0) {
          this.#network.memberships.delete(topic);
        }

        for (const link of this.#network._linksFor(this.publicKey)) {
          link.topics.delete(topic);
        }
      },
    };
  }

  connect(publicKey: string): void {
    this.#network._scheduleDirect(this.publicKey, publicKey);
  }

  async destroy(): Promise<void> {
    this.#network._removeNode(this);
  }

  _emitConnection(socket: PeerSocket, info: PeerConnectionInfo): void {
    this.#listener?.(socket, info);
  }

  _topics(): Iterable<string> {
    return this.#topics;
  }
}

/**
 * Minimal pair-wise in-memory peer network.
 *
 * Subscribing to a topic links the node with every other member of that topic;
 * `connect()` links two nodes directly. Links are deduplicated per peer pair
 * and emit one connection per side.
 */
export class InMemoryNetwork {
  readonly nodes = new Map<string, InMemoryNode>();
  readonly links = new Map<string, InMemoryLink>();
  readonly memberships = new Map<string, Set<string>>();
  readonly factory: PeerNetworkFactory;

  pendingDeliveries = 0;

  #scheduledTopics = new Set<string>();
  #scheduledPeers = new Set<string>();

  constructor() {
    this.factory = (options) => {
      if (this.nodes.has(hex(options.keyPair.publicKey))) {
        throw new Error('in-memory peer network already has this identity');
      }

      const node = new InMemoryNode(this, options);
      this.nodes.set(node.publicKey, node);
      return node;
    };
  }

  /**
   * Resolves once queued frames have been delivered for a few quiet turns.
   */
  async settle({
    timeout = 8000,
    quietTurns = 3,
  }: InMemorySettleOptions = {}): Promise<void> {
    const deadline = Date.now() + timeout;
    let quiet = 0;

    while (quiet < quietTurns) {
      if (Date.now() > deadline) {
        throw new Error('in-memory peer network did not settle');
      }

      await new Promise<void>((resolve) => setImmediate(resolve));
      quiet = this._isIdle() ? quiet + 1 : 0;
    }
  }

  _isIdle(): boolean {
    return (
      this.pendingDeliveries === 0 &&
      this.#scheduledTopics.size === 0 &&
      this.#scheduledPeers.size === 0
    );
  }

  _scheduleTopic(topic: string): void {
    if (this.#scheduledTopics.has(topic)) return;

    this.#scheduledTopics.add(topic);
    setImmediate(() => {
      this.#scheduledTopics.delete(topic);
      this._connectTopic(topic);
    });
  }

  _connectTopic(topic: string): void {
    const members = this.memberships.get(topic);
    if (!members) return;

    for (const publicKeyA of members) {
      for (const publicKeyB of members) {
        if (publicKeyA < publicKeyB) {
          this._ensureLink(publicKeyA, publicKeyB, topic);
        }
      }
    }
  }

  _scheduleDirect(publicKeyA: string, publicKeyB: string): void {
    const key = linkKey(publicKeyA, publicKeyB);
    if (this.#scheduledPeers.has(key)) return;

    this.#scheduledPeers.add(key);
    setImmediate(() => {
      this.#scheduledPeers.delete(key);
      this._ensureLink(publicKeyA, publicKeyB, null);
    });
  }

  /**
   * Cuts the link between two peers, if one exists.
   * @returns Whether a link was closed.
   */
  disconnect(publicKeyA: string, publicKeyB: string): boolean {
    const link = this.links.get(linkKey(publicKeyA, publicKeyB));
    if (!link) return false;

    this._closeLink(link);
    return true;
  }

  async destroy(): Promise<void> {
    for (const node of Array.from(this.nodes.values())) {
      await node.destroy();
    }

    this.nodes.clear();
    this.links.clear();
    this.memberships.clear();
    this.#scheduledTopics.clear();
    this.#scheduledPeers.clear();
    this.pendingDeliveries = 0;
  }

  _ensureLink(
    publicKeyA: string,
    publicKeyB: string,
    topic: string | null,
  ): InMemoryLink | null {
    if (publicKeyA === publicKeyB) return null;

    const nodeA = this.nodes.get(publicKeyA);
    const nodeB = this.nodes.get(publicKeyB);
    if (!nodeA || !nodeB) return null;

    const key = linkKey(publicKeyA, publicKeyB);
    const existing = this.links.get(key);

    if (existing && !existing.closed) {
      if (topic) existing.topics.add(topic);
      return existing;
    }

    const a = new InMemorySocket(this);
    const b = new InMemorySocket(this);
    a.peer = b;
    b.peer = a;
    a.owner = publicKeyA;
    b.owner = publicKeyB;

    const link: InMemoryLink = {
      key,
      a,
      b,
      topics: new Set(topic ? [topic] : []),
      closed: false,
    };

    a.link = link;
    b.link = link;
    this.links.set(key, link);

    const topics = Array.from(link.topics);
    nodeA._emitConnection(a, { publicKey: publicKeyB, topics });
    nodeB._emitConnection(b, { publicKey: publicKeyA, topics });

    return link;
  }

  _linksFor(publicKey: string): InMemoryLink[] {
    return Array.from(this.links.values()).filter(
      (link) => link.a.owner === publicKey || link.b.owner === publicKey,
    );
  }

  _removeNode(node: InMemoryNode): void {
    if (!this.nodes.has(node.publicKey)) return;

    for (const link of this._linksFor(node.publicKey)) {
      this._closeLink(link);
    }

    for (const topic of node._topics()) {
      const members = this.memberships.get(topic);
      members?.delete(node.publicKey);
      if (members && members.size === 0) {
        this.memberships.delete(topic);
      }
    }

    this.nodes.delete(node.publicKey);
  }

  _closeLink(link: InMemoryLink | null): void {
    if (!link || link.closed) return;

    link.closed = true;
    this.links.delete(link.key);
    link.a.link = null;
    link.b.link = null;
    link.a._close();
    link.b._close();
  }
}
