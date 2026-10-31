import { NegentropyModeOptions } from "../../../constants/events.constants.js";
import { DEFAULT_READ_BATCH_SIZE } from '../../../constants/global.constants.js';
import {
    computeRangeBuckets,
    computeRangeFingerprint,
    countMessagesInRange,
    getMessageSnapshotRowId,
    getMessagesByIds,
    listMessageIdsInRange,
} from '../../../utils/message.utils.js';
import { SessionManager } from "../../session.manager.js";


export const NegentropyRole = {
    INITIATOR: 'initiator',
    RESPONDER: 'responder',
};

export const NegentropyStates = {
    IDLE: 'idle',
    RECONCILING: 'reconciling',
    DONE: 'done',
    FAILED: 'failed',
};

export class NegentropySyncError extends Error {
    /**
     * @param {string} code - Machine readable error code.
     * @param {string} message - Human readable description.
     */
    constructor(code, message) {
        super(message);
        this.name = 'NegentropySyncError';
        this.code = code;
    }
}

/**
 * The smallest unit of message-history synchronization: reconciles the message set of
 * ONE space between the local node and ONE remote peer, using Range-Based Set
 * Reconciliation (Negentropy v1 semantics).
 *
 * ```
 * const outgoing = await initiator.initiate();
 * let message = outgoing;
 * let receiver = responder;
 * while (message) {
 *     message = await receiver.reconcile(message);
 *     receiver = receiver === responder ? initiator : responder;
 * }
 * // initiator.have / initiator.need, responder.have / responder.need
 * ```
 */
export class NegentropySync {
    /**
     * @param {Object} params
     * @param {SessionManager} params.session - Current session instance.
     * @param {number} params.spaceId - Local primary key of the space.
     * @param {string} params.topic - Space topic hash (used to rebuild signed messages).
     * @param {string} [params.peerPublicKey] - Public key of the remote peer.
     * @param {'initiator'|'responder'} params.role - Role of the local node in this session.
     * @param {number} [params.batchSize]
     */
    constructor(params) {
        const {
            session,
            spaceId,
            topic,
            peerPublicKey = null,
            role,
            batchSize = DEFAULT_READ_BATCH_SIZE,
        } = params;

        if (!Object.values(NegentropyRole).includes(role)) {
            throw new TypeError(`invalid role: ${role}`);
        }

        this.session = session;
        this.spaceId = spaceId;
        this.topic = topic;
        this.peerPublicKey = peerPublicKey;
        this.role = role;

        this.batchSize = batchSize;

        /** Messages the local node has and the peer is missing. */
        this.have = new Set();
        /** Messages the peer has and the local node is missing. */
        this.need = new Set();

        this.state = NegentropyStates.IDLE;
        this.snapshotRowId = null;
        this.rounds = 0;
        this.error = null;

        this._busy = false;
    }

    get db() {
        return this.session.getDatabase().db;
    }

    get reconciliationConfig() {
        const config = this.session.getMessageConfig();
        return config.reconciliation;
    }

    get limits() {
        const config = this.reconciliationConfig;

        return {
            maxRanges: config.maxRanges ?? 1024,
            maxRounds: config.maxRounds ?? 64
        };
    }

    get isInitiator() {
        return this.role === NegentropyRole.INITIATOR;
    }

    get isDone() {
        return this.state === NegentropyStates.DONE;
    }

    /**
     * Freezes the local message set of the space. This way the reconciliation
     * would not be affected by the concurrent live messages.
     * @returns {Promise<number>} The snapshot row ID.
     */
    async init() {
        if (this.snapshotRowId === null) {
            this.snapshotRowId = await getMessageSnapshotRowId(this.db, this.spaceId);
        }

        return this.snapshotRowId;
    }

    /**
     * Starts the reconciliation (initiator only).
     * @returns {Promise<{ ranges: Array<Object> }>} The first message to initiate the syncing.
     */
    async initiate() {
        if (!this.isInitiator) {
            throw new NegentropySyncError(
                'INVALID_ROLE',
                'only the initiator can initiate a sync'
            );
        }

        if (this.state !== NegentropyStates.IDLE) {
            throw new NegentropySyncError(
                'INVALID_STATE',
                `cannot initiate a sync in "${this.state}" state`
            );
        }

        return await this.keepBusy(async () => {
            await this.init();
            this.state = NegentropyStates.RECONCILING;
            this.rounds = 1;

            const ranges = await this.splitRanges(null, null);
            return ranges;
        });
    }

