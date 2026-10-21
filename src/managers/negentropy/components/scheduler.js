import { createChild } from "../../../logger.js";
import { now } from "../../../utils/general.utils.js";
import { SessionManager } from "../../session.manager.js";

const logger = createChild('MessageRequestScheduler');

/**
 * Work-stealing scheduler for the messages a node needs from ONE space.
 *
 * Every finished reconciliation session registers the peer as a provider of the
 * message ids the local node is missing. Missing ids are requested in batches:
 * each provider holds at most one batch at a time and receives the next batch as
 * soon as its current one is delivered. Equally fast providers end up with an even
 * share of the ids they have in common, while faster providers naturally take more.
 *
 * - Ids provided by fewer peers are requested first (rarest-first), so ids that only
 *   one peer can provide are not stuck behind a busy provider.
 * - An assignment that is not delivered within `requestTimeout`, or whose provider
 *   disconnects, goes back to the queue and can be picked by another provider.
 * - Stalled providers are penalized and picked last.
 */
export class MessageRequestScheduler {
    /**
     * @param {Object} params
     * @param {SessionManager} params.sessionManager - Current session instance.
     * @param {string} params.topic - Space topic hash.
     * @param {(publicKey: string, messageIds: string[]) => Promise<void>} [params.request] - Sends the request for a batch of message ids to a provider.
     */
    constructor({ sessionManager, topic, request = null }) {
        this.sessionManager = sessionManager;
        this.topic = topic;
        this.request = request;

        /** Message ids waiting for assignment, in insertion order. @type {Set<string>} */
        this.queue = new Set();
        /** messageId -> Set of provider public keys. @type {Map<string, Set<string>>} */
        this.providers = new Map();
        /** publicKey -> { messageIds: Set<string>, requestedAt: number } */
        this.assignments = new Map();
        /** messageId -> provider publicKey it is currently assigned to. */
        this.assignedTo = new Map();
        /** publicKey -> penalty counter. */
        this.penalties = new Map();
    }

    get settings() {
        return this.sessionManager.getMessageConfig().reconciliation;
    }

    /** Number of message ids that are queued or assigned. */
    get pendingCount() {
        return this.queue.size + this.assignedTo.size;
    }

    /**
     * Sets the function that requests a batch of message ids from a provider.
     * @param {(publicKey: string, messageIds: string[]) => Promise<void>} request
     */
    setRequestHandler(request) {
        this.request = request;
    }

    /**
     * Checks if the provider has no assigned batch.
     * @param {string} publicKey
     * @returns {boolean}
     */
    isIdle(publicKey) {
        return !this.assignments.has(publicKey);
    }

    /**
     * True once every requested message has been delivered.
     * @returns {boolean}
     */
    isComplete() {
        return this.pendingCount === 0;
    }

    /**
     * Registers a peer as provider of the given message ids.
     * @param {string} publicKey - Provider public key.
     * @param {Iterable<string>} messageIds - Message ids the provider can deliver.
     */
    addProvider(publicKey, messageIds) {
        for (const messageId of messageIds) {
            if (!this.providers.has(messageId)) {
                this.providers.set(messageId, new Set());
            }

            this.providers.get(messageId).add(publicKey);

            if (!this.assignedTo.has(messageId)) {
                this.queue.add(messageId);
            }
        }
    }

    /**
     * Removes a provider (e.g. disconnected peer). Its assignment goes back to the queue,
     * and ids that no other peer can provide are dropped until a new provider registers them.
     * @param {string} publicKey - Provider public key.
     */
    removeProvider(publicKey) {
        this.releaseProvider(publicKey);

        for (const [messageId, providers] of this.providers) {
            providers.delete(publicKey);

            if (providers.size === 0) {
                this.providers.delete(messageId);
                this.queue.delete(messageId);
            }
        }

        this.penalties.delete(publicKey);
    }

