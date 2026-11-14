import { createChild } from '../logger.js';
import { isString } from '../utils/general.utils.js';
import {
  encodeShareLink,
  decodeShareLink,
  queryShareLink,
  deleteShareLink,
  saveShareLink,
} from '../utils/sharelink.utils.js';
import {
  generateSpaceTopic,
  getSpaceTopicHash,
  createSpaceForPublicKey,
  deleteSpace,
  getSpace,
  querySpace,
  updateSpaceForPublicKey,
} from '../utils/space.utils.js';
import { createSpaceSyncMessage } from '../utils/protocol.utils.js';
import { publicKeyIsAllowedToRead } from '../utils/policy.utils.js';

const logger = createChild('SpaceService');

/**
 * Read‑only representation of a space.
 */
export class SpaceInstance {
  [key: string]: any;
  #data; // original object payload
  #type; // instance type (space/sharelink)

  /**
   * @param data - Raw database row.
   * @param data.id - Primary key (spaceId or sharelinkId).
   * @param data.spaceName
   * @param data.publicKey
   * @param data.nonce
   * @param [data.timestamp]
   * @param [data.permissionBroadcast]
   * @param [data.permissionRead]
   * @param [data.signature]
   * @param [data.secret]
   * @param [data.broadcastWhitelist]
   * @param [data.readWhitelist]
   * @param type - Indicates the origin of the record.
   * @param [prefix='pearcore'] - Prefix used for sharelink encoding.
   */
  constructor(data: any, type: 'space' | 'sharelink', prefix = 'preacore') {
    this.#data = data;
    this.#type = type;
    this.prefix = prefix;
  }

  toObject() {
    return this.#data;
  }

  setPrefix(prefix: string) {
    if (isString(prefix)) {
      this.prefix = prefix;
    }
  }

  get id() {
    return this.#data.id;
  }

  get spaceName() {
    return this.#data.spaceName;
  }

  get timestamp() {
    return this.#data.timestamp;
  }

  get publicKey() {
    return this.#data.publicKey;
  }

  get nonce() {
    return this.#data.nonce;
  }

  get isSync() {
    return this.#type == 'space' ? true : false;
  }

