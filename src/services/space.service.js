import { createChild } from '../logger.js';
import { deleteSpace, generateSpaceTopic, getSpaceTopicHash, querySpace } from "../utils/space.utils.js";
import { encodeShareLink, decodeShareLink, queryShareLink, deleteShareLink, saveShareLink } from "../utils/sharelink.utils.js";
import { isString } from '../utils/general.utils.js';

const logger = createChild('SpaceService');

export class SpaceService {
    constructor(emitter, { managers } = {}) {
        this.managers = managers;
        this.sharelinkPrefix = 'pearcore';
    }

    get #db() {
        const { db } = this.managers.session.getDatabase();
        return db;
    }

    setPrefix(prefix) {
        this.sharelinkPrefix = prefix;
    }

    /**
     * Creates a new space with configurable permissions and joins the associated space topic in the p2p network.
     * @param {Object} params - Space configuration parameters
     * @param {string} params.spaceName - Human-readable name for the space
     * @param {boolean} [params.permissionBroadcast=true] - Whether broadcasting is permissioned
     * @param {Array<string>} [params.broadcastWhitelist=[]] - Public keys allowed to broadcast
     * @param {boolean} [params.permissionRead=true] - Whether reading is permissioned
     * @param {Array<string>} [params.readWhitelist=[]] - Public keys allowed to read
     * @returns {Promise<Object>} Resolved when the object instance has been created and network discovery has been initiated.
     */
    async create(payload) {
        const { publicKey, secretKey } = this.managers.session.getCredentials();
        const createSpaceResult = await this.managers.storage.createSpace(
            { ...payload, publicKey },
            secretKey
        );

        const generatedShareLink = encodeShareLink(createSpaceResult, this.sharelinkPrefix);
        const generatedTopic = generateSpaceTopic(
            createSpaceResult.spaceName,
            createSpaceResult.publicKey,
            createSpaceResult.nonce
        );

        const spaceTopicHash = getSpaceTopicHash(createSpaceResult)
        await this.managers.connection.join(spaceTopicHash);
        await this.managers.connection.update();

        return {
            ...createSpaceResult,
            sharelink: generatedShareLink,
            topic: generatedTopic,
            topicHash: spaceTopicHash
        };
    }

    /**
     * Joins an existing space using sharelink.
     * @param {string} sharelink - Join parameters
     * @returns {Promise<Object>} Promise resolving to the decoded space metadata
     * @throws {Error} If shareLink is invalid or decoding fails
     */
    async join(sharelink) {
        if (!isString(sharelink)) {
            throw new Error('Invalid sharelink parameter');
        }

        const decoded = decodeShareLink(sharelink);

        const spaceQueryResult = await querySpace(this.#db, decoded);
        const sharelinkQueryResult = await queryShareLink(this.#db, decoded);

        if (spaceQueryResult.length > 0 || sharelinkQueryResult.length > 0) {
            throw new Error(`Record for sharelink already exists: ${sharelink}`);
        }

        await saveShareLink(this.#db, decoded);

        const spaceTopicHash = getSpaceTopicHash(decoded);
        await this.managers.connection.join(spaceTopicHash);
        await this.managers.connection.update();

        return decoded;
    }

    /**
     * Leave a space using the sharelink. Additionally, this methods broadcasts
     * the updated topic list within connected nodes with the removal the the space.
     * @param {String} sharelink 
     */
    async leave(sharelink) {
        if (!isString(sharelink)) {
            throw new Error(`shareLink is invalid: ${sharelink}`);
        }

        const decoded = decodeShareLink(sharelink);
        if (!decoded) {
            throw new Error(`Parsing shareLink failed: ${sharelink}`);
        }

        const spaceQueryResult = await querySpace(this.#db, decoded);
        const sharelinkQueryResult = await queryShareLink(this.#db, decoded);

        if (spaceQueryResult.length === 0 && sharelinkQueryResult.length === 0) {
            throw new Error(`No record found for sharelink: ${sharelink}`);
        }

        if (spaceQueryResult.length > 0) {
            for (const space of spaceQueryResult) {
                await deleteSpace(this.#db, space.id);
            }
        }

        if (sharelinkQueryResult.length > 0) {
            for (const sharelinkRecord of sharelinkQueryResult) {
                await deleteShareLink(this.#db, sharelinkRecord.id);
            }
        }

        const spaceTopicHash = getSpaceTopicHash(decoded);
        await this.managers.connection.leave(spaceTopicHash);
        await this.managers.connection.update();
    }

    /**
     * Retrieves a list of spaces from storage, optionally filtered by owner public key.
     * @param {Object} [options] - Optional filtering parameters
     * @param {string} [options.publicKey] - Filter spaces by owner's public key (optional)
     * @returns {Promise<Array<Object>>} Promise resolving to array of space metadata objects
     */
    async list(params = {}) {
        const spaceQuery = await this.managers.storage.querySpace(params);
        const spaces = spaceQuery.map(space => {
            const topic = generateSpaceTopic(space.spaceName, space.publicKey, space.nonce);
            const topicHash = getSpaceTopicHash(space);
            const isOnDiscovery = this.managers.connection.discoveryMap.hasOwnProperty(topicHash);

            return {
                ...space,
                sharelink: encodeShareLink(space, this.sharelinkPrefix),
                topic: topic,
                topicHash: topicHash,
                discoverable: isOnDiscovery,
                isSync: true
            };
        });

        const sharelinksQuery = await this.managers.storage.queryShareLink(params);
        const sharelinks = sharelinksQuery.map(space => {
            const topic = generateSpaceTopic(space.spaceName, space.publicKey, space.nonce);
            const topicHash = getSpaceTopicHash(space);
            const isOnDiscovery = this.managers.connection.discoveryMap.hasOwnProperty(topicHash);

            return {
                ...space,
                sharelink: encodeShareLink(space, this.sharelinkPrefix),
                topic: topic,
                topicHash: topicHash,
                discoverable: isOnDiscovery,

                // Sharelinks are just spaces that are not initiates using
                // p2p space syncing. This we use isSync to false to address that fact.
                isSync: false
            };
        });

        return [...spaces, ...sharelinks];
    }

    /**
     * Retrieves the current state of all spaces and network peers.
     * @returns {Promise<Object>} A promise that resolves to the current state object with:
     *   - spaces: { synced: Array<{topic: string, sharelink: string}>, queued: Array<{topic: string, sharelink: string}> }
     *   - network: { [peerId: string]: { topics: Array<string>, throttled: boolean, requestCount: number } }
     */
    async getCurrentState() {
        const socketSnapShot = this.managers.sockets.getSnapShot({ sortByPeers: true });
        const throttleSnapShot = this.managers.throttle.getSnapShot();
        const hasThrottleRecord = peer => throttleSnapShot.hasOwnProperty(peer);

        const spaceList = await this.list();
        const spaces = spaceList.filter(space => space.isSync);
        const queue = spaceList.filter(space => !space.isSync);

        const getInfo = space => ({
            topic: space.topicHash,
            sharelink: space.sharelink
        });

        const spaceState = {
            synced: spaces.map(space => getInfo(space)),
            queued: queue.map(space => getInfo(space))
        }

        const networkState = {};

        for (const peer in socketSnapShot) {
            const topics = socketSnapShot[peer];

            const throttleRecord = throttleSnapShot[peer];
            const recordIsAvailable = hasThrottleRecord(peer);

            networkState[peer] = {
                topics: topics,
                throttled: recordIsAvailable ? throttleRecord.isThrottled : false,
                requestCount: recordIsAvailable ? throttleRecord.count : 0
            };
        }

        return {
            spaces: spaceState,
            network: networkState
        };
    }
}