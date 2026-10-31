import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createManagerInstance, cleanup } from "../general.utils.js";
import { MessageRequestScheduler } from "../../src/managers/negentropy/components/scheduler.js";
import { MessageDeliveryTasks } from "../../src/managers/negentropy/components/delivery.js";
import * as EVENTS from "../../src/constants/events.constants.js";
import { createMessageRecord, flushMessageRecords } from "../../src/utils/message.utils.js";
import { createSpaceMessage } from "../../src/utils/protocol.utils.js";

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

/**
 * Moves the faked clock forward (only Date is faked, see beforeEach).
 */
const advance = ms => vi.setSystemTime(Date.now() + ms);

/**
 * A promise the test settles by hand, to control when a request answers. 
*/
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

/**
 * Structural invariants that must hold after any sequence of public calls.
 * Runs after every test (afterEach) and after every step of the random walk.
 * @param {MessageRequestScheduler} scheduler
 */
const expectConsistent = scheduler => {
    const { queue, providers, assignments, assignedTo } = scheduler;

    for (const id of queue) {
        expect(assignedTo.has(id), `${id} is both queued and assigned`).toBe(false);
        expect(providers.get(id)?.size ?? 0, `${id} is queued without providers`).toBeGreaterThan(0);
    }

    for (const [id, publicKey] of assignedTo) {
        expect(assignments.get(publicKey)?.messageIds.has(id), `${id} -> ${publicKey} missing from assignments`).toBe(true);
        expect(providers.get(id)?.has(publicKey), `${id} assigned to ${publicKey}, which cannot provide it`).toBe(true);
    }

    for (const [publicKey, assignment] of assignments) {
        expect(assignment.messageIds.size, `${publicKey} holds an empty assignment`).toBeGreaterThan(0);

        for (const id of assignment.messageIds) {
            expect(assignedTo.get(id), `${id} in ${publicKey}'s batch but assignedTo disagrees`).toBe(publicKey);
        }
    }

    // nothing deliverable is lost: every id with a provider is pending
    for (const id of providers.keys()) {
        expect(queue.has(id) || assignedTo.has(id), `${id} has providers but is neither queued nor assigned`).toBe(true);
    }

    // every assignment is addressed by its own key
    const keys = Array.from(assignments.values()).map(({ assignmentKey }) => assignmentKey);
    expect(new Set(keys).size, 'two assignments share an assignmentKey').toBe(keys.length);
};

