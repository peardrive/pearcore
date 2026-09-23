export class ProviderList {
    constructor({ spaceFileListManager, topic, spaceFilePath, rootHash, onDrop }) {
        this.spaceFileListManager = spaceFileListManager;
        this.topic = topic;
        this.spaceFilePath = spaceFilePath;
        this.rootHash = rootHash;
        this.onDrop = onDrop;

        this.providers = new Map();
    }

    /**
     * Sync agains the SpaceFileListManager for newely seen peers are added as provider.
     */
    refresh() {
        const spaceFiles = this.spaceFileListManager.get(this.topic);
        const variant = spaceFiles?.[this.spaceFilePath]?.[this.rootHash];
        const currentProviders = new Set(variant ? Object.keys(variant.peers) : []);

        // insert new providers into the list
        for (const publicKey of currentProviders) {
            if (!this.providers.has(publicKey)) {
                this.providers.set(publicKey, { lastRequestableLeaf: undefined });
            }
        }

        // clear list from removed providers
        for (const publicKey of this.providers.keys()) {
            if (!currentProviders.has(publicKey)) {
                this.providers.delete(publicKey);
                this.onDrop?.(publicKey);
            }
        }
    }

    /**
     * Checks if the provider is in the list
     * @param {String} publicKey - Peer's publicKey
     * @returns {Boolean}
     */
    has(publicKey) {
        return this.providers.has(publicKey);
    }

    /**
     * Get provider's maximum requestable leaf.
     * @param {String} publicKey - Peer's publicKey
     * @returns {{ lastRequestableLeaf: Number }}
     */
    get(publicKey) {
        return this.providers.get(publicKey);
    }

    /**
     * Returns list of all provider publicKeys.
     * @returns {Array<String>}
     */
    peers() {
        return this.providers.keys();
    }

    /**
     * Returns iterator over provider map entries.
     * @returns {Iterator<[ String, { lastRequestableLeaf: Number } ]>}
     */
    entries() {
        return this.providers.entries();
    }

    /**
     * set lastRequestableLeaf parameter for the provider
     * @param {String} publicKey - Peer's publicKey
     * @param {Number} lastRequestableLeaf - The last leaf index the provider maintains.
     */
    setAdvertisedLeaf(publicKey, lastRequestableLeaf) {
        if (!this.providers.has(publicKey)) return;
        this.providers.set(publicKey, { lastRequestableLeaf });
    }
}