  get permissionBroadcast() {
    return this.#type === 'space'
      ? Boolean(this.#data.permissionBroadcast)
      : undefined;
  }

  get permissionRead() {
    return this.#type === 'space'
      ? Boolean(this.#data.permissionRead)
      : undefined;
  }

  get signature() {
    return this.#type === 'space' ? this.#data.signature : undefined;
  }

  get secret() {
    return this.#type === 'space' ? (this.#data.secret ?? null) : undefined;
  }

  get broadcastWhitelist() {
    return this.#type === 'space' ? (this.#data.broadcastWhitelist ?? []) : [];
  }

  get readWhitelist() {
    return this.#type === 'space' ? (this.#data.readWhitelist ?? []) : [];
  }

  get sharelink() {
    return encodeShareLink(
      {
        spaceName: this.spaceName,
        publicKey: this.publicKey,
        nonce: this.nonce,
      },
      this.prefix,
    );
  }

  get topic() {
    return generateSpaceTopic(this.spaceName, this.publicKey, this.nonce);
  }

  get topicHash() {
    return getSpaceTopicHash({
      spaceName: this.spaceName,
      publicKey: this.publicKey,
      nonce: this.nonce,
    });
  }
}

export class SpaceService {
  [key: string]: any;

  constructor(emitter: any, { managers }: any = {}) {
    this.managers = managers;
    this.sharelinkPrefix = 'pearcore';
  }

  get #db() {
    const { db } = this.managers.session.getDatabase();
    return db;
  }

  setPrefix(prefix: string) {
    this.sharelinkPrefix = prefix;
  }

  /**
   * Creates a new space with configurable permissions and joins the associated space topic in the p2p network.
   * @param params - Space configuration parameters
   * @param params.spaceName - Human-readable name for the space
   * @param [params.permissionBroadcast=true] - Whether broadcasting is permissioned
   * @param [params.broadcastWhitelist=[]] - Public keys allowed to broadcast
   * @param [params.permissionRead=true] - Whether reading is permissioned
   * @param [params.readWhitelist=[]] - Public keys allowed to read
   * @returns Resolved when the object instance has been created and network discovery has been initiated.
   */
  async create(payload: any) {
    const { publicKey, secretKey } = this.managers.session.getCredentials();

    const { spaceId } = await createSpaceForPublicKey(
      this.#db,
      { ...payload, publicKey },
      secretKey,
    );

    const spaceRecord = await getSpace(this.#db, spaceId);
    if (!spaceRecord) {
      throw new Error(`Space creating has failed for this payload: ${payload}`);
    }

    const instance = new SpaceInstance(
      spaceRecord,
      'space',
      this.sharelinkPrefix,
    );

    await this.managers.connection.join(instance.topicHash);
    await this.managers.connection.update();

    return instance;
  }

  /**
   * Updates permission rules for space and broadcast the update to members.
   * @param space - the original space instance
   * @param params - Space configuration parameters
   * @param [params.permissionBroadcast=true] - Whether broadcasting is permissioned
   * @param [params.broadcastWhitelist=[]] - Public keys allowed to broadcast
   * @param [params.permissionRead=true] - Whether reading is permissioned
   * @param [params.readWhitelist=[]] - Public keys allowed to read
   * @returns */
  async update(space: SpaceInstance, params: any) {
    const { publicKey, secretKey } = this.managers.session.getCredentials();

    if (space.publicKey !== publicKey) {
      throw new Error(
        'Space update failed. You can only update self-owned spaces.',
      );
    }

    const exists = await getSpace(this.#db, space.id);
    if (!exists) {
      throw new Error('Space does not exists.');
    }

    await updateSpaceForPublicKey(this.#db, space.id, params, secretKey);

    const updatedSpace = await getSpace(this.#db, space.id);
    if (!updatedSpace) throw new Error('Updated space could not be found.');
    const topicHash = getSpaceTopicHash(updatedSpace);

    const message = await createSpaceSyncMessage({
      topic: topicHash,
      space: updatedSpace,
      publicKey: publicKey,
      secretKey: secretKey,
    });

    await this.managers.connection.update();

    const peers = this.managers.sockets.getPeerKeys((key: string) =>
      publicKeyIsAllowedToRead(key, updatedSpace),
    );
    const sockets = this.managers.sockets.getConnectedSockets({
      peers: peers,
      topics: [topicHash],
    });

    await this.managers.message.broadcastMessageToSockets(message, sockets);

    const instance = new SpaceInstance(updatedSpace, 'space');
    return instance;
  }

  /**
   * Joins an existing space using sharelink.
   * @param sharelink - Join parameters
   * @returns Promise resolving to the decoded space metadata
   * @throws {Error} If shareLink is invalid or decoding fails
   */
  async join(sharelink: string) {
    if (!isString(sharelink)) {
      throw new Error('Invalid sharelink parameter');
    }

    const decoded = decodeShareLink(sharelink);
    if (!decoded) throw new Error('Invalid sharelink parameter');

    const spaceQueryResult = await querySpace(this.#db, decoded);
    const sharelinkQueryResult = await queryShareLink(this.#db, decoded);

    if (spaceQueryResult.length > 0 || sharelinkQueryResult.length > 0) {
      throw new Error(`Record for sharelink already exists: ${sharelink}`);
    }

    const sharelinkRecord = await saveShareLink(this.#db, decoded);
    const instance = new SpaceInstance(
      sharelinkRecord,
      'sharelink',
      this.sharelinkPrefix,
    );

    await this.managers.connection.join(instance.topicHash);
    await this.managers.connection.update();

    return instance;
  }

  /**
   * Leaves a space (either full or joined) and removes it from the database.
   * @param space - The space instance to leave.
   * @returns * @throws {Error} If the instance is invalid or deletion fails.
   */
  async leave(space: SpaceInstance) {
    await this.managers.connection.leave(space.topicHash);
    await this.managers.connection.update();

    try {
      if (space.isSync) {
        await deleteSpace(this.#db, space.id);
      } else {
        await deleteShareLink(this.#db, space.id);
      }
    } catch (error) {
      return; // race condition: sharelink converts to space record before deletion
    }
  }

  /**
   * Lists all spaces (both full and joined), with network discovery status.
   * @param [params] - Filtering options (same as querySpace/queryShareLink).
   * @param [params.spaceName]
   * @param [params.publicKey]
   * @param [params.nonce]
   * @returns */
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
   * @returns A promise that resolves to the current state object with:
   *   - spaces: { synced: Array<{topic: string, sharelink: string}>, queued: Array<{topic: string, sharelink: string}> }
   *   - network: { [peerId: string]: { topics: Array<string>, throttled: boolean, requestCount: number } }
   */
  async getCurrentState() {
    const socketSnapShot = this.managers.sockets.getSnapShot({
      sortByPeers: true,
    });
    const throttleSnapShot = this.managers.throttle.getSnapShot();
    const hasThrottleRecord = (peer: string) =>
      throttleSnapShot.hasOwnProperty(peer);

    const spaceList = await this.list();
    const spaces = spaceList.filter((space) => space.isSync);
    const queue = spaceList.filter((space) => !space.isSync);

    const getInfo = (space: SpaceInstance) => ({
      topic: space.topicHash,
      sharelink: space.sharelink,
    });

    const spaceState = {
      synced: spaces.map((space) => getInfo(space)),
      queued: queue.map((space) => getInfo(space)),
    };

    const networkState: Record<string, any> = {};

    for (const peer in socketSnapShot) {
      const topics = socketSnapShot[peer];

      const throttleRecord = throttleSnapShot[peer];
      const recordIsAvailable = hasThrottleRecord(peer);

      networkState[peer] = {
        topics: topics,
        throttled: recordIsAvailable ? throttleRecord.isThrottled : false,
        requestCount: recordIsAvailable ? throttleRecord.count : 0,
      };
    }

    return {
      spaces: spaceState,
      network: networkState,
    };
  }
}
