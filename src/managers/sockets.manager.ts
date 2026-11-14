import { createChild } from '../logger.js';

const logger = createChild('SpaceSocketManager');

export interface ManagedSocket {
  destroy: () => void;
  name?: string;
}

export interface PeerRecord<Socket extends ManagedSocket = ManagedSocket> {
  socket: Socket;
  topics: Set<string>;
}

export interface ConnectedSocketQuery {
  peers?: string[];
  topics?: string[];
}

export interface SocketSnapshotOptions {
  sortByPeers?: boolean;
  sortByTopic?: boolean;
}

export class SocketManager {
  peers: Map<string, PeerRecord>;
  topicIndex: Map<string, Set<string>>;
  socketIndex: WeakMap<ManagedSocket, string>;

  constructor() {
    /**
     * Peer registry.
     *
     * peerKey => {
     *    socket: Socket,
     *    topics: Set<topicHash>
     * }
     */
    this.peers = new Map<string, PeerRecord>();

    /**
     * Topic reverse index.
     *
     * topicHash => Set<peerKey>
     */
    this.topicIndex = new Map<string, Set<string>>();

    /**
     * Socket reverse lookup.
     *
     * socket => peerKey
     *
     * WeakMap ensures sockets can be GC’d safely.
     */
    this.socketIndex = new WeakMap<ManagedSocket, string>();
  }

  /**
   * Registers a socket with its associated peer and subscribed topics.
   *
   * @param socket - The socket instance representing the peer connection.
   * @param peerKey - The public key that uniquely identifies the peer.
   * @param topics - A collection of topic hashes the socket
   *   is interested in or has joined.
   */
  addSocket(
    socket: ManagedSocket,
    peerKey: string,
    topics: Iterable<string>,
  ): void {
    const topicSet = new Set(topics);

    // remove all previous record from the peer
    if (this.peers.has(peerKey)) {
      this.resetSocket(this.peers.get(peerKey)!.socket);
    }

    this.peers.set(peerKey, {
      socket: socket,
      topics: topicSet,
    });

    this.socketIndex.set(socket, peerKey);

    for (const topic of topicSet) {
      if (!this.topicIndex.has(topic)) {
        this.topicIndex.set(topic, new Set());
      }

      this.topicIndex.get(topic)!.add(peerKey);
    }
  }

  /**
   * Deregisters a socket
   * @param socket - The socket instance to reset the state for.
   */
  resetSocket(socket: ManagedSocket): void {
    const peerKey = this.socketIndex.get(socket);
    if (!peerKey) {
      logger.warn(
        'removeSocket failed, no record found for the provided socket.',
      );
      return;
    }

    const peer = this.peers.get(peerKey);
    if (!peer) {
      logger.warn(
        { peerKey },
        'removeSocket failed, no record found for peerKey',
      );

      return;
    }

    this.socketIndex.delete(socket);

    for (const topic of peer.topics) {
      const peerSet = this.topicIndex.get(topic);
      if (peerSet) {
        peerSet.delete(peerKey);
        if (peerSet.size === 0) {
          this.topicIndex.delete(topic);
        }
      }
    }

    this.peers.delete(peerKey);
  }

  /**
   * Deregisters a socket and cleans up all references associated with it.
   *
   * @param socket - The socket instance to remove.
   */
  removeSocket(socket: ManagedSocket): void {
    this.resetSocket(socket);
    socket.destroy();
  }

  /**
   * Returns the public key and topics for a given socket.
   *
   * @param socket - The socket instance to look up.
   * @returns The peer's public key and subscribed topics.
   * @throws If no peer key is found for the provided socket.
   */
  getPeerInfoBySocket(socket: ManagedSocket): {
    publicKey: string;
    topics: string[];
  } {
    const peerKey = this.socketIndex.get(socket);
    if (!peerKey) throw new Error('socket has no peerkey record');

    const peer = this.peers.get(peerKey)!;
    return {
      publicKey: peerKey,
      topics: Array.from(peer.topics),
    };
  }

