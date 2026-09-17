import * as EVENTS from '../constants/events.constants.js';
import { createChild } from "../logger.js";
import { hex, hexToUint8 } from "../utils/crypto.utils.js";
import { connectSwarm, joinSwarmTopic } from "../utils/network.utils.js";
import { createProfileUpdateMessage, createSpaceHashListMessage } from "../utils/protocol.utils.js";
import { parseBootstrapAddress } from "../utils/parsers.utils.js";
import { getTopicList } from '../utils/space.utils.js';
import { getShareLinkTopics } from '../utils/sharelink.utils.js';
import { getProfileByPublicKey } from '../utils/profile.utils.js';

const logger = createChild('ConnectionManager');

export class ConnectionManager {
    constructor(emitter, managers) {
        this.socketManager = managers.socketManager;
        this.messageManager = managers.messageManager;
        this.sessionManager = managers.sessionManager;
        this.muxManager = managers.muxManager;

        this.swarmInstance = null;
        this.discoveryMap = {};

        this.emitter = emitter;
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    get connectionConfig() {
        return this.sessionManager.getConnectionConfig();
    }

    /**
     * Loads and initiate discovery for topics during the boot up.
     */
    async init() {
        const { publicKey, secretKey } = this.sessionManager.getCredentials();
        const boostrapper = this.sessionManager.getBootstrapperEndpoint();

        this.swarmInstance = connectSwarm({
            keyPair: {
                publicKey: hexToUint8(publicKey),
                secretKey: hexToUint8(secretKey)
            },
            bootstrap: boostrapper ? parseBootstrapAddress(boostrapper) : {}
        });

        this.swarmInstance.on('connection', async (socket, info) => {
            const publicKey = hex(info.publicKey);
            const topics = info.topics.map(t => hex(t));

            socket.on('data', async buffer => {
                await this.muxManager.route(socket, buffer, info);
            });

            socket.on('close', () => {
                this.emitter.emit(EVENTS.Disconnect, { publicKey });
                try {
                    this.socketManager.removeSocket(socket);
                    this.muxManager.cleanup(socket);
                } catch (error) { } // do nothing
            });
            socket.on('error', (err) => {
                this.emitter.emit(EVENTS.Disconnect, { publicKey });
                try {
                    this.socketManager.removeSocket(socket);
                    this.muxManager.cleanup(socket);
                } catch(error) {} // do nothing
            })

            this.socketManager.addSocket(socket, publicKey, topics);

            this.emitter.emit(EVENTS.Connection, { publicKey, topics });

            if (this.connectionConfig.enableHandshake) {
                const context = await this.handshake(socket, info);
                this.emitter.emit(EVENTS.Handshake, { publicKey, context });
            }
        });

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
     * @param {String} spaceTopicHash - The space topic hash
     * @returns {Boolean} Returns True if the space has been broadcasted.
     */
    isDiscoverable(spaceTopicHash) {
        return this.discoveryMap.hasOwnProperty(spaceTopicHash);
    }

    /**
     * Initiate network discovery for new space topic hash.
     * @param {String} spaceTopicHash - 64 character hex topic (hash)
     * @returns {Promise<void>} Resolves when the new topic has been broadcasted for discovery.
     */
    async join(spaceTopicHash) {
        if (this.isDiscoverable(spaceTopicHash)) return;

        const discoveryOptions = { server: true, client: true };
        const discovery = await joinSwarmTopic(this.swarmInstance, spaceTopicHash, discoveryOptions);
        this.discoveryMap[spaceTopicHash] = discovery;
    }

    /**
     * Creates direct connection with other nodes in the network.
     * @param {string} publicKey - 64-character hex string publickey.
     */
    connectWith(publicKey) {
        if (this.swarmInstance) {
            this.swarmInstance.joinPeer(hexToUint8(publicKey));
        }
    }

    /**
     * Quit Network discovery for specific space. The node will maintain the already stablished socket connections.
     * @param {String} spaceTopicHash - The space topic hash
     */
    async leave(spaceTopicHash) {
        if (this.isDiscoverable(spaceTopicHash)) {
            const discovery = this.discoveryMap[spaceTopicHash];
            await discovery.destroy();

            delete this.discoveryMap[spaceTopicHash];
        }
    }

    /**
     * Updates connected nodes with the lastes topics.
     * @returns {Promise<void>} Resolves when new SpaceHashList message with the recent topic list has been sent
     * to all connected nodes.
     */
    async update() {
        const topics = Object.keys(this.discoveryMap);
        const { publicKey, secretKey } = this.sessionManager.getCredentials();

        const message = await createSpaceHashListMessage({
            hashList: topics,
            publicKey: publicKey,
            secretKey: secretKey
        });

        const sockets = this.socketManager.getConnectedSockets();
        await this.messageManager.broadcastMessageToSockets(message, sockets);
    }

    /**
     * Handles the initial handshake to enable basic functionality between two connected nodes.
     * @param {Object} socket - The Socket connection.
     * @param {Object} info - Hyperswarm's info object
     * @returns {Promise<{ topics: Array, profile: object }>} Resolves when the messages has been sent to the other node.
     */
    async handshake(socket, info) {
        try {
            const { publicKey, secretKey } = this.sessionManager.getCredentials();
            const spaceTopics = await getTopicList(this.db);
            const sharelinkTopics = await getShareLinkTopics(this.db);
            const topics = [...spaceTopics, ...sharelinkTopics];

            const spaceHashListMessage = await createSpaceHashListMessage({
                hashList: topics,
                publicKey: publicKey,
                secretKey: secretKey
            });

            await this.messageManager.sendMessageToSocket(spaceHashListMessage, socket);

            const profile = await getProfileByPublicKey(this.db, publicKey);
            if (profile) {
                const profileUpdateMessage = await createProfileUpdateMessage({
                    profile: profile,
                    topics: topics,
                    publicKey: publicKey,
                    secretKey: secretKey
                });

                await this.messageManager.sendMessageToSocket(profileUpdateMessage, socket);
            }

            return { topics, profile };
        }
        catch (error) {
            console.error(error)
        }
    }

    /**
     * Destroys the hyperswarm and all socket connections,
     * calling this method after account logout or service shutdown
     * will notify all peers that this node is now out of reach.
     */
    async destroy() {
        await this.swarmInstance.destroy();
        this.swarmInstance = null;
        this.discoveryMap = {};
    }
}