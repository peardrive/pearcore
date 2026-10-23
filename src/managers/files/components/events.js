import * as EVENTS from '../../../constants/events.constants.js';
import { getSpace, getSpaceToTopicMap } from "../../../utils/space.utils.js";
import { createSpaceFileEventMessage } from "../../../utils/protocol.utils.js";
import { publicKeyIsAllowedToRead } from '../../../utils/policy.utils.js';


export class FileEventBroadcaster {
    constructor(emitter, { sessionManager, socketManager, messageManager }) {
        this.sessionManager = sessionManager;
        this.socketManager = socketManager;
        this.messageManager = messageManager;

        // topic -> { add: [event stack], remove: [event stack] }
        this.stack = new Map();
        this.timer = null;
    }

    get broadcastThrottleTime() {
        return this.sessionManager.session.get('files.broadcastThrottleTime') ?? 1000;
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    /**
     * Fills internal stack if no record already exists.
     * @param {string} topic 
     */
    ensureTopicStack(topic) {
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
     * @param {'add'|'remove'} mode – exactly one of EVENTS.SpaceFileEventOptions values
     * @param {Object} params
     * @param {string} params.topic       – space topic hash
     * @param {string} params.path        – space file path
     * @param {string} params.publicKey   – provider publicKey (the local node)
     * @param {number} params.timestamp   – event timestamp
     * @param {string} params.rootHash    – file root hash
     */
    add(mode, params) {
        const { topic, path, publicKey, timestamp, rootHash, signature } = params;

        if (!Object.values(EVENTS.SpaceFileEventOptions).includes(mode)) {
            throw new Error("add mode should be defined in EVENTS.SpaceFileEventOptions");
        }

        this.ensureTopicStack(topic);
        this.stack.get(topic)[mode].push([path, publicKey, timestamp, rootHash, signature]);
        // a REMOVE makes the kept ADD for this path history (signed once, patch-pearcore-lost)
        if (mode === EVENTS.SpaceFileEventOptions.REMOVE) { try { this.onRemove?.(params); } catch { /* best effort */ } }

        // PearDrive patch (Oct 23 2026): no request lost in silence: a window opened by the first event, closed by
        // time or by size — a steady stream of adds never postpones it
        let pending = 0;
        for (const st of this.stack.values()) pending += st[EVENTS.SpaceFileEventOptions.ADD].length + st[EVENTS.SpaceFileEventOptions.REMOVE].length;
        if (pending >= 64) {
            if (this.timer) { clearTimeout(this.timer); this.timer = null; }
            this.broadcast().catch(() => {});
            return;
        }
        if (!this.timer) this.timer = setTimeout(async () => { this.timer = null; await this.broadcast(); }, this.broadcastThrottleTime);
    }

    /**
     * Broadcast all remaining events and disable to timers. (used to stop internal)
     * @returns {Promise<void>}
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
     * @returns {Promise<void>}
     */
    async broadcast() {
        if (this.stack.size === 0) return;
        // take the batch now: events added while it is signed and sent go in the next one
        const batch = this.stack;
        this.stack = new Map();

        const { publicKey, secretKey } = this.sessionManager.getCredentials();
        const topicMap = await getSpaceToTopicMap(this.db);

        for (const [spaceId, topicHash] of topicMap.entries()) {
            if (!batch.has(topicHash)) continue;

            const eventStack = batch.get(topicHash);
            const space = await getSpace(this.db, spaceId);

            if (!space) continue;

            const addonEvents = eventStack[EVENTS.SpaceFileEventOptions.ADD];
            const removalEvents = eventStack[EVENTS.SpaceFileEventOptions.REMOVE];

            const messageEvents = [];

            if (addonEvents.length > 0) {
                messageEvents.push({ action: EVENTS.SpaceFileEventOptions.ADD, files: addonEvents });
            }

            if (removalEvents.length > 0) {
                messageEvents.push({ action: EVENTS.SpaceFileEventOptions.REMOVE, files: removalEvents });
            }

            if (messageEvents.length <= 0) continue;

            const message = await createSpaceFileEventMessage({
                topic: topicHash,
                events: messageEvents,
                publicKey: publicKey,
                secretKey: secretKey
            });

            // peerFilter: an optional host predicate on top of the read permission, for an
            // application that already tells some peers about its files another way
            const peers = this.socketManager.getPeerKeys(
                publicKey => publicKeyIsAllowedToRead(publicKey, space) && (!this.peerFilter || this.peerFilter(publicKey))
            );

            const sockets = this.socketManager.getConnectedSockets({ peers: peers, topics: [topicHash] });
            if (sockets.length === 0) continue;
            await this.messageManager.broadcastMessageToSockets(message, sockets);
        }
    }
}