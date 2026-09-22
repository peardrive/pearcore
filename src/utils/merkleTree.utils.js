import { DEFAULT_CHUNK_SIZE } from "../constants/global.constants.js";
import { hash, hex, hexToBuffer } from "./crypto.utils.js";
import {
    isNull,
    notNull,
    isNumber,
    isObject,
    isString,
    isDefined,
    isNullOrHex,
    validateHexString,
} from "./general.utils.js";

const EMPTY_LEAF_HASH = hash(Buffer.alloc(0));

// Helper function that converts input into hex string if its not null.
const toHex = buffer => notNull(buffer) ? hex(buffer) : null;

/**
 * Calculate the number of leaf hashes that will be generated for a specific file given the file-size in bytes and the chunk-size
 * @param {number} fileSize 
 * @param {number} [chunkSize=DEFAULT_CHUNK_SIZE] 
 * @returns {number} - total number of leafs.
 */
export function getLeafCount(fileSize, chunkSize=DEFAULT_CHUNK_SIZE) {
    return fileSize === 0 ? 1 : Math.ceil(fileSize / chunkSize);
}

/**
 * Create Merkle Tree from file stream.
 *
 * @param {Object} [params]
 * @param {ReadStream} [params.stream] - read stream from the file.
 * @param {number} [params.size] - size of the input file.
 * @param {number} [params.chunkSize=DEFAULT_CHUNK_SIZE] - size of leaf chunks.
 * @param {Function|undefined} [params.onLeaf] - optional callback function called to track leaf hash generation
 *
 * @returns {Promise<{
 *   levels: Array,
 *   height: number,
 *   rootHash: String
 * }>}
 */
export async function generateMerkleTree({
    stream,
    size,
    chunkSize = DEFAULT_CHUNK_SIZE,
    onLeaf = undefined
}) {
    if (!isDefined(size) || !isNumber(size) || size < 0) {
        throw new Error("file size is invalid for merkle tree");
    }

    if (!isDefined(chunkSize) || !isNumber(chunkSize) || chunkSize <= 0) {
        throw new Error("chunk size is invalid for merkle tree");
    }

    const leafCount = getLeafCount(size, chunkSize);
    const height = Math.ceil(Math.log2(leafCount));

    const leafHashes = [];

    let pending = Buffer.alloc(0);

    for await (const data of stream) {
        pending = Buffer.concat([pending, data]);

        while (pending.length >= chunkSize) {
            const chunk = pending.subarray(0, chunkSize);
            const leafHash = hash(chunk);

            leafHashes.push(leafHash);
            // trigger callback after hash generation
            if (onLeaf) {
                const leafIndex = leafHashes.length - 1;
                onLeaf(leafHash, leafIndex);
            }

            pending = pending.subarray(chunkSize);
        }
    }

    if (pending.length > 0) {
        // append the last pending leaf
        const lastLeafHash = hash(pending);
        leafHashes.push(hash(pending));

        if (onLeaf) {
            const leafIndex = leafHashes.length - 1;
            onLeaf(lastLeafHash, leafIndex);
        }
    }

    if (size === 0) {
        leafHashes.push(EMPTY_LEAF_HASH);

        if (onLeaf) {
            onLeaf(EMPTY_LEAF_HASH, 0);
        }
    }

    if (leafHashes.length !== leafCount) {
        throw new Error(
            `Merkle leaf mismatch. Expected ${leafCount}, got ${leafHashes.length}`
        );
    }

    const levels = [];

    levels[height] = leafHashes.map((nodeHash, nodeIndex) => ({
        nodeIndex,
        level: height,
        hash: nodeHash,
        parentHash: null,
        leftChildHash: null,
        rightChildHash: null,
        leafIndex: nodeIndex,
    }));

    for (let currentLevel = height; currentLevel > 0; currentLevel--) {
        const currentNodes = levels[currentLevel];
        const parentNodes = [];

        for (
            let nodeIndex = 0; nodeIndex < currentNodes.length; nodeIndex += 2) {
            const leftNode = currentNodes[nodeIndex];
            const rightNode = currentNodes[nodeIndex + 1];

            let parentHash;
            let rightHash = null;

            if (rightNode) {
                rightHash = rightNode.hash;

                parentHash = hash(
                    Buffer.concat([
                        leftNode.hash,
                        rightNode.hash
                    ])
                );
            }

            else {
                parentHash = hash(Buffer.from(leftNode.hash));
            }

            leftNode.parentHash = parentHash;

            if (rightNode) {
                rightNode.parentHash = parentHash;
            }

            parentNodes.push({
                level: currentLevel - 1,
                nodeIndex: parentNodes.length,
                hash: parentHash,
                parentHash: null,
                leftChildHash: leftNode.hash,
                rightChildHash: rightHash,
                leafIndex: null,
            });
        }

        levels[currentLevel - 1] = parentNodes;
    }

    // convert hash buffers into hex string
    const hexLevels = levels.map(level => {
        return level.map(node => ({
            nodeIndex: node.nodeIndex,
            level: node.level,
            hash: toHex(node.hash),
            parentHash: toHex(node.parentHash),
            leftChildHash: toHex(node.leftChildHash),
            rightChildHash: toHex(node.rightChildHash),
            leafIndex: node.leafIndex,
        }));
    });

    return {
        levels: hexLevels,
        height: height,
        rootHash: hexLevels[0][0].hash,
    };
}

