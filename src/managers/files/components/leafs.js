import { createChild } from "../../../logger.js";
import { now } from "../../../utils/general.utils.js";
import {
    createSpaceFileContentRequestMessage,
    createSpaceFileContentCancelMessage
} from "../../../utils/protocol.utils.js";

const logger = createChild('LeafDerliveryScheduler');

export class LeafDeliveryScheduler {
    constructor({
        sessionManager,
        socketManager,
        messageManager,
        connectionManager,
        providerList,
        topic,
        spaceFilePath,
        downloadKey,
    }) {
        this.sessionManager = sessionManager;
        this.socketManager = socketManager;
        this.messageManager = messageManager;
        this.connectionManager = connectionManager;
        this.providerList = providerList;
        this.topic = topic;
        this.spaceFilePath = spaceFilePath;
        this.downloadKey = downloadKey;

        /**
         * Queue the leaf index ranges pending for assignment.
         * @type {Array<[number, number]>}
         * 
         * Each elemnt is a range of `[startLeaf, endLeaf]` which represents leaves that
         * have not yet been assigned to any provider.
         */
        this.queue = [];               // [[startLeaf, endLeaf], ...] ascending, not yet assigned
        this.assignments = new Map();  // publicKey -> { start, end, remaining: Set<leaf>, requestedAt }
        this.penalties = new Map(); // publicKey -> counter
    }

    get settings() {
        return this.sessionManager.getDownloadConfig();
    }

    /** Initialize the internal queue */
    seed(startLeaf, endLeaf) {
        this.queue = startLeaf <= endLeaf ? [[startLeaf, endLeaf]] : [];
    }

    /**
     * Checks if the provider has any assigned delivery.
     * @param {String} publicKey 
     * @returns {Boolean}
     */
    isIdle(publicKey) {
        return !this.assignments.has(publicKey);
    }

    /**
     * Picks and returns the publicKey of the first provider that is:
     * 1. idle with no assigments
     * 2. maintains the minimum expected leaf index.
     * @param {Number} minLeafIndex 
     * @returns {String}
     */
    pickIdleProvider(minLeafIndex) {
        let optimalProvider = null;
        let highestPenalty = null;

        for (const [publicKey, info] of this.providerList.entries()) {
            if (!this.isIdle(publicKey)) continue;
            if (info.lastRequestableLeaf === undefined) continue;
            if (info.lastRequestableLeaf < minLeafIndex) continue;

            const penalty = this.penalties.get(publicKey) || 0;
            if (highestPenalty === null || penalty < highestPenalty) {
                optimalProvider = publicKey;
                highestPenalty = penalty;
            }
        }

        return optimalProvider;
    }

    /**
     * Returns the provider publicKey that is assigned to deliver that specific leaf index.
     * @param {Number} leafIndex 
     * @returns {String|null}
     */
    getProviderForLeaf(leafIndex) {
        for (const [publicKey, assignments] of this.assignments) {
            if (leafIndex >= assignments.start && leafIndex <= assignments.end) {
                return publicKey;
            }
        }

        return null;
    }

    /**
     * Set state that a lead has arrived and free its provider once the assignment is fully complete.
     * @param {Number} leafIndex - the arrived leaf index.
     */
    markDelivered(leafIndex) {
        const publicKey = this.getProviderForLeaf(leafIndex);
        if (!publicKey) return;

        const assignment = this.assignments.get(publicKey);
        assignment.remaining.delete(leafIndex);

        if (assignment.remaining.size === 0) {
            this.assignments.delete(publicKey);
        }
    }

    /**
     * General method to distribute queued ranges to idle providers.
     * - This method assigns a range of leafs to each provider based on their lastRequestableLeaf value. 
     * - The maximum allowed range assigned to single provider is capped with `settings.assignedChunkSize`.
     */
    assign() {
        while (this.queue.length > 0) {
            const [rangeStart] = this.queue[0];
            const publicKey = this.pickIdleProvider(rangeStart);

            if (!publicKey) break;

            const [start, rangeEnd] = this.queue.shift();
            const providerLimit = this.providerList.get(publicKey).lastRequestableLeaf;
            const maximumAllowedChunkSize = start + this.settings.assignedChunkSize;
            const end = Math.min(rangeEnd, providerLimit, maximumAllowedChunkSize);

            if (end < rangeEnd) {
                this.queue.unshift([end + 1, rangeEnd]);
            }

            this.assignRange(publicKey, start, end);
        }
    }

