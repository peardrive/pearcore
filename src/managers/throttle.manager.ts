import { now } from '../utils/general.utils.js';
import type { SessionManager } from './session.manager.js';

export interface ThrottleManagerDependencies {
  sessionManager: Pick<SessionManager, 'getDatabase' | 'getMessageConfig'>;
}

export interface NonceMessage {
  nonce: string;
}

export interface ThrottleSnapshotEntry {
  count: number;
  isThrottled: boolean;
}

export class ThrottleManager {
  sessionManager: ThrottleManagerDependencies['sessionManager'];
  messageNonceRecord: Set<string>;
  frequencyRecord: Map<string, number>;
  quarantine: Map<string, number>;

  constructor(_emitter: unknown, managers: ThrottleManagerDependencies) {
    this.sessionManager = managers.sessionManager;

    this.messageNonceRecord = new Set<string>();
    this.frequencyRecord = new Map<string, number>();
    this.quarantine = new Map<string, number>();

    setInterval(() => this.clearFrequencyRecords(), 1000);
  }

  get db() {
    return this.sessionManager.getDatabase().db;
  }

  get MAX_FREQUENCY_THROTTLE(): number {
    return this.sessionManager.getMessageConfig().frequencyThrottle;
  }

  get MAX_QUARANTINE_TIME(): number {
    return this.sessionManager.getMessageConfig().maxQuarantineTime;
  }

  addToQuarantine(publicKey: string): void {
    this.quarantine.set(publicKey, now());
  }

  isQuarantined(publicKey: string): boolean {
    return this.quarantine.has(publicKey);
  }

  removeFromQuarantine(publicKey: string): void {
    this.quarantine.delete(publicKey);
  }

  shouldExitQuarantine(publicKey: string): boolean {
    const timestamp = this.quarantine.get(publicKey);
    return (
      timestamp !== undefined && now() - timestamp > this.MAX_QUARANTINE_TIME
    );
  }

  /**
   * Adds message into memory to avoid duplication afterward.
   * @param message - The protocol message.
   */
  updateByMessage(message: NonceMessage): void {
    this.messageNonceRecord.add(message.nonce);
  }

  /**
   * Increments the frequence counter for publicKey by one.
   * @param publicKey - 64 character hex string as publicKey
   */
  updateByFrequency(publicKey: string): void {
    if (this.isQuarantined(publicKey)) {
      if (this.shouldExitQuarantine(publicKey)) {
        this.removeFromQuarantine(publicKey);
      } else {
        // avoid incrementing the frequency
        return;
      }
    }

    const count = this.frequencyRecord.get(publicKey) || 0;

    if (count + 1 > this.MAX_FREQUENCY_THROTTLE) {
      this.addToQuarantine(publicKey);
      this.frequencyRecord.set(publicKey, 0); //reset
    } else {
      this.frequencyRecord.set(publicKey, count + 1);
    }
  }

  /**
   * Checks if the message has already been recorded.
   * @param message - The protocol message.
   */
  messageIsDuplicated(message: NonceMessage): boolean {
    return this.messageNonceRecord.has(message.nonce);
  }

  /**
   * Check if the publicKey should be throttled by the frequency of messages.
   * @param publicKey - 64 character hex string as publicKey.
   */
  shouldBeThrottledByFrequency(publicKey: string): boolean {
    return (
      this.isQuarantined(publicKey) && !this.shouldExitQuarantine(publicKey)
    );
  }

  getSnapShot(): Record<string, ThrottleSnapshotEntry> {
    const snapshot: Record<string, ThrottleSnapshotEntry> = {};
    for (const [peer, callFrequency] of this.frequencyRecord.entries()) {
      snapshot[peer] = {
        count: callFrequency,
        isThrottled: this.isQuarantined(peer),
      };
    }

    return snapshot;
  }

  /**
   * Clear all the frequency counters for publicKeys.
   */
  clearFrequencyRecords(): void {
    for (const publicKey of this.frequencyRecord.keys()) {
      this.frequencyRecord.set(publicKey, 0);
    }
  }

  /**
   * Clear all message records.
   */
  clearMessageRecords(): void {
    this.messageNonceRecord.clear();
  }

  /**
   * Clear all frequency counters and message records at once.
   */
  clear(): void {
    this.clearFrequencyRecords();
    this.clearMessageRecords();
  }
}
