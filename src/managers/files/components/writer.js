import { isNumber } from "../../../utils/general.utils.js";
import { closeFile } from "../../../utils/system.utils.js";
import { updateDownloadRecord } from "../../../utils/files.utils.js";

export class SequentialWriter {
    constructor({
        db,
        nextExpectedLeaf,
        registryId,
        fileHandler,
        leafCount
    }) {
        this.db = db;
        this.nextExpectedLeaf = nextExpectedLeaf || 0;
        this.registryId = registryId || null;
        this.fileHandler = fileHandler || null;
        this.leafCount = leafCount || null;

        this.buffer = new Map();
    }

    open({ registryId, fileHandler, leafCount }) {
        this.registryId = registryId;
        this.fileHandler = fileHandler;
        this.leafCount = leafCount;
    }

    isReady() {
        return (
            this.fileHandler !== null &&
            this.registryId !== null &&
            this.leafCount !== null
        );
    }

    /**
     * Inserts the buffer into the Writer's queue
     * @param {Number} leafIndex 
     * @param {Buffer} chunk 
     */
    stage(leafIndex, chunk) {
        if (!this.isReady()) return false;
        if (
            !isNumber(leafIndex) ||
            leafIndex < 0 ||
            leafIndex >= this.leafCount
        ) return false;

        if (this.buffer.has(leafIndex)) return false;
        this.buffer.set(leafIndex, chunk);

        return true;
    }

    /**
     * Write out any contiguous run starting at nextExpectedLeaf.
     * @returns {Promise<{ status: 'complete'|'progress'|'idle' }>}
     */
    async flush() {
        let wrote = false;

        while (this.buffer.has(this.nextExpectedLeaf)) {
            const chunk = this.buffer.get(this.nextExpectedLeaf);
            this.buffer.delete(this.nextExpectedLeaf);

            await updateDownloadRecord(this.db, {
                registryId: this.registryId,
                leafIndex: this.nextExpectedLeaf,
                leafContent: chunk,
                fileHandler: this.fileHandler
            });

            this.nextExpectedLeaf++;
            wrote = true;
        }

        if (this.nextExpectedLeaf >= this.leafCount) return { status: 'complete' };
        return wrote ? { status: 'progress' } : { status: 'idle' };
    }

    async close() {
        if (this.fileHandler) {
            await closeFile(this.fileHandler);
            this.fileHandler = null;
        }
    }
}