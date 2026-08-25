import { isString } from "../utils/general.utils.js";
import { encodeShareLink } from "../utils/sharelink.utils.js";
import { generateSpaceTopic, getSpaceTopicHash } from "../utils/space.utils.js";

/**
 * Read‑only representation of a space.
 */
export class SpaceInstance {
    #data; // original object payload
    #type; // instance type (space/sharelink)

    /**
     * @param {Object} data - Raw database row.
     * @param {string} data.id - Primary key (spaceId or sharelinkId).
     * @param {string} data.spaceName
     * @param {string} data.publicKey
     * @param {string} data.nonce
     * @param {number} [data.timestamp]
     * @param {number} [data.permissionBroadcast]
     * @param {number} [data.permissionRead]
     * @param {string} [data.signature]
     * @param {string|null} [data.secret]
     * @param {string[]} [data.broadcastWhitelist]
     * @param {string[]} [data.readWhitelist]
     * @param {'space'|'sharelink'} type - Indicates the origin of the record.
     * @param {string} [prefix='pearcore'] - Prefix used for sharelink encoding.
     */
    constructor(data, type, prefix = 'preacore') {
        this.#data = data;
        this.#type = type;
        this.prefix = prefix;
    }

    setPrefix(prefix) {
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
        return this.#type === 'space' ? this.#data.permissionBroadcast : undefined;
    }

    get permissionRead() {
        return this.#type === 'space' ? this.#data.permissionRead : undefined;
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
            this.prefix
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