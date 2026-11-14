import * as EVENTS from '../../../constants/events.constants.js';
import { getSpace, getSpaceToTopicMap } from '../../../utils/space.utils.js';
import { createSpaceFileEventMessage } from '../../../utils/protocol.utils.js';
import { publicKeyIsAllowedToRead } from '../../../utils/policy.utils.js';

export class FileEventBroadcaster {
  private sessionManager: any;
  private socketManager: any;
  private messageManager: any;
  private stack: Map<string, Record<string, any[]>>;
  private timer: ReturnType<typeof setTimeout> | null;

  constructor(
    _emitter: any,
    {
      sessionManager,
      socketManager,
      messageManager,
    }: {
      sessionManager: any;
      socketManager: any;
      messageManager: any;
    },
  ) {
    this.sessionManager = sessionManager;
    this.socketManager = socketManager;
    this.messageManager = messageManager;

    // topic -> { add: [event stack], remove: [event stack] }
    this.stack = new Map();
    this.timer = null;
  }

  get broadcastThrottleTime() {
    return (
      this.sessionManager.session.get('files.broadcastThrottleTime') ?? 1000
    );
  }

  get db() {
    return this.sessionManager.getDatabase().db;
  }

  /**
   * Fills internal stack if no record already exists.
   * @param topic
   */
  ensureTopicStack(topic: string) {
    if (!this.stack.has(topic)) {
      this.stack.set(topic, {
        [EVENTS.SpaceFileEventOptions.ADD]: [],
        [EVENTS.SpaceFileEventOptions.REMOVE]: [],
      });
    }
  }

  /**
   * Add a file event to the pending stack and (re)start the throttle timer.
   *
   * @param mode – exactly one of EVENTS.SpaceFileEventOptions values
   * @param params
   * @param params.topic       – space topic hash
   * @param params.path        – space file path
   * @param params.publicKey   – provider publicKey (the local node)
   * @param params.timestamp   – event timestamp
   * @param params.rootHash    – file root hash
   */
  add(
    mode: 'add' | 'remove',
    params: {
      topic: string;
      path: string;
      publicKey: string;
      timestamp: number;
      rootHash: string;
      signature: string;
    },
  ) {
    const { topic, path, publicKey, timestamp, rootHash, signature } = params;

    if (!Object.values(EVENTS.SpaceFileEventOptions).includes(mode)) {
      throw new Error(
        'add mode should be defined in EVENTS.SpaceFileEventOptions',
      );
    }

    this.ensureTopicStack(topic);
    this.stack
      .get(topic)!
      [mode].push([path, publicKey, timestamp, rootHash, signature]);

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      this.timer = null;
      await this.broadcast();
    }, this.broadcastThrottleTime);
  }

  /**
   * Broadcast all remaining events and disable to timers. (used to stop internal)
   */
  async flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    await this.broadcast();
  }

  /**
   * Broadcast accumulated file events to each space seperately.
   */
  async broadcast() {
    if (this.stack.size === 0) return;

    const { publicKey, secretKey } = this.sessionManager.getCredentials();
    const topicMap = await getSpaceToTopicMap(this.db);

    for (const [spaceId, topicHash] of topicMap.entries()) {
      if (!this.stack.has(topicHash)) continue;

      const eventStack = this.stack.get(topicHash)!;
      const space = await getSpace(this.db, spaceId);

      if (!space) continue;

      const addonEvents = eventStack[EVENTS.SpaceFileEventOptions.ADD];
      const removalEvents = eventStack[EVENTS.SpaceFileEventOptions.REMOVE];

      const messageEvents: Array<{ action: string; files: any[] }> = [];

      if (addonEvents.length > 0) {
        messageEvents.push({
          action: EVENTS.SpaceFileEventOptions.ADD,
          files: addonEvents,
        });
      }

      if (removalEvents.length > 0) {
        messageEvents.push({
          action: EVENTS.SpaceFileEventOptions.REMOVE,
          files: removalEvents,
        });
      }

      if (messageEvents.length <= 0) continue;

      const message = await createSpaceFileEventMessage({
        topic: topicHash,
        events: messageEvents,
        publicKey: publicKey,
        secretKey: secretKey,
      });

      const peers = this.socketManager.getPeerKeys((publicKey: string) =>
        publicKeyIsAllowedToRead(publicKey, space),
      );

      const sockets = this.socketManager.getConnectedSockets({
        peers: peers,
        topics: [topicHash],
      });
      await this.messageManager.broadcastMessageToSockets(message, sockets);
    }

    this.stack.clear();
  }
}
