import type { EventEmitter } from 'node:events';
import * as EVENTS from '../constants/events.constants.js';
import { createChild } from '../logger.js';
import { hexToUint8 } from '../utils/crypto.utils.js';
import type { SocketManager } from './sockets.manager.js';
import type {
  MuxConnectionInfo,
  MuxManager,
} from './multiplexer.manager.js';
import type { MessageManager } from './message.manager.js';
import type { SessionManager } from './session.manager.js';
import type { Database } from '../types/database.js';
import type { ProfileRecord } from '../utils/profile.utils.js';
import {
  hyperswarmPeerNetworkFactory,
} from '../utils/network.utils.js';
import type {
  PeerNetwork,
  PeerNetworkFactory,
  PeerSocket,
  PeerTopicSubscription,
} from '../types/peer-network.js';
import {
  createProfileUpdateMessage,
  createSpaceHashListMessage,
} from '../utils/protocol.utils.js';
import { parseBootstrapAddress } from '../utils/parsers.utils.js';
import { getTopicList } from '../utils/space.utils.js';
import { getShareLinkTopics } from '../utils/sharelink.utils.js';
import { getProfileByPublicKey } from '../utils/profile.utils.js';

const logger = createChild('ConnectionManager');

export interface ConnectionManagerDependencies {
  socketManager: SocketManager;
  messageManager: MessageManager;
  sessionManager: SessionManager;
  muxManager: MuxManager;
  /**
   * Optional peer network transport. Defaults to Hyperswarm; tests can
   * inject an in-memory implementation.
   */
  peerNetworkFactory?: PeerNetworkFactory;
}

export interface ConnectionHandshakeResult {
  topics: string[];
  profile: ProfileRecord | null;
}

export class ConnectionManager {
  socketManager: SocketManager;
  messageManager: MessageManager;
  sessionManager: SessionManager;
  muxManager: MuxManager;
  peerNetworkFactory: PeerNetworkFactory;
  peerNetwork: PeerNetwork | null;
  subscriptions: Map<string, PeerTopicSubscription>;
  emitter: Pick<EventEmitter, 'emit'>;

  constructor(
    emitter: Pick<EventEmitter, 'emit'>,
    managers: ConnectionManagerDependencies,
  ) {
    this.socketManager = managers.socketManager;
    this.messageManager = managers.messageManager;
    this.sessionManager = managers.sessionManager;
    this.muxManager = managers.muxManager;
    this.peerNetworkFactory =
      managers.peerNetworkFactory ?? hyperswarmPeerNetworkFactory;

    this.peerNetwork = null;
    this.subscriptions = new Map();

    this.emitter = emitter;
  }

  get db(): Database {
    return this.sessionManager.getDatabase().db as Database;
  }

  get connectionConfig() {
    return this.sessionManager.getConnectionConfig();
  }

  /**
   * Loads and initiate discovery for topics during the boot up.
   */
  async init(): Promise<void> {
    const { publicKey, secretKey } = this.sessionManager.getCredentials();
    const boostrapper = this.sessionManager.getBootstrapperEndpoint();

    this.peerNetwork = this.peerNetworkFactory({
      keyPair: {
        publicKey: hexToUint8(publicKey!),
        secretKey: hexToUint8(secretKey!),
      },
      bootstrap: boostrapper ? parseBootstrapAddress(boostrapper) : {},
    });

    this.peerNetwork.onConnection(
      async (socket: PeerSocket, info) => {
        const publicKey = info.publicKey;
        const topics = info.topics;

        const muxInfo: MuxConnectionInfo = {
          publicKey: hexToUint8(publicKey),
          topics: topics.map((topic) => hexToUint8(topic)),
        };

        socket.on('data', async (buffer: Buffer) => {
          await this.muxManager.route(socket, buffer, muxInfo);
        });

        socket.on('close', () => {
          this.emitter.emit(EVENTS.Disconnect, { publicKey });
          try {
            this.socketManager.removeSocket(socket);
            this.muxManager.cleanup(socket);
          } catch (error) {} // do nothing
        });
        
        socket.on('error', (_error: Error) => {
          this.emitter.emit(EVENTS.Disconnect, { publicKey });
          try {
            this.socketManager.removeSocket(socket);
            this.muxManager.cleanup(socket);
          } catch (error) {} // do nothing
        });

        this.socketManager.addSocket(socket, publicKey, topics);

        this.emitter.emit(EVENTS.Connection, { publicKey, topics });

        if (this.connectionConfig.enableHandshake) {
          const context = await this.handshake(socket);
          this.emitter.emit(EVENTS.Handshake, { publicKey, context });
        }
      },
    );

    const spaceTopics = await getTopicList(this.db);
    const sharelinkTopics = await getShareLinkTopics(this.db);

    for (const topic of spaceTopics) {
      await this.join(topic);
    }

    for (const topic of sharelinkTopics) {
      await this.join(topic);
    }
  }