    /**
     * Sends SpaceFileContentRequest message to provider.
     * @param {String} publicKey - provider publicKey
     * @param {Number} start - start leaf index
     * @param {Number} end - end leaf index
     * @returns {Promise<void>}
     */
    async sendContentRequest(publicKey, start, end) {
        const credentials = this.sessionManager.getCredentials();
        const message = await createSpaceFileContentRequestMessage({
            topic: this.topic,
            spaceFilePath: this.spaceFilePath,
            leafStart: start,
            leafStop: end,
            downloadKey: this.downloadKey,
            publicKey: credentials.publicKey,
            secretKey: credentials.secretKey
        });

        const sockets = this.socketManager.getConnectedSockets({ peers: [publicKey], topics: [this.topic] });
        if (sockets.length === 0) {
            this.connectionManager.connectWith(publicKey);
            return;
        }

        await this.messageManager.sendMessageToSocket(message, sockets[0]);
    }

    /**
     * Send SpaceFileContentCancel message to provider.
     * @param {String} publicKey - provider publicKey
     * @returns {Promise<void>}
     */
    async sendCancelRequest(publicKey) {
        const credentials = await this.sessionManager.getCredentials();
        const message = await createSpaceFileContentCancelMessage({
            topic: this.topic,
            downloadKey: this.downloadKey,
            publicKey: credentials.publicKey,
            secretKey: credentials.secretKey
        });

        const sockets = this.socketManager.getConnectedSockets({ peers: [publicKey], topics: [this.topic] });
        if (sockets.length > 0) {
            await this.messageManager.sendMessageToSocket(message, sockets[0]);
        }
    }


    /**
     * Create new assigment delivery range to provider.
     * @param {String} publicKey 
     * @param {Number} start 
     * @param {Number} end 
     */
    assignRange(publicKey, start, end) {
        const remaining = new Set();
        for (let leaf = start; leaf <= end; leaf++) {
            remaining.add(leaf);
        }

        this.assignments.set(publicKey, { start, end, remaining, requestedAt: now() });
        const requestPromise = this.sendContentRequest(publicKey, start, end);

        requestPromise
            .catch(error => {
                logger.warn(`Failed to request SpaceFileContentRequest`, {
                    publicKey,
                    range: { start, end },
                    error
                });
            });

        return requestPromise;
    }

    /**
     * Release the delivery assigment from the provider.
     * @param {String} publicKey - Provider publicKey
     * @returns 
     */
    releaseProvider(publicKey) {
        const assignment = this.assignments.get(publicKey);
        if (!assignment) return;

        this.assignments.delete(publicKey);
        this.requeue(assignment);
    }

    /**
     * Move the provider's delivery assigment as free-to-pick range into queue.
     * The new inserted range in queue then can be picked by other providers.
     * @param {Object} assigment - The provider's assignment record.
     */
    requeue(assigment) {
        const leaves = [...assigment.remaining].sort((a, b) => a - b);
        if (leaves.length === 0) return;

        const ranges = [];
        let start = leaves[0];
        let previous = leaves[0];

        for (let index = 1; index < leaves.length; index++) {
            if (leaves[index] === previous + 1) {
                previous = leaves[index];
                continue;
            }

            ranges.push([start, previous]);
            start = leaves[index];
            previous = leaves[index];
        }

        ranges.push([start, previous]);

        this.queue.push(...ranges);
        this.queue.sort((a, b) => a[0] - b[0]);
    }

    /**
     * Cancels any assignment that is past the timeout. This method proceeds only when
     * there is an idle provider available as alternative.
     * @returns {Promise<void>}
     */
    async reclaimStalled() {
        if (this.assignments.size === 0) return;
        // maximum allowed time to finish assigment
        const staleBefore = now() - this.settings.requestTimeoutMs;

        for (const [publicKey, assignment] of [...this.assignments.entries()]) {
            if (assignment.requestedAt > staleBefore) continue;

            const latestRemaining = Math.max(...assignment.remaining);
            const canBeReleased = [...this.providerList.entries()].some(
                ([providerPublicKey, info]) =>
                    providerPublicKey != publicKey &&
                    this.isIdle(providerPublicKey) &&
                    info.lastRequestableLeaf !== undefined &&
                    info.lastRequestableLeaf >= latestRemaining
            );

            // skip the process if the alternative provider
            // doesn't carry the full coverage for the leaf range.
            if (!canBeReleased) continue;

            // sending SpaceFileContentCancel to relieve provider from delivery
            await this.sendCancelRequest(publicKey);
            // free the leaf range and feed back to queue
            this.assignments.delete(publicKey);
            this.requeue(assignment);

            const currentPenalty = this.penalties.get(publicKey) || 0;
            this.penalties.set(publicKey, currentPenalty + 1);
        }
    }
}
