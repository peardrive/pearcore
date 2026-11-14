type ProviderInfo = { lastRequestableLeaf: number | undefined };

export class ProviderList {
  private spaceFileListManager: any;
  private topic: string;
  private spaceFilePath: string;
  private rootHash: string;
  private onDrop: ((publicKey: string) => void) | undefined;
  private providers: Map<string, ProviderInfo>;

  constructor({
    spaceFileListManager,
    topic,
    spaceFilePath,
    rootHash,
    onDrop,
  }: {
    spaceFileListManager: any;
    topic: string;
    spaceFilePath: string;
    rootHash: string;
    onDrop?: (publicKey: string) => void;
  }) {
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
   * @param publicKey - Peer's publicKey
   */
  has(publicKey: string): boolean {
    return this.providers.has(publicKey);
  }

  /**
   * Get provider's maximum requestable leaf.
   * @param publicKey - Peer's publicKey
   */
  get(publicKey: string): ProviderInfo | undefined {
    return this.providers.get(publicKey);
  }

  /**
   * Returns list of all provider publicKeys.
   */
  peers(): IterableIterator<string> {
    return this.providers.keys();
  }

  /**
   * Returns iterator over provider map entries.
   */
  entries(): IterableIterator<[string, ProviderInfo]> {
    return this.providers.entries();
  }

  /**
   * set lastRequestableLeaf parameter for the provider
   * @param publicKey - Peer's publicKey
   * @param lastRequestableLeaf - The last leaf index the provider maintains.
   */
  setAdvertisedLeaf(publicKey: string, lastRequestableLeaf: number) {
    if (!this.providers.has(publicKey)) return;
    this.providers.set(publicKey, { lastRequestableLeaf });
  }
}