/**
 * Validates the structure of a single Merkle tree node.
 * @param {Object} node - The node object to validate.
 * @returns {{isValid: boolean, reason: string}}
 */
export function validateMerkleNode(node) {
    const rules = [
        ['node should be an object', () => isObject(node)],
        ['level should be defined', () => isDefined(node.level)],
        ['level should be number', () => isNumber(node.level)],
        ['nodeIndex should be defined', () => isDefined(node.nodeIndex)],
        ['hash should be defined', () => isDefined(node.hash)],
        ['hash should be valid hex string', () => validateHexString(node.hash)],
        ['parentHash should be null or hex string', () => isNullOrHex(node.parentHash)],
        ['leftChildHash must be null or hex string', () => isNullOrHex(node.leftChildHash)],
        ['rightChildHash must be null or hex string', () => isNullOrHex(node.rightChildHash)],
        ['leafIndex should be null or non-negative number', () =>
            isNull(node.leafIndex) || (isNumber(node.leafIndex) && node.leafIndex >= 0)],
    ];

    for (const [reason, condition] of rules) {
        if (!condition()) { return { isValid: false, reason }; }
    }

    return { isValid: true, reason: 'node is valid' };
}

/**
 * Validates the strucutre of the Merkle Tree.
 * @param {Object} tree - The tree object.
 * @param {Array<Array<Object>>} tree.levels - Array of levels, each level is an array of node objects.
 * @param {number} tree.height - The height of the tree (root level = 0, leaf level = height).
 * @param {string} tree.rootHash - The claimed root hash in hex string.
 * @returns {{isValid: boolean, reason: string}} - True if the tree is valid, false otherwise.
 */
export function validateMerkleTree(tree) {
    const validationRules = [
        ['tree should be defined', () => isDefined(tree)],
        ['tree must be an object', () => isObject(tree)],

        ['levels are required', () => isDefined(tree.levels)],
        ['levels must be an array', () => Array.isArray(tree.levels)],

        ['height should be a number', () => isNumber(tree.height)],

        ['rootHash should be defined', () => isDefined(tree.rootHash)],
        ['rootHash should be valid hex string', () => validateHexString(tree.rootHash)],

        ['levels length should equal height + 1', () => tree.levels.length === tree.height + 1],

    ];

    for (const [reason, condition] of validationRules) {
        if (!condition()) {
            return { isValid: false, reason };
        }
    }

    for (const level of tree.levels) {
        if (level.length === 0) {
            return { isValid: false, reason: 'level should not be empty' };
        }

        for (const node of level) {
            const status = validateMerkleNode(node);
            if (!status.isValid) {
                return { isValid: false, reason: status.reason };
            }
        }
    }

    return { isValid: true, reason: 'tree structure is valid' };
}

/**
 * Validates the strucutre of the Merkle Tree.
 * @param {Object} tree - The tree object.
 * @param {Array<Array<Object>>} tree.levels - Array of levels, each level is an array of node objects.
 * @param {number} tree.height - The height of the tree (root level = 0, leaf level = height).
 * @param {string} tree.rootHash - The claimed root hash in hex string.
 * @returns {{isValid: boolean, reason: string}} - True if the tree is valid, false otherwise.
 */
export function verifyMerkleTree(tree) {
    const { levels, height, rootHash } = tree;

    if (levels[0][0].hash !== rootHash) {
        return {
            isValid: false,
            reason: 'root hash does not match the tree'
        };
    }

    // starting with leafs
    let currentLevelHash = levels[height].map(node => hexToBuffer(node.hash));

    for (let level = height; level > 0; level--) {
        const nextLevelHashes = [];

        for (let index = 0; index < currentLevelHash.length; index += 2) {
            const left = currentLevelHash[index];
            const right = currentLevelHash[index + 1];

            let parentHash = null;
            if (right) {
                parentHash = hash(Buffer.concat([left, right]));
            }
            else { parentHash = hash(left); }

            nextLevelHashes.push(parentHash);
        }

        currentLevelHash = nextLevelHashes;
    }

    const computedRootHash = hex(currentLevelHash[0]);
    if (computedRootHash !== rootHash) {
        return {
            isValid: false,
            reason: 'root hash does not match the tree'
        };
    }

    return {
        isValid: true,
        reason: 'tree is verified'
    };
}