describe('MessageRequestScheduler', () => {
    const BATCH_SIZE = 2;
    const REQUEST_TIMEOUT = 1000; // 1 second (virtual, driven by fake timers)
    const START_TIME = new Date('2026-01-01T00:00:00Z');
    const TOPIC = 'test-topic';

    const PEER_A = 'peer-a';
    const PEER_B = 'peer-b';
    const PEER_C = 'peer-c';

    let managers;
    let scheduler;
    let request;
    let cancel;

    beforeAll(async () => {
        managers = await createManagerInstance();
        managers.session.set('messaging.reconciliation.requestBatchSize', BATCH_SIZE);
        managers.session.set('messaging.reconciliation.requestTimeout', REQUEST_TIMEOUT);
    });

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(START_TIME);

        request = vi.fn(async () => { });
        cancel = vi.fn(async () => { });

        scheduler = new MessageRequestScheduler({
            sessionManager: managers.session,
            topic: TOPIC,
            request,
            cancel
        });
    });

    /** Key of the provider's current assignment. */
    const keyOf = publicKey => scheduler.assignments.get(publicKey)?.assignmentKey;

    afterEach(() => {
        try {
            expectConsistent(scheduler);
        }
        finally {
            vi.useRealTimers();
            vi.restoreAllMocks();
        }
    });

    afterAll(async () => {
        const { sqlite } = managers.session.getDatabase();

        await sqlite.close();
        await cleanup(managers.root);
    });

    it('should read batch size and timeout from the session config', () => {
        expect(scheduler.settings.requestBatchSize).toBe(BATCH_SIZE);
        expect(scheduler.settings.requestTimeout).toBe(REQUEST_TIMEOUT);
    });

    describe('addProvider', () => {
        const messageIds = ['m1', 'm2', 'm3'];

        it('should queue every new message id', () => {
            scheduler.addProvider(PEER_A, messageIds);

            expect(Array.from(scheduler.queue)).toEqual(messageIds);
            expect(scheduler.pendingCount).toBe(3);
            expect(scheduler.assignedTo.size).toBe(0);
        });

        it('should register the provider for each message id', () => {
            scheduler.addProvider(PEER_A, messageIds);

            for (const id of messageIds) {
                const providers = Array.from(scheduler.providers.get(id));
                expect(providers).toContain(PEER_A);
            }
        });

        it('should not re-queue a message id that is already assigned', async () => {
            scheduler.addProvider(PEER_A, messageIds);
            await scheduler.assignBatch(PEER_A, ['m1']);

            // a later reconciliation session reports m1 again
            scheduler.addProvider(PEER_B, messageIds);

            expect(Array.from(scheduler.queue)).toEqual(['m2', 'm3']);
            expect(scheduler.assignedTo.get('m1')).toBe(PEER_A);
        });

        it('should merge overlapping providers into one provider set', () => {
            scheduler.addProvider(PEER_A, messageIds);
            scheduler.addProvider(PEER_B, messageIds);

            expect(Array.from(scheduler.queue)).toEqual(messageIds);

            for (const id of messageIds) {
                expect(scheduler.providers.get(id)).toEqual(new Set([PEER_A, PEER_B]));
            }
        });
    });

    describe('pickBatch', () => {
        it('should only pick queued ids the provider can deliver', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2']);
            scheduler.addProvider(PEER_B, ['m1', 'm3']);

            await scheduler.assignBatch(PEER_B, ['m1']);
            expect(scheduler.pickBatch(PEER_A)).toEqual(['m2']);
        });

        it('should pick the rarest ids first', () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3']);
            scheduler.addProvider(PEER_B, ['m1', 'm2']);
            scheduler.addProvider(PEER_C, ['m1']);

            expect(scheduler.pickBatch(PEER_A)).toEqual(['m3', 'm2']);
        });

        it('should cap the batch at requestBatchSize', () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3', 'm4', 'm5']);

            const batch = scheduler.pickBatch(PEER_A);

            expect(batch).toHaveLength(BATCH_SIZE);
            expect(batch).toEqual(['m1', 'm2']);
            expect(scheduler.queue.size).toBe(5);
        });
    });

    describe('pickIdleProviders', () => {
        it('should exclude busy providers', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3']);
            scheduler.addProvider(PEER_B, ['m1', 'm2', 'm3']);

            await scheduler.assignBatch(PEER_A, ['m1']);
            expect(scheduler.pickIdleProviders()).toEqual([PEER_B]);
        });

        it('should exclude providers with nothing left to deliver', async () => {
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.addProvider(PEER_B, ['m1']);
            scheduler.addProvider(PEER_C, ['m2']);

            await scheduler.assignBatch(PEER_A, ['m1']);
            expect(scheduler.pickIdleProviders()).toEqual([PEER_C]);
        });

        it('should order providers by lowest penalty', () => {
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.addProvider(PEER_B, ['m1']);
            scheduler.addProvider(PEER_C, ['m1']);

            scheduler.penalties.set(PEER_A, 2);
            scheduler.penalties.set(PEER_B, 1);

            expect(scheduler.pickIdleProviders()).toEqual([PEER_C, PEER_B, PEER_A]);
        });
    });

    describe('assign', () => {
        it('should give each idle provider at most one batch', () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3', 'm4', 'm5']);

            expect(scheduler.assign()).toEqual([
                { publicKey: PEER_A, messageIds: ['m1', 'm2'] }
            ]);

            expect(Array.from(scheduler.queue)).toEqual(['m3', 'm4', 'm5']);
            // peer A is still busy so no new assignment should be set
            expect(scheduler.assign()).toEqual([]);
        });

        it('should move assigned ids from the queue to assignedTo', () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3']);

            scheduler.assign();

            expect(Array.from(scheduler.queue)).toEqual(['m3']);
            expect(scheduler.assignedTo.get('m1')).toBe(PEER_A);
            expect(scheduler.assignedTo.get('m2')).toBe(PEER_A);

            const assignment = scheduler.assignments.get(PEER_A);
            expect(Array.from(assignment.messageIds)).toEqual(['m1', 'm2']);
            expect(assignment.requestedAt).toBe(START_TIME.getTime());

            // ids moved, none were lost
            expect(scheduler.pendingCount).toBe(3);
        });

        it('should call request with the provider and its batch', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2']);
            scheduler.addProvider(PEER_B, ['m3']);

            const dispatched = scheduler.assign();

            // state is committed first, the request goes out on the next microtask
            expect(request).not.toHaveBeenCalled();

            await flushPromises();

            expect(request).toHaveBeenCalledTimes(2);
            expect(request).toHaveBeenCalledWith(PEER_A, ['m1', 'm2'], keyOf(PEER_A));
            expect(request).toHaveBeenCalledWith(PEER_B, ['m3'], keyOf(PEER_B));

            // ensure request receives identical parameters to assign() method
            expect(request.mock.calls).toEqual(
                dispatched.map(({ publicKey, messageIds }) => [publicKey, messageIds, keyOf(publicKey)])
            );
        });

        it('should not assign the same id to two providers', () => {
            for (const publicKey of [PEER_A, PEER_B, PEER_C]) {
                scheduler.addProvider(publicKey, ['m1', 'm2', 'm3', 'm4']);
            }

            const dispatched = scheduler.assign();
            const assignedIds = dispatched.flatMap(({ messageIds }) => messageIds);

            expect(new Set(assignedIds).size).toBe(assignedIds.length);
            expect(assignedIds.sort()).toEqual(['m1', 'm2', 'm3', 'm4']);

            // C is idle, but A and B took everything before its turn
            expect(dispatched.map(({ publicKey }) => publicKey)).toEqual([PEER_A, PEER_B]);
            expect(scheduler.isIdle(PEER_C)).toBe(true);
        });
    });

    describe('markDelivered', () => {
        it('should remove delivered ids from every structure', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3']);
            scheduler.addProvider(PEER_B, ['m1']);
            await scheduler.assignBatch(PEER_A, ['m1', 'm2']);

            // m1 is assigned, m3 is still queued
            scheduler.markDelivered(['m1', 'm3']);

            expect(scheduler.queue.size).toBe(0);
            expect(Array.from(scheduler.providers.keys())).toEqual(['m2']);
            expect(Array.from(scheduler.assignedTo.keys())).toEqual(['m2']);
            expect(Array.from(scheduler.assignments.get(PEER_A).messageIds)).toEqual(['m2']);
            expect(scheduler.pendingCount).toBe(1);
        });

        it('should free the provider once its whole batch is delivered', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2']);
            await scheduler.assignBatch(PEER_A, ['m1', 'm2']);

            scheduler.markDelivered(['m1', 'm2']);

            expect(scheduler.isIdle(PEER_A)).toBe(true);
            expect(scheduler.assignments.size).toBe(0);
            expect(scheduler.isComplete()).toBe(true);
        });

        it('should keep the provider busy on a partial delivery', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2']);
            await scheduler.assignBatch(PEER_A, ['m1', 'm2']);

            advance(REQUEST_TIMEOUT / 2);
            scheduler.markDelivered(['m1']);

            const assignment = scheduler.assignments.get(PEER_A);
            expect(scheduler.isIdle(PEER_A)).toBe(false);
            expect(Array.from(assignment.messageIds)).toEqual(['m2']);
            // a partial delivery does not restart the timeout
            expect(assignment.requestedAt).toBe(START_TIME.getTime());
        });

        it('should accept ids that were never assigned', () => {
            scheduler.addProvider(PEER_A, ['m1']);

            expect(() => scheduler.markDelivered(['unknown', 'm1'])).not.toThrow();
            // delivering the same id twice is harmless too
            expect(() => scheduler.markDelivered(['m1'])).not.toThrow();

            expect(scheduler.isComplete()).toBe(true);
        });
    });

    describe('releaseProvider', () => {
        it('should return undelivered ids to the queue', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3']);
            await scheduler.assignBatch(PEER_A, ['m1', 'm2']);
            scheduler.markDelivered(['m1']);

            scheduler.releaseProvider(PEER_A);

            // released ids go to the back of the queue
            expect(Array.from(scheduler.queue)).toEqual(['m3', 'm2']);
            expect(scheduler.assignedTo.size).toBe(0);
            expect(scheduler.isIdle(PEER_A)).toBe(true);
        });

        it('should not re-queue ids that lost all providers', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2']);
            await scheduler.assignBatch(PEER_A, ['m1', 'm2']);

            // not reachable through the public API (removeProvider releases first),
            // so the defensive branch is exercised directly
            scheduler.providers.delete('m1');
            scheduler.releaseProvider(PEER_A);

            expect(Array.from(scheduler.queue)).toEqual(['m2']);
            expect(scheduler.assignedTo.has('m1')).toBe(false);
            expect(scheduler.pendingCount).toBe(1);
        });

        it('should increment the penalty only when penalize is true', async () => {
            scheduler.addProvider(PEER_A, ['m1']);

            await scheduler.assignBatch(PEER_A, ['m1']);
            scheduler.releaseProvider(PEER_A);
            expect(scheduler.penalties.has(PEER_A)).toBe(false);

            await scheduler.assignBatch(PEER_A, ['m1']);
            scheduler.releaseProvider(PEER_A, { penalize: true });
            expect(scheduler.penalties.get(PEER_A)).toBe(1);

            await scheduler.assignBatch(PEER_A, ['m1']);
            scheduler.releaseProvider(PEER_A, { penalize: true });
            expect(scheduler.penalties.get(PEER_A)).toBe(2);
        });

        it('should be a no-op for an idle provider', () => {
            scheduler.addProvider(PEER_A, ['m1']);

            scheduler.releaseProvider(PEER_A, { penalize: true });

            // no batch, no penalty: an idle provider cannot have stalled
            expect(scheduler.penalties.has(PEER_A)).toBe(false);
            expect(Array.from(scheduler.queue)).toEqual(['m1']);
        });
    });

    describe('reclaimStalled', () => {
        it('should keep assignments younger than requestTimeout', async () => {
            scheduler.addProvider(PEER_A, ['m1']);
            await scheduler.assignBatch(PEER_A, ['m1']);

            advance(REQUEST_TIMEOUT - 1);

            expect(scheduler.reclaimStalled()).toEqual([]);
            expect(scheduler.assignedTo.get('m1')).toBe(PEER_A);
            expect(scheduler.penalties.has(PEER_A)).toBe(false);
        });

        it('should release and penalize assignments at or past requestTimeout', async () => {
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.addProvider(PEER_B, ['m2']);

            await scheduler.assignBatch(PEER_A, ['m1']);
            advance(REQUEST_TIMEOUT / 2);
            await scheduler.assignBatch(PEER_B, ['m2']);

            // A is exactly REQUEST_TIMEOUT old, B only half of it
            advance(REQUEST_TIMEOUT / 2);
            expect(scheduler.reclaimStalled()).toEqual([PEER_A]);

            expect(Array.from(scheduler.queue)).toEqual(['m1']);
            expect(scheduler.penalties.get(PEER_A)).toBe(1);
            expect(scheduler.assignedTo.get('m2')).toBe(PEER_B);

            advance(REQUEST_TIMEOUT / 2);
            expect(scheduler.reclaimStalled()).toEqual([PEER_B]);
            expect(scheduler.penalties.get(PEER_B)).toBe(1);
        });

        it('should return the released public keys', async () => {
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.addProvider(PEER_B, ['m2']);
            scheduler.addProvider(PEER_C, ['m3']);

            scheduler.assign();
            advance(REQUEST_TIMEOUT);

            expect(scheduler.reclaimStalled()).toEqual([PEER_A, PEER_B, PEER_C]);
            expect(scheduler.assignments.size).toBe(0);
            // nothing left to reclaim on a second pass
            expect(scheduler.reclaimStalled()).toEqual([]);
        });
    });

    describe('removeProvider', () => {
        it('should release its assignment without a penalty', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2']);
            scheduler.addProvider(PEER_B, ['m1', 'm2']);
            await scheduler.assignBatch(PEER_A, ['m1', 'm2']);

            scheduler.removeProvider(PEER_A);

            expect(Array.from(scheduler.queue)).toEqual(['m1', 'm2']);
            expect(scheduler.isIdle(PEER_A)).toBe(true);
            expect(scheduler.penalties.has(PEER_A)).toBe(false);
        });

        it('should drop ids no other provider can deliver', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3']);
            scheduler.addProvider(PEER_B, ['m3']);
            // m1 is in flight with A, m2 is queued: both are exclusive to A
            await scheduler.assignBatch(PEER_A, ['m1']);

            scheduler.removeProvider(PEER_A);

            expect(scheduler.providers.has('m1')).toBe(false);
            expect(scheduler.providers.has('m2')).toBe(false);
            expect(Array.from(scheduler.queue)).toEqual(['m3']);
            expect(scheduler.pendingCount).toBe(1);
        });

        it('should keep ids other providers can still deliver', () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2']);
            scheduler.addProvider(PEER_B, ['m2']);

            scheduler.removeProvider(PEER_A);

            expect(scheduler.providers.get('m2')).toEqual(new Set([PEER_B]));
            expect(scheduler.pickBatch(PEER_B)).toEqual(['m2']);
        });

        it('should clear its penalty', () => {
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.penalties.set(PEER_A, 3);

            scheduler.removeProvider(PEER_A);
            expect(scheduler.penalties.has(PEER_A)).toBe(false);

            // a reconnecting peer starts with a clean record
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.addProvider(PEER_B, ['m1']);
            expect(scheduler.pickIdleProviders()).toEqual([PEER_A, PEER_B]);
        });
    });

    describe('request failures', () => {
        it('should release and penalize the provider when request rejects', async () => {
            request.mockRejectedValueOnce(new Error('connection lost'));
            scheduler.addProvider(PEER_A, ['m1', 'm2']);

            scheduler.assign();
            await flushPromises();

            expect(scheduler.isIdle(PEER_A)).toBe(true);
            expect(Array.from(scheduler.queue)).toEqual(['m1', 'm2']);
            expect(scheduler.penalties.get(PEER_A)).toBe(1);
        });

        it('should release and penalize the provider when request throws synchronously', async () => {
            request.mockImplementationOnce(() => { throw new Error('socket destroyed'); });
            scheduler.addProvider(PEER_A, ['m1', 'm2']);

            expect(() => scheduler.assign()).not.toThrow();
            await flushPromises();

            expect(scheduler.isIdle(PEER_A)).toBe(true);
            expect(Array.from(scheduler.queue)).toEqual(['m1', 'm2']);
            expect(scheduler.penalties.get(PEER_A)).toBe(1);
        });

        it('should ignore a late rejection after the assignment was reclaimed', async () => {
            const hanging = deferred();
            request.mockImplementationOnce(() => hanging.promise);
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3']);

            scheduler.assign(); // A <- m1, m2 (hangs)
            await flushPromises();

            advance(REQUEST_TIMEOUT);
            expect(scheduler.reclaimStalled()).toEqual([PEER_A]);

            scheduler.assign(); // A <- m3, m1 (answers normally)
            await flushPromises();
            const current = scheduler.assignments.get(PEER_A);

            // the first request finally fails, long after it was reclaimed
            hanging.reject(new Error('timed out upstream'));
            await flushPromises();

            expect(scheduler.assignments.get(PEER_A)).toBe(current);
            expect(Array.from(current.messageIds)).toEqual(['m3', 'm1']);
            expect(scheduler.penalties.get(PEER_A)).toBe(1);
        });
    });

    describe('assignment keys', () => {
        it('should give every assignment its own key and pass it to request', async () => {
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.addProvider(PEER_B, ['m2']);

            scheduler.assign();
            await flushPromises();

            expect(keyOf(PEER_A)).toMatch(/^[0-9a-f]{24}$/);
            expect(keyOf(PEER_A)).not.toBe(keyOf(PEER_B));
            expect(request).toHaveBeenCalledWith(PEER_A, ['m1'], keyOf(PEER_A));
        });

        it('should issue a new key when the same provider is assigned again', async () => {
            scheduler.addProvider(PEER_A, ['m1']);

            scheduler.assign();
            const firstKey = keyOf(PEER_A);

            scheduler.releaseProvider(PEER_A);
            scheduler.assign();

            expect(keyOf(PEER_A)).not.toBe(firstKey);
        });

        it('should only expect deliveries matching the current assignment', () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3']);
            scheduler.addProvider(PEER_B, ['m3']);
            scheduler.assign(); // A <- m1, m2 | B <- m3
            const key = keyOf(PEER_A);

            expect(scheduler.expectsDelivery(PEER_A, key, 'm1')).toBe(true);
            // foreign id, other provider, unknown key
            expect(scheduler.expectsDelivery(PEER_A, key, 'm3')).toBe(false);
            expect(scheduler.expectsDelivery(PEER_B, key, 'm1')).toBe(false);
            expect(scheduler.expectsDelivery(PEER_A, 'f'.repeat(24), 'm1')).toBe(false);

            // already delivered
            scheduler.markDelivered(['m1']);
            expect(scheduler.expectsDelivery(PEER_A, key, 'm1')).toBe(false);
        });

        it('should treat a reclaimed assignment key as stale', async () => {
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.assign();
            const staleKey = keyOf(PEER_A);

            advance(REQUEST_TIMEOUT);
            scheduler.reclaimStalled();
            scheduler.assign();

            expect(scheduler.getAssignment(PEER_A, staleKey)).toBe(null);
            expect(scheduler.expectsDelivery(PEER_A, staleKey, 'm1')).toBe(false);
            expect(scheduler.expectsDelivery(PEER_A, keyOf(PEER_A), 'm1')).toBe(true);
        });
    });

    describe('cancel notifications', () => {
        it('should cancel a reclaimed assignment with its key', async () => {
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.assign();
            const key = keyOf(PEER_A);

            advance(REQUEST_TIMEOUT);
            scheduler.reclaimStalled();
            await flushPromises();

            expect(cancel).toHaveBeenCalledTimes(1);
            expect(cancel).toHaveBeenCalledWith(PEER_A, key);
        });

        it('should cancel when the request failed', async () => {
            request.mockRejectedValueOnce(new Error('connection lost'));
            scheduler.addProvider(PEER_A, ['m1']);

            scheduler.assign();
            const key = keyOf(PEER_A);
            await flushPromises();

            expect(cancel).toHaveBeenCalledWith(PEER_A, key);
        });

        it('should not cancel on disconnect, plain release or full delivery', async () => {
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.addProvider(PEER_B, ['m2']);
            scheduler.addProvider(PEER_C, ['m3']);
            scheduler.assign();

            scheduler.removeProvider(PEER_A);
            scheduler.releaseProvider(PEER_B);
            scheduler.markDelivered(['m3']);
            await flushPromises();

            expect(cancel).not.toHaveBeenCalled();
        });

        it('should survive a failing cancel handler', async () => {
            cancel.mockRejectedValueOnce(new Error('socket destroyed'));
            scheduler.addProvider(PEER_A, ['m1']);
            scheduler.assign();

            advance(REQUEST_TIMEOUT);
            expect(() => scheduler.reclaimStalled()).not.toThrow();
            await flushPromises();

            expect(Array.from(scheduler.queue)).toEqual(['m1']);
        });
    });

    describe('withdraw', () => {
        it('should withdraw part of an assignment without a penalty', () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2']);
            scheduler.addProvider(PEER_B, ['m2']);
            scheduler.assign(); // A <- m1, m2 (B gets nothing: both ids are taken)

            // A no longer has m2
            expect(scheduler.withdraw(PEER_A, keyOf(PEER_A), ['m2'])).toEqual(['m2']);

            expect(Array.from(scheduler.assignments.get(PEER_A).messageIds)).toEqual(['m1']);
            expect(scheduler.providers.get('m2')).toEqual(new Set([PEER_B]));
            expect(Array.from(scheduler.queue)).toEqual(['m2']);
            expect(scheduler.penalties.has(PEER_A)).toBe(false);
        });

        it('should never assign a withdrawn id to the same provider again', () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2']);
            scheduler.addProvider(PEER_B, ['m2']);
            scheduler.assign();

            scheduler.withdraw(PEER_A, keyOf(PEER_A), ['m2']);
            scheduler.markDelivered(['m1']); // A is idle again

            expect(scheduler.assign()).toEqual([
                { publicKey: PEER_B, messageIds: ['m2'] }
            ]);
        });

        it('should withdraw the whole assignment when no ids are given', () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2']);
            scheduler.addProvider(PEER_B, ['m1']);
            scheduler.assign(); // A <- m2, m1 (rarest first)

            expect(scheduler.withdraw(PEER_A, keyOf(PEER_A)).sort()).toEqual(['m1', 'm2']);

            expect(scheduler.isIdle(PEER_A)).toBe(true);
            // m2 had no other provider: dropped. m1 goes to B
            expect(scheduler.providers.has('m2')).toBe(false);
            expect(Array.from(scheduler.queue)).toEqual(['m1']);
        });

        it('should ignore a stale key and ids outside the assignment', () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3']);
            scheduler.assign(); // A <- m1, m2

            expect(scheduler.withdraw(PEER_A, 'f'.repeat(24))).toEqual([]);
            expect(scheduler.withdraw(PEER_A, keyOf(PEER_A), ['m3'])).toEqual([]);

            expect(Array.from(scheduler.assignments.get(PEER_A).messageIds)).toEqual(['m1', 'm2']);
            expect(scheduler.providers.get('m3')).toEqual(new Set([PEER_A]));
        });
    });

    describe('invariants', () => {
        // small deterministic PRNG so a failing walk can be replayed from its seed
        const mulberry32 = seed => () => {
            seed |= 0; seed = seed + 0x6D2B79F5 | 0;
            let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
            t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
            return ((t ^ t >>> 14) >>> 0) / 4294967296;
        };

        const IDS = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
        const PEERS = [PEER_A, PEER_B, PEER_C];

        const walk = async (seed, steps) => {
            const random = mulberry32(seed);
            const pick = list => list[Math.floor(random() * list.length)];
            const subset = list => list.filter(() => random() < 0.5);

            // roughly one request in five fails
            request.mockImplementation(async () => {
                if (random() < 0.2) throw new Error('random failure');
            });

            const operations = [
                () => scheduler.addProvider(pick(PEERS), subset(IDS)),
                () => scheduler.assign(),
                () => scheduler.assign(),
                () => scheduler.markDelivered(subset(Array.from(scheduler.assignedTo.keys()))),
                () => scheduler.markDelivered(subset(Array.from(scheduler.queue))),
                () => scheduler.releaseProvider(pick(PEERS), { penalize: random() < 0.5 }),
                () => scheduler.removeProvider(pick(PEERS)),
                () => { advance(REQUEST_TIMEOUT * random() * 1.5); scheduler.reclaimStalled(); },
                // a provider withdraws part (or all) of its batch; sometimes with a stale key
                () => {
                    const publicKey = pick(PEERS);
                    const assignment = scheduler.assignments.get(publicKey);
                    const key = random() < 0.8 ? assignment?.assignmentKey : 'f'.repeat(24);
                    const ids = random() < 0.5 ? null : subset(IDS);
                    scheduler.withdraw(publicKey, key ?? 'f'.repeat(24), ids);
                }
            ];

            for (let step = 0; step < steps; step++) {
                pick(operations)();
                await flushPromises();
                expectConsistent(scheduler);
            }
        };

        it('should hold every invariant across random operation sequences', async () => {
            for (let seed = 1; seed <= 25; seed++) {
                scheduler = new MessageRequestScheduler({
                    sessionManager: managers.session,
                    topic: TOPIC,
                    request,
                    cancel
                });

                await walk(seed, 200);
            }
        });
    });

    describe('scenarios', () => {
        /** Runs assign/deliver rounds; `delivers(publicKey, round)` decides who answers. */
        const run = async ({ delivers = () => true, maxRounds = 20 } = {}) => {
            const received = new Map();

            for (let round = 0; round < maxRounds && !scheduler.isComplete(); round++) {
                scheduler.assign();
                await flushPromises();

                for (const [publicKey, { messageIds }] of Array.from(scheduler.assignments)) {
                    if (!delivers(publicKey, round)) continue;

                    received.set(publicKey, (received.get(publicKey) ?? []).concat(Array.from(messageIds)));
                    scheduler.markDelivered(Array.from(messageIds));
                }
            }

            return received;
        };

        const requestedIds = () => request.mock.calls.flatMap(([, messageIds]) => messageIds);

        it('should complete when all providers deliver', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3', 'm4']);
            scheduler.addProvider(PEER_B, ['m3', 'm4', 'm5', 'm6']);

            await run();

            expect(scheduler.isComplete()).toBe(true);
            // every id requested exactly once
            expect(requestedIds().sort()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
            // the first round went to the ids only one peer has
            expect(request.mock.calls.slice(0, 2).map(([publicKey, messageIds]) => [publicKey, messageIds])).toEqual([
                [PEER_A, ['m1', 'm2']],
                [PEER_B, ['m5', 'm6']]
            ]);
        });

        it('should rebalance work towards a faster provider', async () => {
            const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'];
            scheduler.addProvider(PEER_A, ids);
            scheduler.addProvider(PEER_B, ids);

            // B is slow: it answers only once A has drained the queue (no timeout yet)
            const received = await run({
                delivers: (publicKey, round) => publicKey === PEER_A || round >= 3
            });

            expect(scheduler.isComplete()).toBe(true);
            expect(received.get(PEER_A)).toHaveLength(6);
            expect(received.get(PEER_B)).toHaveLength(2);
            expect(requestedIds()).toHaveLength(ids.length);
        });

        it('should recover from a stalled provider', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3', 'm4']);
            scheduler.addProvider(PEER_B, ['m1', 'm2', 'm3', 'm4']);

            scheduler.assign(); // A <- m1, m2 | B <- m3, m4
            await flushPromises();
            scheduler.markDelivered(['m1', 'm2']); // A answers, B never does

            advance(REQUEST_TIMEOUT);
            expect(scheduler.reclaimStalled()).toEqual([PEER_B]);

            // both idle now, A (penalty 0) is picked before B (penalty 1)
            expect(scheduler.assign()).toEqual([
                { publicKey: PEER_A, messageIds: ['m3', 'm4'] }
            ]);
            scheduler.markDelivered(['m3', 'm4']);

            expect(scheduler.isComplete()).toBe(true);
            expect(scheduler.penalties.get(PEER_B)).toBe(1);
            expect(request.mock.calls.filter(([publicKey]) => publicKey === PEER_B)).toHaveLength(1);
        });

        it('should recover from a disconnected provider', async () => {
            scheduler.addProvider(PEER_A, ['m1', 'm2', 'm3']);
            scheduler.addProvider(PEER_B, ['m2', 'm3', 'm4']);

            expect(scheduler.assign()).toEqual([
                { publicKey: PEER_A, messageIds: ['m1', 'm2'] },
                { publicKey: PEER_B, messageIds: ['m4', 'm3'] }
            ]);

            // B leaves mid-batch: m3 goes back, m4 (B only) is dropped
            scheduler.removeProvider(PEER_B);
            expect(Array.from(scheduler.queue)).toEqual(['m3']);

            scheduler.markDelivered(['m1', 'm2']);
            await run();

            // complete means "nothing deliverable left", not "everything received"
            expect(scheduler.isComplete()).toBe(true);

            // a new provider for m4 reopens the work
            scheduler.addProvider(PEER_C, ['m4']);
            expect(scheduler.isComplete()).toBe(false);
            expect(scheduler.assign()).toEqual([
                { publicKey: PEER_C, messageIds: ['m4'] }
            ]);
            scheduler.markDelivered(['m4']);
            expect(scheduler.isComplete()).toBe(true);
        });
    });
});