    /**
     * Processes a message received from the peer.
     * @param {Array<Object>} responderRanges - Incoming Negentropy range.
     * @returns {Promise<Object|null>} The reply to send back, or `null` if nothing must be sent.
     */
    async reconcile(responderRanges) {
        // reconciliation should be avoided is the state of syncing is finished or failed in process
        if (
            this.state === NegentropyStates.DONE ||
            this.state === NegentropyStates.FAILED
        ) { throw new NegentropySyncError('INVALID_STATE', `cannot reconcile in "${this.state}" state`); }

        // reconciliation should not start from the 'client'
        if (
            this.isInitiator &&
            this.state === NegentropyStates.IDLE
        ) { throw new NegentropySyncError('INVALID_STATE', 'initiator must call initiate() first'); }


        return await this.keepBusy(async () => {
            try {

                await this.init();

                this.rounds++;
                if (this.rounds > this.limits.maxRounds) {
                    throw new NegentropySyncError('MAX_ROUNDS_EXCEEDED', `sync exceeded ${this.limits.maxRounds} rounds`);
                }

                this.state = NegentropyStates.RECONCILING;

                // the peer has nothing left to reconcile.
                if (responderRanges.length === 0) {
                    this.state = NegentropyStates.DONE;
                    return null;
                }

                const ranges = await this._processRanges(responderRanges);

                // we have nothing left to reconcile, tell the peer we are done.
                if (ranges.length === 0) {
                    this.state = NegentropyStates.DONE;
                }

                return ranges
            }
            catch (error) {
                this.state = NegentropyStates.FAILED;
                this.error = error;
                throw error;
            }
        });
    }

    /**
     * Returns the needed message IDs which are still missing from the local database.
     * Some "needs" may already be stored locally because they arrived as live messages
     * (or from another peer) after the snapshot was taken.
     * @returns {Promise<string[]>}
     */
    async resolveNeeds() {
        if (this.need.size === 0) return [];

        const existing = await getMessagesByIds(this.db, {
            spaceId: this.spaceId,
            messageIds: this.need,
            batchSize: this.batchSize,
        });

        for (const record of existing) {
            this.need.delete(record.messageId);
        }

        return [...this.need];
    }

    /**
     * Processes every range of an incoming message and builds the reply ranges.
     * Consecutive ranges which need no reply are merged into a single SKIP, and
     * trailing SKIPs are dropped.
     * @param {Array<{ upperBound: Object, mode: string, fingerprint: string, ids: Array<string> }>}
     */
    async _processRanges(incomingRanges) {
        const output = [];
        let lowerBound = null;
        let pendingSkip = false;

        const flushSkip = () => {
            if (pendingSkip) {
                output.push({ upperBound: lowerBound, mode: NegentropyModeOptions.SKIP });
                pendingSkip = false;
            }
        };

        if (!Array.isArray(incomingRanges)) {
            console.log({ incomingRanges })
        }
        
        for (const range of incomingRanges) {
            const { upperBound, mode } = range;

            switch (mode) {
                case NegentropyModeOptions.SKIP: {
                    pendingSkip = true;
                    break;
                }

                case NegentropyModeOptions.FINGERPRINT: {
                    const fingerprint = await computeRangeFingerprint(
                        this.db,
                        this.createRangeQueryPayload(lowerBound, upperBound)
                    );

                    if (fingerprint === range.fingerprint) {
                        pendingSkip = true;
                    }

                    else {
                        flushSkip();
                        const subRanges = await this.splitRanges(lowerBound, upperBound);
                        output.push(...subRanges);
                    }

                    break;
                }

                case NegentropyModeOptions.ID_LIST: {
                    const query = this.createRangeQueryPayload(lowerBound, upperBound);
                    const total = await countMessagesInRange(this.db, query);
                    const config = this.reconciliationConfig;

                    if (total >= config.idListThreshold) {
                        // our side of the range is too large to list, keep splitting it.
                        // The difference is recorded once the sub-ranges get small enough.
                        flushSkip();
                        const subRanges = await this.splitRanges(lowerBound, upperBound, total);
                        output.push(...subRanges);

                        break;
                    }

                    const localIds = await listMessageIdsInRange(this.db, query);
                    const isIdentical = this.collectRangeDifference(localIds, range.ids);

                    if (isIdentical) {
                        pendingSkip = true;
                    }
                    else {
                        // we know the exact difference now, let the peer learn it too.
                        flushSkip();
                        output.push({ upperBound, mode: NegentropyModeOptions.ID_LIST_RESPONSE, ids: localIds });
                    }
                    break;
                }

                case NegentropyModeOptions.ID_LIST_RESPONSE: {
                    const localIds = await listMessageIdsInRange(
                        this.db, 
                        this.createRangeQueryPayload(lowerBound, upperBound)
                    );

                    this.collectRangeDifference(localIds, range.ids);
                    pendingSkip = true;
                    break;
                }
            }

            lowerBound = upperBound;
        }

        return output;
    }