  /**
   * Returns all connected sockets, optionally filtered by:
   * - peers (array of public keys)
   * - topics (array of topic hashes)
   * - intersection of peers and topics.
   *
   * @param query - Optional peer and topic filters.
   * @returns Socket instances that match the filtering criteria.
   */
  getConnectedSockets(query: ConnectedSocketQuery = {}): ManagedSocket[] {
    const { peers, topics } = query;
    const filterByPeer = peers && Array.isArray(peers);
    const filterByTopics = topics && Array.isArray(topics);

    const getSockets = (keys: Iterable<string>) =>
      Array.from(keys, (key) => this.peers.get(key)!.socket);
    const getKeySetByPeerList = (peerKeys: Iterable<string>) =>
      new Set(Array.from(peerKeys).filter((key) => this.peers.has(key)));
    const getKeySetByTopicList = (topicKeys: Iterable<string>) =>
      new Set(
        Array.from(topicKeys)
          .map((topic) => Array.from(this.topicIndex.get(topic) || []))
          .flat(),
      );

    // actions for processing final result
    const FilterType = {
      NONE: 0, // no list has been provided
      TOPICS_ONLY: 1, // only topic list has been provided
      PEERS_ONLY: 2, // only peers list has been provided
      INTERSECTION: 3, // both peers and topic list has been provided
    };

    let action: number = FilterType.NONE;
    if (filterByPeer && filterByTopics) action = FilterType.INTERSECTION;
    else if (filterByPeer) action = FilterType.PEERS_ONLY;
    else if (filterByTopics) action = FilterType.TOPICS_ONLY;
    else action = FilterType.NONE;

    switch (action) {
      case FilterType.NONE:
        const result = getSockets(Array.from(this.peers.keys()));
        return result;

      case FilterType.PEERS_ONLY:
        return getSockets(getKeySetByPeerList(peers ?? []));

      case FilterType.TOPICS_ONLY:
        return getSockets(getKeySetByTopicList(topics ?? []));

      case FilterType.INTERSECTION:
        const keysByPeerList = getKeySetByPeerList(peers ?? []);
        const keysByTopicList = getKeySetByTopicList(topics ?? []);
        const keysFromIntersection = Array.from(keysByPeerList).filter((key) =>
          keysByTopicList.has(key),
        );
        return getSockets(keysFromIntersection);

      default:
        throw new Error(
          'getConnectedSockets() failed to choose action for query.',
        );
    }
  }

  /**
   * Returns all connected peer keys, optionally filtered.
   *
   * @param filter - Optional predicate for peer keys.
   * @returns Peer keys that match the predicate.
   */
  getPeerKeys(filter: ((peerKey: string) => boolean) | null = null): string[] {
    const result = new Set<string>();

    if (filter && typeof filter !== 'function') {
      throw new Error('Filter must be a function');
    }

    for (const peerKey of this.peers.keys()) {
      if (filter) {
        if (filter(peerKey)) {
          result.add(peerKey);
        }
      } else {
        result.add(peerKey);
      }
    }

    return Array.from(result);
  }

  /**
   * Returns a snapshot of the current socket manager state.
   * @param options - Selects whether to group topics by peer or peers by topic.
   * @returns Snapshot map based on the specified sorting option.
   */
  getSnapShot({
    sortByPeers = true,
    sortByTopic = false,
  }: SocketSnapshotOptions = {}): Record<string, string[]> {
    if (sortByPeers && sortByTopic) {
      throw new Error('Cannot sort by both peers and topics simultaneously');
    }

    if (!sortByPeers && !sortByTopic) {
      throw new Error("Either 'sortByPeers' or 'sortByTopic' must be true.");
    }

    if (sortByPeers) {
      const result: Record<string, string[]> = {};
      for (const [peerKey, { topics }] of this.peers.entries()) {
        result[peerKey] = Array.from(topics);
      }

      return result;
    }

    if (sortByTopic) {
      const result: Record<string, string[]> = {};
      for (const [topic, peerSet] of this.topicIndex.entries()) {
        result[topic] = Array.from(peerSet);
      }

      return result;
    }

    throw new Error('Socket snapshot sorting option is invalid.');
  }
}
