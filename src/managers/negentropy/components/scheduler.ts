import { createChild } from '../../../logger.js';
import { now } from '../../../utils/general.utils.js';
import { hex, randomNonce } from '../../../utils/crypto.utils.js';
import type { SessionManager } from '../../session.manager.js';

const logger: any = createChild('MessageRequestScheduler');

interface MessageAssignment {
  assignmentKey: string;
  messageIds: Set<string>;
  requestedAt: number;
}

/**
 * Scheduler for the messages a node needs from ONE space.
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
 * - Every assignment carries a random `assignmentKey`. The provider echoes it on each
 *   delivery, so late deliveries of a reclaimed assignment are recognized and ignored.
 * - Taking an assignment back (timeout, failed request) notifies the provider through
 *   `cancel`, so it stops sending. A provider can withdraw ids it cannot deliver; those
 *   are never assigned to it again.
 */
export class MessageRequestScheduler {
  [key: string]: any;
  private queue: Set<string>;
  private providers: Map<string, Set<string>>;
  private assignments: Map<string, MessageAssignment>;
  private assignedTo: Map<string, string>;
  private penalties: Map<string, number>;
  /**
   * @param params
   * @param params.sessionManager - Current session instance.
   * @param params.topic - Space topic hash.
   * @param [params.request] - Sends the request for a batch of message ids to a provider.
   * @param [params.cancel] - Tells a provider to stop delivering an assignment.
   */
  constructor({ sessionManager, topic, request = null, cancel = null }: any) {
    this.sessionManager = sessionManager;
    this.topic = topic;
    this.request = request;
    this.cancel = cancel;

    /**
     * Message ids waiting for assignment. these are free to pick for new providers.
     */
    this.queue = new Set();

    /**
     * Maps each messageId to providers (publicKeys) that maintain that message.
     */
    this.providers = new Map();

    /**
     * Maps publicKeys to their list of message ids their are assigned to deliver (plus the key and timestamp)
     */
    this.assignments = new Map();

    /**
     * Keep track of individual messages and their assigned provider for delivery
     * Message id to assigned provider mapping.
     */
    this.assignedTo = new Map();

    /**
     * Map providers penalty scores (increase when delivery timeout)
     * Provider public key to penalty counter mapping.
     */
    this.penalties = new Map();
  }

  get settings() {
    return this.sessionManager.getMessageConfig().reconciliation;
  }

  /**
   * Number of message ids that are queued or assigned for delivery.
   */
  get pendingCount() {
    return this.queue.size + this.assignedTo.size;
  }

  /**
   * Sets the function that requests a batch of message ids from a provider.
   * @param request
   */
  setRequestHandler(request: any) {
    this.request = request;
  }

  /**
   * Sets the function that tells a provider to stop delivering an assignment.
   * @param cancel
   */
  setCancelHandler(cancel: any) {
    this.cancel = cancel;
  }

  /**
   * Returns the provider's current assignment if it matches the given key.
   * @param publicKey
   * @param assignmentKey
   * @returns */
  getAssignment(publicKey: string, assignmentKey: string) {
    const assignment = this.assignments.get(publicKey);
    return assignment?.assignmentKey === assignmentKey ? assignment : null;
  }

  /**
   * Checks that a delivered message answers the provider's current assignment.
   * False for stale keys (reclaimed assignments), foreign ids and other providers.
   * @param publicKey
   * @param assignmentKey
   * @param messageId
   * @returns */
  expectsDelivery(publicKey: string, assignmentKey: string, messageId: string) {
    return (
      this.getAssignment(publicKey, assignmentKey)?.messageIds.has(messageId) ??
      false
    );
  }

  /**
   * Checks if the provider has no assigned batch.
   * @param publicKey
   * @returns */
  isIdle(publicKey: string) {
    return !this.assignments.has(publicKey);
  }

  /**
   * True once every requested message has been delivered.
   * @returns */
  isComplete() {
    return this.pendingCount === 0;
  }

  /**
   * Registers a peer as provider of the given  list of message ids.
   * @param publicKey - Provider public key.
   * @param messageIds - Message ids the provider can deliver.
   */
  addProvider(publicKey: string, messageIds: string[]) {
    for (const messageId of messageIds) {
      if (!this.providers.has(messageId)) {
        this.providers.set(messageId, new Set());
      }

      this.providers.get(messageId)!.add(publicKey);

      if (!this.assignedTo.has(messageId)) {
        this.queue.add(messageId);
      }
    }
  }

