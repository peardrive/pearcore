import { createChild } from '../logger.js';
import { createSpaceForPublicKey, deleteSpace, generateSpaceTopic, getSpace, getSpaceTopicHash, querySpace } from "../utils/space.utils.js";
import { encodeShareLink, decodeShareLink, queryShareLink, deleteShareLink, saveShareLink } from "../utils/sharelink.utils.js";
import { isString } from '../utils/general.utils.js';
import { SpaceInstance } from './interface.js';

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

        const { spaceId } = await createSpaceForPublicKey(
            this.#db,
            { ...payload, publicKey },
            secretKey
        );

        const spaceRecord = await getSpace(this.#db, spaceId);
        if (!spaceRecord) {
            throw new Error(`Space creating has failed for this payload: ${payload}`);
        }

        const instance = new SpaceInstance(spaceRecord, 'space', this.sharelinkPrefix);

        await this.managers.connection.join(instance.topicHash);
        await this.managers.connection.update();

        return instance;
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

        const sharelinkRecord = await saveShareLink(this.#db, decoded);
        const instance = new SpaceInstance(sharelinkRecord, 'sharelink', this.sharelinkPrefix);

        await this.managers.connection.join(instance.topicHash);
        await this.managers.connection.update();

        return instance;
    }

    /**
     * Leaves a space (either full or joined) and removes it from the database.
     * @param {SpaceInstance} space - The space instance to leave.
     * @returns {Promise<void>}
     * @throws {Error} If the instance is invalid or deletion fails.
     */
    async leave(space) {
        await this.managers.connection.leave(space.topicHash);
        await this.managers.connection.update();

        try {
            if (space.isSync) {
                await deleteSpace(this.#db, space.id);
            } else {
                await deleteShareLink(this.#db, space.id);
            }
        } catch(error) {
            return; // race condition: sharelink converts to space record before deletion
        }
    }

    /**
     * Lists all spaces (both full and joined), with network discovery status.
     * @param {Object} [params] - Filtering options (same as querySpace/queryShareLink).
     * @param {string} [params.spaceName]
     * @param {string} [params.publicKey]
     * @param {string} [params.nonce]
     * @returns {Promise<SpaceInstance[]>}
     */
    async list(params = {}) {
        const [spaceRows, sharelinkRows] = await Promise.all([
            querySpace(this.#db, params),
            queryShareLink(this.#db, params),
        ]);

        const instances = [];

        for (const row of spaceRows) {
            const inst = new SpaceInstance(row, 'space', this.sharelinkPrefix);
            instances.push(inst);
        }

        for (const row of sharelinkRows) {
            const inst = new SpaceInstance(row, 'sharelink', this.sharelinkPrefix);
            instances.push(inst);
        }

        return instances;
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