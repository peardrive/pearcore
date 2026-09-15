import { now } from "../utils/general.utils.js";
import { getNonces } from "../utils/message.utils.js";

export class ThrottleManager {
    constructor(emitter, managers) {
        this.sessionManager = managers.sessionManager;

        this.messageNonceRecord = new Set();
        this.frequencyRecord = new Map();
        this.quarantine = new Map();

        setTimeout(() => this.clearFrequencyRecords(), 1000);
    }

    get db() {
        return this.sessionManager.getDatabase().db;
    }

    get MAX_FREQUENCY_THROTTLE() {
        return this.sessionManager.getMessageConfig().frequencyThrottle;
    }

    get MAX_QUARANTINE_TIME() {
        return this.sessionManager.getMessageConfig().maxQuarantineTime;
    }

    /**
     * Load all messages from database (to avoid duplications).
     * @returns {Promise<void>} Resolves when all records loads into the memory.
     */
    async load() {
        const nonces = await getNonces(this.db);
        for (const nonce of nonces) {
            this.messageNonceRecord.add(nonce);
        }
    }

    addToQuarantine(publicKey) {
        this.quarantine.set(publicKey, now());
    }

    isQuarantined(publicKey) {
        return this.quarantine.has(publicKey);
    }

    removeFromQuarantine(publicKey) {
        this.quarantine.delete(publicKey);
    }

    shouldExitQuarantine(publicKey) {
        const timestamp = this.quarantine.get(publicKey);
        return now() - timestamp > this.MAX_QUARANTINE_TIME;
    }

    /**
     * Adds message into memory to avoid duplication afterward.
     * @param {Object} message - The protocol message.
     */
    updateByMessage(message) {
        this.messageNonceRecord.add(message.nonce);
    }

    /**
     * Increments the frequence counter for publicKey by one.
     * @param {String} publicKey - 64 character hex string as publicKey
     */
    updateByFrequency(publicKey) {
        if (this.isQuarantined(publicKey)) {
            if (this.shouldExitQuarantine(publicKey)) {
                this.removeFromQuarantine(publicKey);
            }

            else {
                // avoid incrementing the frequency
                return;
            }
        }

        const count = this.frequencyRecord.get(publicKey) || 0;

        if (count + 1 > this.MAX_FREQUENCY_THROTTLE) {
            this.addToQuarantine(publicKey);
            this.frequencyRecord.set(publicKey, 0); //reset
        }

        else { this.frequencyRecord.set(publicKey, count + 1); }
    }

    /**
     * Checks if the message has already been recorded.
     * @param {Object} message - The protocol message. 
     */
    messageIsDuplicated(message) {
        return this.messageNonceRecord.has(message.nonce);
    }

    /**
     * Check if the publicKey should be throttled by the frequency of messages.
     * @param {String} publicKey - 64 character hex string as publicKey.
     */
    shouldBeThrottledByFrequency(publicKey) {
        return this.isQuarantined(publicKey) && !this.shouldExitQuarantine(publicKey);
    }

    getSnapShot() {
        const snapshot = {};
        for (const [peer, callFrequency] of this.frequencyRecord.entries()) {            
            snapshot[peer] = {
                count: callFrequency,
                isThrottled: this.isQuarantined(peer)
            }
        }

        return snapshot;
    }

    /**
     * Clear all the frequency counters for publicKeys.
     */
    clearFrequencyRecords() {
        for(const publicKey of this.frequencyRecord.keys()) {
            this.frequencyRecord.set(publicKey, 0);
        }
    }

    /**
     * Clear all message records.
     */
    clearMessageRecords() { this.messageNonceRecord.clear(); }

    /**
     * Clear all frequency counters and message records at once.
     */
    clear() {
        this.clearFrequencyRecords();
        this.clearMessageRecords();
    }
}