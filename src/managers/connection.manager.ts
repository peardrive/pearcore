import type { EventEmitter } from 'node:events';
import Hyperswarm, { type PeerDiscovery } from 'hyperswarm';
import * as EVENTS from '../constants/events.constants.js';
import { createChild } from '../logger.js';
import { hex, hexToUint8 } from '../utils/crypto.utils.js';
import type { SocketManager, ManagedSocket } from './sockets.manager.js';
import type {
  MuxConnectionInfo,
  MuxManager,
  MuxSocket,
} from './multiplexer.manager.js';
import type { MessageManager } from './message.manager.js';
import type { SessionManager } from './session.manager.js';
import type { Database } from '../types/database.js';
import type { ProfileRecord } from '../utils/profile.utils.js';
import { connectSwarm, joinSwarmTopic } from '../utils/network.utils.js';
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
}

interface ConnectionSocket extends Omit<MuxSocket, 'destroy'>, ManagedSocket {
  on(event: 'data', listener: (buffer: Buffer) => void): ConnectionSocket;
  on(event: 'close', listener: () => void): ConnectionSocket;
  on(event: 'error', listener: (error: Error) => void): ConnectionSocket;
}

interface ConnectionSwarm extends Hyperswarm {
  joinPeer(publicKey: Uint8Array): void;
}

interface ConnectionInfo extends MuxConnectionInfo {
  topics: Uint8Array[];
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
  swarmInstance: ConnectionSwarm | null;
  discoveryMap: Record<string, PeerDiscovery>;
  emitter: Pick<EventEmitter, 'emit'>;

  constructor(
    emitter: Pick<EventEmitter, 'emit'>,
    managers: ConnectionManagerDependencies,
  ) {
    this.socketManager = managers.socketManager;
    this.messageManager = managers.messageManager;
    this.sessionManager = managers.sessionManager;
    this.muxManager = managers.muxManager;

    this.swarmInstance = null;
    this.discoveryMap = {};

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

    this.swarmInstance = connectSwarm({
      keyPair: {
        publicKey: hexToUint8(publicKey!),
        secretKey: hexToUint8(secretKey!),
      },
      bootstrap: boostrapper ? parseBootstrapAddress(boostrapper) : {},
    }) as ConnectionSwarm;

    this.swarmInstance.on(
      'connection',
      async (socket: ConnectionSocket, info: ConnectionInfo) => {
        const publicKey = hex(info.publicKey);
        const topics = info.topics.map((t) => hex(t));

        socket.on('data', async (buffer: Buffer) => {
          await this.muxManager.route(socket, buffer, info);
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
          const context = await this.handshake(socket, info);
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
    return this.discoveryMap.hasOwnProperty(spaceTopicHash);
  }

  /**
   * Initiate network discovery for new space topic hash.
   * @param spaceTopicHash - 64 character hex topic hash.
   * @returns Resolves when the topic has been joined for discovery.
   */
  async join(spaceTopicHash: string): Promise<void> {
    if (this.isDiscoverable(spaceTopicHash)) return;

    const discoveryOptions = { server: true, client: true };
    const discovery = await joinSwarmTopic(
      this.swarmInstance!,
      spaceTopicHash,
      discoveryOptions,
    );
    this.discoveryMap[spaceTopicHash] = discovery;
  }

  /**
   * Creates direct connection with other nodes in the network.
   * @param publicKey - 64-character hex string public key.
   */
  connectWith(publicKey: string): void {
    if (this.swarmInstance) {
      this.swarmInstance.joinPeer(hexToUint8(publicKey));
    }
  }

  /**
   * Quit Network discovery for specific space. The node will maintain the already stablished socket connections.
   * @param spaceTopicHash - The space topic hash.
   */
  async leave(spaceTopicHash: string): Promise<void> {
    if (this.isDiscoverable(spaceTopicHash)) {
      const discovery = this.discoveryMap[spaceTopicHash];
      await discovery.destroy();

      delete this.discoveryMap[spaceTopicHash];
    }
  }

  /**
   * Updates connected nodes with the lastes topics.
   * @returns Resolves after the recent space topic list is sent to connected peers.
   */
  async update(): Promise<void> {
    const topics = Object.keys(this.discoveryMap);
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
   * @param info - Hyperswarm connection details.
   * @returns The handshake context when all messages are sent.
   */
  async handshake(
    socket: ConnectionSocket,
    _info: ConnectionInfo,
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
   * Destroys the hyperswarm and all socket connections,
   * calling this method after account logout or service shutdown
   * will notify all peers that this node is now out of reach.
   */
  async destroy(): Promise<void> {
    await this.swarmInstance!.destroy();
    this.swarmInstance = null;
    this.discoveryMap = {};
  }
}
