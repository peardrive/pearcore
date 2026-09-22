import { EventEmitter } from "events";

/**
 * Generic progress tracker for download state at `SpaceDownloadTask` 
 * and file indexing state at `LocalFileRegistry`.
 * 
 * @example
 * const tracker = new ProgressTracker();
 * tracker.setTotal(100);
 * tracker.on('progress', (snapshot) => { console.log(snapshot) });
 * tracket.record('provider or device'); // explicitly determine what is the source of incoming progress increment.
 * 
 */
export class ProgressTracker extends EventEmitter {
    /**
     * 
     * @param {Object} params
     * @param {number|undefined} [params.total]
     */
    constructor({ total=undefined } = {}) {
        super();
        this.contributions = new Map();
        this.completed = 0;
        this.total = null;
    }

    setTotal(total) {
        this.total = total;
        this.emit('progress', this.snapshot());
    }

    seed(completed) {
        this.completed = completed;
    }

    /**
     * Set new record to increment progress.
     * @param {string} source - the source of the increment of progress (key or name)
     * @param {boolean} [counted=true] - whether the increment should be counted into total or not.
     */
    record(source, counted=true) {
        this.contributions.set(source, (this.contributions.get(source) || 0) + 1);
        if (counted) { this.completed += 1; }

        this.emit('progress', this.snapshot());
    }

    /**
     * Get snapshot of the current state of the tracker
     * @returns {{
     *  percent: Number|null,
     *  contributions: Array<{ source: string, percent: Number }>
     * }}
     */
    snapshot() {
        if (!this.total) {
            return {
                percent: null,
                contributions: []
            };
        }

        return {
            percent: (this.completed / this.total) * 100,
            contributions: Array.from(this.contributions, ([source, count]) => ({
                source: source,
                percent: (count / this.total) * 100
            }))
        }
    }
}