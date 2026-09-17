import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Readable } from "stream";
import {
    generateMerkleTree,
    getLeafCount,
    validateMerkleTree,
    verifyMerkleTree
} from "../../src/utils/merkletree.utils.js";

function createStream(chunks) {
    return Readable.from(chunks);
}

function cloneTree(tree) {
    return JSON.parse(JSON.stringify(tree));
}

describe('Merkle Tree', () => {
    describe('generateMerkleTree', () => {
        it('should throw when the size or chunkSize is invalid', async () => {
            const stream = createStream([]);

            await expect(
                generateMerkleTree({
                    stream, size: null, chunkSize: 1024
                })
            ).rejects.toThrow();

            await expect(
                generateMerkleTree({ stream, size: 0, chunkSize: 0 })
            ).rejects.toThrow();
        });

        it('should generate a tree for an empty file', async () => {
            const tree = await generateMerkleTree({
                stream: createStream([]),
                size: 0,
                chunkSize: 1024
            });

            expect(tree.height).toBe(0);

            expect(tree.levels[0]).toHaveLength(1);
            expect(tree.rootHash).toBeDefined();
        });

        it('should generate root from two leaves', async () => {
            const chunk1 = Buffer.alloc(1024, 'a');
            const chunk2 = Buffer.alloc(1024, 'b');

            const tree = await generateMerkleTree({
                stream: createStream([chunk1, chunk2]),
                size: chunk1.length + chunk2.length,
                chunkSize: 1024
            });

            expect(tree.height).toBe(1);

            expect(tree.levels[1]).toHaveLength(2);
            expect(tree.levels[0]).toHaveLength(1);

            const root = tree.levels[0][0];

            expect(root.leftChildHash).toBeDefined();
            expect(root.rightChildHash).toBeDefined();
        });

        it('should handle odd number of leaves', async () => {
            const chunkSize = 1024;

            const tree = await generateMerkleTree({
                stream: createStream([
                    Buffer.alloc(chunkSize, 'a'),
                    Buffer.alloc(chunkSize, 'b'),
                    Buffer.alloc(chunkSize, 'c'),
                ]),
                size: chunkSize * 3,
                chunkSize
            });

            expect(tree.levels[2]).toHaveLength(3);
            expect(tree.levels[1]).toHaveLength(2);
            expect(tree.levels[0]).toHaveLength(1);

            const orphanParent = tree.levels[1][1];

            expect(orphanParent.leftChildHash).toBeDefined();
            expect(orphanParent.rightChildHash).toBeNull();
        });
    });

    describe('validation and verification', () => {
        let validTree = null;

        beforeEach(async () => {
            const chunks = [
                Buffer.alloc(1024, 'a'),
                Buffer.alloc(1024, 'b'),
                Buffer.alloc(1024, 'c'),
                Buffer.alloc(1024, 'd')
            ];

            validTree = await generateMerkleTree({
                stream: createStream(chunks),
                size: chunks.length * 1024,
                chunkSize: 1024
            });
        });

        describe('validateMerkleTree', () => {

            it('should pass validation for a valid tree', () => {
                const result = validateMerkleTree(validTree);
                expect(result.isValid).toBe(true);
            });

            it('should fail if tree is undefined or null', () => {
                expect(validateMerkleTree(undefined).isValid).toBe(false);
                expect(validateMerkleTree(null).isValid).toBe(false);
            });

            it('should fail if levels is missing', () => {
                const corrupted = cloneTree(validTree);
                delete corrupted.levels;
                const result = validateMerkleTree(corrupted);
                expect(result.isValid).toBe(false);
                expect(result.reason).toMatch(/levels/);
            });

            it('should fail if levels length does not equal height + 1', () => {
                const corrupted = cloneTree(validTree);
                corrupted.levels.pop(); // remove one level
                const result = validateMerkleTree(corrupted);
                expect(result.isValid).toBe(false);
                expect(result.reason).toMatch(/levels length/);
            });

            it('should fail if rootHash is not a valid hex string', () => {
                const corrupted = cloneTree(validTree);
                corrupted.rootHash = 'not-hex';
                const result = validateMerkleTree(corrupted);
                expect(result.isValid).toBe(false);
                expect(result.reason).toMatch(/rootHash.*hex/);
            });
        });

        describe('verifyMerkleTree', () => {
            it('should pass verification for valid tree', () => {
                const result = verifyMerkleTree(validTree);
                expect(result.isValid).toBe(true);
            });

            it('should fail if the rootHash is tampered', () => {
                const corrupted = cloneTree(validTree);
                corrupted.rootHash = 'f'.repeat(32);

                const result = verifyMerkleTree(corrupted);
                expect(result.isValid).toBe(false);
            });

            it('should fail if a leaf hash is tampered', () => {
                const corrupted = cloneTree(validTree);
                const leafLevel = corrupted.levels[corrupted.height];
                // Change the first leaf's hash to a different hex string
                leafLevel[0].hash = 'f'.repeat(32);
                const result = verifyMerkleTree(corrupted);
                expect(result.isValid).toBe(false);
            });
        });
    });
});