    /**
     * Describes the local content of `[lowerBound, upperBound)`: a single ID_LIST if the
     * range is small, otherwise `bucketCount` FINGERPRINT sub-ranges.
     * 
     * @param {Object|null} lowerBound - Inclusive lower bound.
     * @param {Object|null} upperBound - Exclusive upper bound.
     * @param {number} [knownTotal] - Number of local messages in the range, if already counted.
     * @returns {Promise<Array<Object>>} - Returns array of sub-ranges either by fingerprint or id list.
     */
    async splitRanges(lowerBound, upperBound, knownTotal) {
        const query = this.createRangeQueryPayload(lowerBound, upperBound);
        const total = knownTotal ?? await countMessagesInRange(this.db, query);

        // this is the threshold to which we only send ids instead of fingerprints
        if (total < this.reconciliationConfig.idListThreshold) {
            const messageIds = await listMessageIdsInRange(this.db, query);

            return [
                {
                    upperBound: upperBound,
                    mode: NegentropyModeOptions.ID_LIST,
                    ids: messageIds
                }
            ];
        }

        const buckets = await computeRangeBuckets(this.db, {
            ...query,
            total,
            bucketCount: this.reconciliationConfig.bucketCount,
        });

        return buckets.map(bucket => ({
            upperBound: bucket.upperBound,
            mode: NegentropyModeOptions.FINGERPRINT,
            fingerprint: bucket.fingerprint,
        }));
    }

    /**
     * Records the difference between local and remote IDs of a range.
     * @private
     * @returns {boolean} True if both sides hold the same IDs.
     */
    collectRangeDifference(localIds, remoteIds) {
        const remote = new Set(remoteIds);
        let isIdentical = true;

        // remove common ids while adding uncommon record from local to `this.have` set.
        for (const messageId of localIds) {
            if (remote.has(messageId)) {
                remote.delete(messageId);
            }
            else {
                this.have.add(messageId);
                isIdentical = false;
            }
        }

        /**
         * After removing common ids, we want to keep all remainings to `set.need` set.
         */
        for (const messageId of remote) {
            this.need.add(messageId);
            isIdentical = false;
        }

        return isIdentical;
    }

    createRangeQueryPayload(lowerBound, upperBound) {
        return {
            spaceId: this.spaceId,
            lowerBound,
            upperBound,
            maxRowId: this.snapshotRowId,
            batchSize: this.batchSize,
        };
    }

    /**
     * Runs one operation at a time; a session is strictly request/response.
     * @param {CallableFunction} operation - The internal operation that keeps the instance busy
     * @returns {Promise<any>} Resolves when the operation completes.
     */
    async keepBusy(operation) {
        if (this._busy) {
            throw new NegentropySyncError(
                'BUSY',
                'a message is already being processed'
            );
        }

        this._busy = true;

        try {
            return await operation();
        } finally {
            this._busy = false;
        }
    }
}