    /**
     * Marks messages as delivered (stored locally) and frees their providers.
     * @param {Iterable<string>} messageIds
     */
    markDelivered(messageIds) {
        for (const messageId of messageIds) {
            this.queue.delete(messageId);
            this.providers.delete(messageId);

            const publicKey = this.assignedTo.get(messageId);
            if (!publicKey) continue;

            this.assignedTo.delete(messageId);

            const assignment = this.assignments.get(publicKey);
            assignment.messageIds.delete(messageId);

            if (assignment.messageIds.size === 0) {
                this.assignments.delete(publicKey);
            }
        }
    }

    /**
     * Returns the idle providers that can deliver at least one queued id,
     * ordered by their penalty (lowest first).
     * @returns {string[]}
     */
    pickIdleProviders() {
        const candidates = new Set();

        for (const messageId of this.queue) {
            for (const publicKey of this.providers.get(messageId) ?? []) {
                if (this.isIdle(publicKey)) candidates.add(publicKey);
            }
        }

        return [...candidates].sort((a, b) => 
            (this.penalties.get(a) ?? 0) - (this.penalties.get(b) ?? 0));
    }

    /**
     * Picks the next batch for a provider: queued ids it can deliver, rarest first.
     * @param {string} publicKey
     * @returns {string[]}
     */
    pickBatch(publicKey) {
        const candidates = [];

        for (const messageId of this.queue) {
            const providers = this.providers.get(messageId);
            if (providers?.has(publicKey)) {
                candidates.push([messageId, providers.size]);
            }
        }

        // stable sort keeps the queue order between ids with the same rarity
        candidates.sort((a, b) => a[1] - b[1]);

        return candidates
            .slice(0, this.settings.requestBatchSize)
            .map(([messageId]) => messageId);
    }

    /**
     * Distributes queued ids to idle providers, one batch per provider.
     * @returns {Array<{ publicKey: string, messageIds: string[] }>} The new assignments.
     */
    assign() {
        if (!this.request) return [];

        const dispatched = [];

        for (const publicKey of this.pickIdleProviders()) {
            const messageIds = this.pickBatch(publicKey);
            if (messageIds.length === 0) continue;

            this.assignBatch(publicKey, messageIds);
            dispatched.push({ publicKey, messageIds });
        }

        return dispatched;
    }

    /**
     * Creates the assignment and sends the request to the provider.
     * A failed request releases the assignment and penalizes the provider.
     * @param {string} publicKey
     * @param {string[]} messageIds
     * @returns {Promise<void>}
     */
    async assignBatch(publicKey, messageIds) {
        this.assignments.set(publicKey, { messageIds: new Set(messageIds), requestedAt: now() });

        for (const messageId of messageIds) {
            this.queue.delete(messageId);
            this.assignedTo.set(messageId, publicKey);
        }

        return Promise.resolve()
            .then(() => this.request(publicKey, messageIds))
            .catch(error => {
                logger.warn('Failed to request messages', { publicKey, topic: this.topic, error });
                this.releaseProvider(publicKey, { penalize: true });
            });
    }

    /**
     * Moves the provider's undelivered ids back to the queue.
     * @param {string} publicKey
     * @param {Object} [options]
     * @param {boolean} [options.penalize=false] - Increase the provider's penalty.
     */
    releaseProvider(publicKey, { penalize = false } = {}) {
        const assignment = this.assignments.get(publicKey);
        if (!assignment) return;

        this.assignments.delete(publicKey);

        for (const messageId of assignment.messageIds) {
            this.assignedTo.delete(messageId);
            if (this.providers.has(messageId)) {
                this.queue.add(messageId);
            }
        }

        if (penalize) {
            this.penalties.set(publicKey, (this.penalties.get(publicKey) ?? 0) + 1);
        }
    }

    /**
     * Releases every assignment older than `requestTimeout` and penalizes its provider.
     * @returns {string[]} Public keys of the released providers.
     */
    reclaimStalled() {
        const staleBefore = now() - this.settings.requestTimeout;
        const released = [];

        for (const [publicKey, assignment] of [...this.assignments]) {
            if (assignment.requestedAt > staleBefore) continue;

            this.releaseProvider(publicKey, { penalize: true });
            released.push(publicKey);
        }

        return released;
    }
}
