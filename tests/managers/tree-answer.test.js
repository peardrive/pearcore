import { describe, expect, it } from "vitest";
import { Readable } from "stream";
import { SpaceTreePuller } from '../../src/managers/files/components/trees.js';
import { ProviderList } from '../../src/managers/files/components/providers.js';
import { SpaceDownloadTask } from '../../src/managers/files/components/download.js';
import { generateMerkleTree } from "../../src/utils/merkleTree.utils.js";

// No network: a provider's answer is handed to the puller and the task directly.
// Field, Oct 28 2026: the phone answered every tree request for two videos with a
// tree we could not use; pearcore dropped it in silence and asked again on every
// heartbeat (5 s), for hours — ~146 KB of trees every 5 s and no download.

const TOPIC = 'aa'.repeat(32);
const PATH = '/2024/clip.mov';
const PROVIDER = 'bb'.repeat(32);
const ASKED = 'ab'.repeat(32);
const NONCE = 'cd'.repeat(12);

const treeOf = async (bytes) => generateMerkleTree({ stream: Readable.from([bytes]), size: bytes.length });
const answer = (tree, replyNonce = NONCE) => ({ topic: TOPIC, publicKey: PROVIDER, payload: { tree, lastRequestableLeaf: tree.levels.at(-1).length, replyNonce } });
const puller = (rootHash) => new SpaceTreePuller({ topic: TOPIC, spaceFilePath: PATH, rootHash });

describe('a tree answer we cannot use', () => {
    it('is reported as an answer from that provider, and the request is cleared', async () => {
        const held = await treeOf(Buffer.alloc(3000, 7)); // the version the provider holds now
        const p = puller(ASKED);
        p.pendingRequests.set(NONCE, PROVIDER);

        const result = p.verify(answer(held));

        expect(result.succeed).toBe(false);
        expect(result.answered).toBe(true);
        expect(result.publicKey).toBe(PROVIDER);
        expect(result.reason).toMatch(/^tree rootHash mismatch \(sent .{8}…, asked abababab…\)$/);
        expect(p.isPending(PROVIDER)).toBe(false);
    });

    it('a broken tree for the version we asked for is an answer too', async () => {
        const tree = await treeOf(Buffer.alloc(3000, 7));
        const broken = { ...tree, levels: tree.levels.map((l, i) => i === 0 ? l.map(() => 'ee'.repeat(32)) : l) };
        const p = puller(tree.rootHash);
        p.pendingRequests.set(NONCE, PROVIDER);

        const result = p.verify(answer(broken));

        expect(result.succeed).toBe(false);
        expect(result.answered).toBe(true);
        expect(result.reason).toMatch(/^invalid tree/);
    });

    it('a reply to a request we never sent is not an answer', async () => {
        const tree = await treeOf(Buffer.alloc(3000, 7));
        const result = puller(ASKED).verify(answer(tree));
        expect(result.succeed).toBe(false);
        expect(result.answered).toBeUndefined();
    });

    it('the task takes it as a refusal: callbacks hear it, and the provider is not asked again until it announces the file', async () => {
        const held = await treeOf(Buffer.alloc(3000, 7));
        let peers = { [PROVIDER]: { timestamp: 1, signature: 'x' } };
        const listManager = { get: () => ({ [PATH]: { [ASKED]: { peers } } }) };
        const released = [];
        const task = Object.create(SpaceDownloadTask.prototype);
        Object.assign(task, {
            spaceFilePath: PATH,
            rootHash: ASKED,
            downloadComplete: false,
            tree: null,
            puller: puller(ASKED),
            providerList: new ProviderList({ spaceFileListManager: listManager, topic: TOPIC, spaceFilePath: PATH, rootHash: ASKED }),
            scheduler: { releaseProvider: (pk) => released.push(pk), assign: () => {} },
            _refusedCallbacks: new Set(),
        });
        task.providerList.refresh();
        expect(task.providerList.has(PROVIDER)).toBe(true);

        const refusals = [];
        task.onRefused((r) => refusals.push(r));
        task.puller.pendingRequests.set(NONCE, PROVIDER);
        await task.onTreeResponse(answer(held));

        expect(refusals).toEqual([{ publicKey: PROVIDER, reason: expect.stringMatching(/^tree rootHash mismatch/), left: 0 }]);
        expect(released).toEqual([PROVIDER]);
        expect(task.tree).toBeNull();
        // the next heartbeat refreshes the list: still set aside, so nobody asks it again
        task.providerList.refresh();
        expect(task.providerList.has(PROVIDER)).toBe(false);
        expect(task.puller.shouldRequest(PROVIDER, undefined, null)).toBe(true); // the puller alone would ask; the list keeps it out
        // it announces the file again: it may be asked again
        task.onProviderEvent?.call({ ...task, askAll: () => {} }, { payload: [{ files: [[PATH, PROVIDER, 2, ASKED, 'y']] }] });
        task.providerList.refresh();
        expect(task.providerList.has(PROVIDER)).toBe(true);
    });
});