describe('MessageDeliveryTasks', () => {
    const TOPIC = 'a'.repeat(64);
    const SPACE_ID = 1;
    const REQUESTER = 'b'.repeat(64);
    const KEY = 'c'.repeat(24);

    let managers;
    let storedIds;
    let delivery;
    let sent;
    let socket;

    /** Message types and contents sent to the requester. */
    const sentOfType = type => sent.filter(message => message.type === type);
    const deliveredIds = () => sentOfType(EVENTS.NegentropyContentDelivery)
        .map(message => message.payload.content.nonce);

    beforeAll(async () => {
        managers = await createManagerInstance();

        const { db } = managers.session.getDatabase();
        const { publicKey, secretKey } = managers.session.getCredentials();

        storedIds = [];
        for (let index = 0; index < 4; index++) {
            const message = await createSpaceMessage({
                topic: TOPIC,
                messagePayload: { index },
                publicKey,
                secretKey,
                nonce: String(index).repeat(24),
            });

            const { messageId } = await createMessageRecord(db, {
                message,
                spaceId: SPACE_ID,
                senderPublicKey: publicKey,
                broadcastTimestamp: Date.now(),
            });

            storedIds.push(messageId);
        }
    });

    beforeEach(() => {
        sent = [];
        socket = { destroyed: false };

        const messageManager = {
            sendMessageToSocket: vi.fn(async message => { sent.push(message); }),
        };

        delivery = new MessageDeliveryTasks({ sessionManager: managers.session, messageManager });
    });

    afterAll(async () => {
        const { sqlite } = managers.session.getDatabase();
        await sqlite.close();
        await cleanup(managers.root);
    });

    const start = (messageIds, assignmentKey = KEY) => delivery.start({
        socket,
        peerPublicKey: REQUESTER,
        topic: TOPIC,
        spaceId: SPACE_ID,
        assignmentKey,
        messageIds,
    });

    it('should send every stored message in its own frame', async () => {
        await start(storedIds);

        const payloads = sentOfType(EVENTS.NegentropyContentDelivery);
        expect(payloads).toHaveLength(4);
        expect(payloads.every(message => message.payload.assignmentKey === KEY)).toBe(true);
        expect(deliveredIds()).toEqual(['0', '1', '2', '3'].map(digit => digit.repeat(24)));
        expect(delivery.tasks.size).toBe(0);
    });

    it('should stop between frames once the requester cancels', async () => {
        // hold the first frame on the wire until the test cancels
        let release;
        const onWire = new Promise(resolve => { release = resolve; });
        delivery.messageManager.sendMessageToSocket.mockImplementationOnce(async message => {
            sent.push(message);
            await onWire;
        });

        const running = start(storedIds);
        await vi.waitFor(() => expect(sent).toHaveLength(1));

        expect(delivery.cancel(REQUESTER, TOPIC, KEY)).toBe(true);
        release();
        await running;

        expect(sentOfType(EVENTS.NegentropyContentDelivery)).toHaveLength(1);
        expect(delivery.tasks.size).toBe(0);
    });

    it('should skip ids from a partial cancellation', async () => {
        const running = start(storedIds);
        delivery.cancel(REQUESTER, TOPIC, KEY, storedIds.slice(2));

        await running;
        expect(deliveredIds()).toEqual(['0', '1'].map(digit => digit.repeat(24)));
    });

    it('should ignore a cancellation with another key or from another peer', () => {
        start(storedIds);

        expect(delivery.cancel(REQUESTER, TOPIC, 'd'.repeat(24))).toBe(false);
        expect(delivery.cancel('e'.repeat(64), TOPIC, KEY)).toBe(false);
        expect(delivery.getTask(REQUESTER, TOPIC).controller.signal.aborted).toBe(false);
    });

    it('should abort the previous task when the same peer requests again', async () => {
        const first = start(storedIds, KEY);
        const firstTask = delivery.getTask(REQUESTER, TOPIC);
        const second = start(storedIds.slice(0, 1), 'd'.repeat(24));

        await Promise.all([first, second]);

        expect(firstTask.controller.signal.aborted).toBe(true);
        const keys = sentOfType(EVENTS.NegentropyContentDelivery).map(message => message.payload.assignmentKey);
        expect(keys).toContain('d'.repeat(24));
    });

    it('should report missing ids with a partial cancellation', async () => {
        const missing = 'f'.repeat(64);

        await start([storedIds[0], missing]);

        const [cancel] = sentOfType(EVENTS.NegentropyContentCancel);
        expect(cancel.payload).toEqual({ assignmentKey: KEY, messageIds: [missing] });
        expect(deliveredIds()).toEqual(['0'.repeat(24)]);
    });

    it('should cancel the whole assignment when nothing is stored', async () => {
        await start(['f'.repeat(64), 'e'.repeat(64)]);

        expect(sentOfType(EVENTS.NegentropyContentDelivery)).toHaveLength(0);
        const [cancel] = sentOfType(EVENTS.NegentropyContentCancel);
        expect(cancel.payload).toEqual({ assignmentKey: KEY });
    });

    it('should report a message deleted while the delivery is running', async () => {
        const { db } = managers.session.getDatabase();
        const { publicKey, secretKey } = managers.session.getCredentials();
        const message = await createSpaceMessage({
            topic: TOPIC, messagePayload: { index: 9 }, publicKey, secretKey, nonce: '9'.repeat(24),
        });
        const { messageId: doomedId } = await createMessageRecord(db, {
            message, spaceId: SPACE_ID, senderPublicKey: publicKey, broadcastTimestamp: Date.now(),
        });

        // the first frame is on the wire when the second message gets deleted
        let release;
        const onWire = new Promise(resolve => { release = resolve; });
        delivery.messageManager.sendMessageToSocket.mockImplementationOnce(async frame => {
            sent.push(frame);
            await onWire;
        });

        const running = start([storedIds[0], doomedId]);
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        await flushMessageRecords(db, { messageId: doomedId });
        release();
        await running;

        expect(deliveredIds()).toEqual(['0'.repeat(24)]);
        const [cancel] = sentOfType(EVENTS.NegentropyContentCancel);
        expect(cancel.payload).toEqual({ assignmentKey: KEY, messageIds: [doomedId] });
    });

    it('should stop when the socket is destroyed', async () => {
        socket.destroyed = true;

        await start(storedIds);

        expect(sent).toHaveLength(0);
    });

    it('should abort every task of a disconnected peer', () => {
        start(storedIds);
        const task = delivery.getTask(REQUESTER, TOPIC);

        delivery.abortPeer(REQUESTER);

        expect(task.controller.signal.aborted).toBe(true);
        expect(delivery.tasks.size).toBe(0);
    });
});
