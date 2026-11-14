import { createSpaceFileTreeRequestMessage } from '../../../utils/protocol.utils.js';
import { verifyMerkleTree } from '../../../utils/merkletree.utils.js';
import { createChild } from '../../../logger.js';

const logger: any = createChild('SpaceTreePuller');

export class SpaceTreePuller {
  [key: string]: any;

  constructor({
    sessionManager,
    socketManager,
    messageManager,
    connectionManager,
    topic,
    spaceFilePath,
    rootHash,
  }: any) {
    this.sessionManager = sessionManager;
    this.socketManager = socketManager;
    this.messageManager = messageManager;
    this.connectionManager = connectionManager;
    this.topic = topic;
    this.spaceFilePath = spaceFilePath;
    this.rootHash = rootHash;

    this.pendingRequests = new Map(); // nonce -> publicKey
  }

  /**
   * Checks whether the publicKey has pending SpaceFileTreeRequest to response.
   * @param publicKey
   */
  isPending(publicKey: string) {
    for (const pending of this.pendingRequests.values()) {
      if (pending === publicKey) return true;
    }

    return false;
  }

  /**
   *
   * @param publicKey - Peer's publicKey
   * @param info
   * @param info.lastRequestableLeaf - Provider's maximum leaf index maintaind.
   * @param knownLeafCount - Number of leaves in the Merkle tree.
   */
  shouldRequest(
    publicKey: string,
    info: { lastRequestableLeaf?: number } | undefined,
    knownLeafCount: number | null,
  ) {
    // avoid multiple request to one publicKey while they didn't response the earlier requests.
    if (this.isPending(publicKey)) return false;

    // should request if no context about provider's leaves is maintained.
    if (!info || !info.lastRequestableLeaf) return true;

    // this means Merkle Tree is not maintained internally, request is required to maintain the full tree.
    if (!knownLeafCount) return true;

    return info.lastRequestableLeaf < knownLeafCount - 1;
  }

  /**
   * Sends SpaceFileTreeRequest message to the peer.
   * @param publicKey - Peer's publicKey
   */
  async request(publicKey: string) {
    const credentials = this.sessionManager.getCredentials();
    const message = await createSpaceFileTreeRequestMessage({
      topic: this.topic,
      spaceFilePath: this.spaceFilePath,
      rootHash: this.rootHash,
      publicKey: credentials.publicKey,
      secretKey: credentials.secretKey,
    });

    try {
      const sockets = this.socketManager.getConnectedSockets({
        peers: [publicKey],
        topics: [this.topic],
      });

      if (sockets.length === 0) {
        this.connectionManager.connectWith(publicKey);
        return;
      }

      await this.messageManager.sendMessageToSocket(message, sockets[0]);
      this.pendingRequests.set(message.nonce, publicKey);
    } catch (error) {
      logger.warn('Failed to send SpaceFileTreeRequest', {
        publicKey,
        spaceFilePath: this.spaceFilePath,
        rootHash: this.rootHash,
      });

      this.pendingRequests.delete(message.nonce);
    }
  }

  /**
   * Validates an incoming SpacefileTreeResponse for valid tree and relevance to rootHash.
   * @param message
   * @return {{ succeed: Boolean, reason: String, publicKey: String, tree: Object, lastRequestableLeaf: number }}
   */
  verify(message: any) {
    if (message.topic !== this.topic) {
      return { succeed: false, reason: 'message topic mismatch' };
    }

    const { tree, lastRequestableLeaf, replyNonce } = message.payload;

    if (this.pendingRequests.get(replyNonce) !== message.publicKey) {
      return { succeed: false, reason: 'umatched message nonce' };
    }

    this.pendingRequests.delete(replyNonce);

    if (tree.rootHash !== this.rootHash) {
      return { succeed: false, reason: 'tree rootHash mismatch' };
    }

    const verification = verifyMerkleTree(tree);
    if (!verification.isValid) {
      return { succeed: false, reason: verification.reason };
    }

    return {
      succeed: true,
      reason: 'verification succeed',
      publicKey: message.publicKey,
      tree: tree,
      lastRequestableLeaf: lastRequestableLeaf,
    };
  }
}
