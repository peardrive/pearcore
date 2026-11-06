import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/logger.js', () => ({ createChild: () => ({ warn() {} }) }));
vi.mock('../../src/utils/general.utils.js', () => ({ now: () => Date.now() }));
vi.mock('../../src/utils/protocol.utils.js', () => ({}));

import { LeafDeliveryScheduler } from '../../src/managers/files/components/scheduler.js';

function createScheduler(batchSize, lastLeaf) {
    const scheduler = new LeafDeliveryScheduler({
        sessionManager: { getDownloadConfig: () => ({ assignedChunkSize: batchSize }) },
        providerList: new Map([['peer', { lastRequestableLeaf: lastLeaf }]]),
    });
    scheduler.sendContentRequest = vi.fn(async () => {});
    return scheduler;
}

describe('file request batch size', () => {
    it.each([1, 2, 64])('assigns at most %i inclusive leaves', batchSize => {
        const scheduler = createScheduler(batchSize, 1000);
        scheduler.seed(7, 1000);
        scheduler.assign();

        const assignment = scheduler.assignments.get('peer');
        expect([assignment.start, assignment.end]).toEqual([7, 7 + batchSize - 1]);
        expect(assignment.remaining.size).toBe(batchSize);
        expect(scheduler.queue).toEqual([[7 + batchSize, 1000]]);
    });

    it('still respects the provider limit when it is smaller than the batch', () => {
        const scheduler = createScheduler(64, 9);
        scheduler.seed(7, 12);
        scheduler.assign();

        expect(scheduler.assignments.get('peer').remaining).toEqual(new Set([7, 8, 9]));
        expect(scheduler.queue).toEqual([[10, 12]]);
    });
});