  /**
   * Removes a provider (e.g. disconnected peer). Its assignment goes back to the queue,
   * and ids that no other peer can provide are dropped until a new provider registers them.
   * @param publicKey - Provider public key.
   */
  removeProvider(publicKey: string) {
    this.releaseProvider(publicKey, { penalize: false });

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
   * @param messageIds
   */
  markDelivered(messageIds: string[]) {
    for (const messageId of messageIds) {
      this.queue.delete(messageId);
      this.providers.delete(messageId);

      const publicKey = this.assignedTo.get(messageId);
      if (!publicKey) continue;

      this.assignedTo.delete(messageId);

      const assignment = this.assignments.get(publicKey);
      assignment!.messageIds.delete(messageId);

      if (assignment!.messageIds.size === 0) {
        this.assignments.delete(publicKey);
      }
    }
  }

  /**
   * A provider cancelled (part of) its current assignment: it cannot deliver these ids.
   * The ids leave its assignment and the provider is no longer registered for them, so
   * they are never assigned to it again. Ids other peers can provide go back to the
   * queue, the others are dropped. No penalty: the provider reported it honestly.
   * @param publicKey
   * @param assignmentKey - Must match the current assignment, otherwise ignored.
   * @param [messageIds=null] - Withdrawn ids; null withdraws the whole assignment.
   * @returns The withdrawn ids.
   */
  withdraw(
    publicKey: string,
    assignmentKey: string,
    messageIds: string[] | null = null,
  ) {
    const assignment = this.getAssignment(publicKey, assignmentKey);
    if (!assignment) return [];

    const withdrawn = Array.from(messageIds ?? assignment.messageIds).filter(
      (messageId) => assignment.messageIds.has(messageId),
    );

    for (const messageId of withdrawn) {
      assignment.messageIds.delete(messageId);
      this.assignedTo.delete(messageId);

      const providers = this.providers.get(messageId);
      providers?.delete(publicKey);

      if (providers && providers.size > 0) {
        this.queue.add(messageId);
      } else {
        this.providers.delete(messageId);
      }
    }

    if (assignment.messageIds.size === 0) {
      this.assignments.delete(publicKey);
    }

    return withdrawn;
  }

  /**
   * Returns the idle providers that can deliver at least one queued id,
   * ordered by their penalty (lowest first).
   * @returns */
  pickIdleProviders(): string[] {
    const candidates = new Set<string>();

    for (const messageId of this.queue) {
      const currentProviders = this.providers.get(messageId) ?? [];

      for (const publicKey of currentProviders) {
        if (this.isIdle(publicKey)) {
          candidates.add(publicKey);
        }
      }
    }

    const penaltyOf = (publicKey: string) => this.penalties.get(publicKey) ?? 0;
    const byLowestPenalty = (a: string, b: string) =>
      penaltyOf(a) - penaltyOf(b);

    return Array.from(candidates).sort(byLowestPenalty);
  }

  /**
   * Picks the next batch for a provider: queued ids it can deliver, rarest first.
   * @param publicKey
   * @returns */
  pickBatch(publicKey: string) {
    const candidates: Array<[string, number]> = [];

    for (const messageId of this.queue) {
      const providers = this.providers.get(messageId);
      if (providers?.has(publicKey)) {
        candidates.push([messageId, providers.size]);
      }
    }

    // sort the candidate messages based on their rarity in providers
    candidates.sort((a, b) => a[1] - b[1]);

    return candidates
      .slice(0, this.settings.requestBatchSize)
      .map(([messageId]) => messageId);
  }

  /**
   * Distributes queued ids to idle providers, one batch per provider.
   * @returns The new assignments.
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
   * @param publicKey
   * @param messageIds
   * @returns */
  async assignBatch(publicKey: string, messageIds: string[]) {
    const assignment = {
      assignmentKey: hex(randomNonce()),
      messageIds: new Set(messageIds),
      requestedAt: now(),
    };
    this.assignments.set(publicKey, assignment);

    for (const messageId of messageIds) {
      this.queue.delete(messageId);
      this.assignedTo.set(messageId, publicKey);
    }

    return Promise.resolve()
      .then(() => this.request(publicKey, messageIds, assignment.assignmentKey))
      .catch((error) => {
        if (this.assignments.get(publicKey) !== assignment) return;

        logger.warn('Failed to request messages', {
          publicKey,
          topic: this.topic,
          error,
        });

        // the request may have reached the provider before failing
        this.releaseProvider(publicKey, { penalize: true, notify: true });
      });
  }

  /**
   * Moves the provider's undelivered ids back to the queue.
   * Note: penalty would only increase if there is assigments to the provider
   * @param publicKey
   * @param [options]
   * @param [options.penalize=false] - Increase the provider's penalty.
   * @param [options.notify=false] - Send a cancellation, so the provider stops delivering.
   */
  releaseProvider(
    publicKey: string,
    { penalize = false, notify = false }: any = {},
  ) {
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

    if (notify && this.cancel) {
      Promise.resolve()
        .then(() => this.cancel(publicKey, assignment.assignmentKey))
        .catch((error) =>
          logger.warn('Failed to cancel assignment', {
            publicKey,
            topic: this.topic,
            error,
          }),
        );
    }
  }

  /**
   * Releases every assignment older than `requestTimeout`, penalizes its provider and
   * tells it to stop delivering.
   * @returns Public keys of the released providers.
   */
  reclaimStalled() {
    const staleBefore = now() - this.settings.requestTimeout;
    const released = [];

    for (const [publicKey, assignment] of [...this.assignments]) {
      if (assignment.requestedAt > staleBefore) continue;

      this.releaseProvider(publicKey, { penalize: true, notify: true });
      released.push(publicKey);
    }

    return released;
  }
}