  /**
   * Checks if space has been broadcasted for node discovery
   * @param spaceTopicHash - The space topic hash.
   * @returns Whether the topic has been added to discovery.
   */
  isDiscoverable(spaceTopicHash: string): boolean {
    return this.subscriptions.has(spaceTopicHash);
  }

  /**
   * Initiate network discovery for new space topic hash.
   * @param spaceTopicHash - 64 character hex topic hash.
   * @returns Resolves when the topic has been joined for discovery.
   */
  async join(spaceTopicHash: string): Promise<void> {
    if (this.isDiscoverable(spaceTopicHash)) return;

    const subscription = await this.peerNetwork!.join(spaceTopicHash);
    this.subscriptions.set(spaceTopicHash, subscription);
  }

  /**
   * Creates direct connection with other nodes in the network.
   * @param publicKey - 64-character hex string public key.
   */
  connectWith(publicKey: string): void {
    if (this.peerNetwork) {
      this.peerNetwork.connect(publicKey);
    }
  }

  /**
   * Quit Network discovery for specific space. The node will maintain the already stablished socket connections.
   * @param spaceTopicHash - The space topic hash.
   */
  async leave(spaceTopicHash: string): Promise<void> {
    if (this.isDiscoverable(spaceTopicHash)) {
      const subscription = this.subscriptions.get(spaceTopicHash)!;
      await subscription.destroy();

      this.subscriptions.delete(spaceTopicHash);
    }
  }

  /**
   * Updates connected nodes with the lastes topics.
   * @returns Resolves after the recent space topic list is sent to connected peers.
   */
  async update(): Promise<void> {
    const topics = Array.from(this.subscriptions.keys());
    const { publicKey, secretKey } = this.sessionManager.getCredentials();

    const message = await createSpaceHashListMessage({
      hashList: topics,
      publicKey: publicKey!,
      secretKey: secretKey!,
    });

    const sockets = this.socketManager.getConnectedSockets();
    await this.messageManager.broadcastMessageToSockets(message, sockets);
  }

  /**
   * Handles the initial handshake to enable basic functionality between two connected nodes.
   * @param socket - The peer socket.
   * @returns The handshake context when all messages are sent.
   */
  async handshake(
    socket: PeerSocket,
  ): Promise<ConnectionHandshakeResult | undefined> {
    try {
      const { publicKey, secretKey } = this.sessionManager.getCredentials();
      const spaceTopics = await getTopicList(this.db);
      const sharelinkTopics = await getShareLinkTopics(this.db);
      const topics = [...spaceTopics, ...sharelinkTopics];

      const spaceHashListMessage = await createSpaceHashListMessage({
        hashList: topics,
        publicKey: publicKey!,
        secretKey: secretKey!,
      });

      await this.messageManager.sendMessageToSocket(
        spaceHashListMessage,
        socket,
      );

      const profile = await getProfileByPublicKey(this.db, publicKey!);
      if (profile) {
        const profileUpdateMessage = await createProfileUpdateMessage({
          profile: profile,
          topics: topics,
          publicKey: publicKey!,
          secretKey: secretKey!,
        });

        await this.messageManager.sendMessageToSocket(
          profileUpdateMessage,
          socket,
        );
      }

      return { topics, profile };
    } catch (error) {
      console.error(error);
    }
  }

  /**
   * Destroys the peer network and all socket connections,
   * calling this method after account logout or service shutdown
   * will notify all peers that this node is now out of reach.
   */
  async destroy(): Promise<void> {
    if (this.peerNetwork) {
      await this.peerNetwork.destroy();
      this.peerNetwork = null;
    }

    this.subscriptions.clear();
  }
}
