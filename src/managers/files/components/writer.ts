import { isNumber } from '../../../utils/general.utils.js';
import { updateDownloadRecord } from '../../../utils/files.utils.js';

export class SequentialWriter {
  private db: any;
  private nextExpectedLeaf: number;
  private registryId: number | null;
  private fileHandler: any;
  private leafCount: number | null;
  private buffer: Map<number, Buffer>;

  constructor({
    db,
    nextExpectedLeaf,
    registryId,
    fileHandler,
    leafCount,
  }: {
    db: any;
    nextExpectedLeaf?: number;
    registryId?: number | null;
    fileHandler?: any;
    leafCount?: number | null;
  }) {
    this.db = db;
    this.nextExpectedLeaf = nextExpectedLeaf || 0;
    this.registryId = registryId || null;
    this.fileHandler = fileHandler || null;
    this.leafCount = leafCount || null;

    this.buffer = new Map();
  }

  open({registryId, fileHandler, leafCount }: {
    registryId: number;
    fileHandler: any;
    leafCount: number;
  }) {
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
   * @param leafIndex
   * @param chunk
   */
  stage(leafIndex: number, chunk: Buffer) {
    if (!this.isReady()) return false;
    if (!isNumber(leafIndex) || leafIndex < 0 || leafIndex >= this.leafCount!)
      return false;

    if (leafIndex < this.nextExpectedLeaf) return false;
    if (this.buffer.has(leafIndex)) return false;
    this.buffer.set(leafIndex, chunk);

    return true;
  }

  /**
   * Write out any contiguous run starting at nextExpectedLeaf.
   */
  async flush() {
    let wrote = false;

    while (this.buffer.has(this.nextExpectedLeaf)) {
      const chunk = this.buffer.get(this.nextExpectedLeaf);
      this.buffer.delete(this.nextExpectedLeaf);

      await updateDownloadRecord(this.db, {
        registryId: this.registryId!,
        leafIndex: this.nextExpectedLeaf,
        leafContent: chunk!,
        fileHandler: this.fileHandler,
      });

      this.nextExpectedLeaf++;
      wrote = true;
    }

    if (this.nextExpectedLeaf >= this.leafCount!) return { status: 'complete' };
    return wrote ? { status: 'progress' } : { status: 'idle' };
  }

  async close(): Promise<void> {
    this.buffer.clear();
    this.fileHandler = null;
  }
}
