import os from "os";
import path from "path";
import { fileURLToPath } from 'url';
import { vi } from 'vitest';
import fs from "fs/promises";
import { createWriteStream } from "fs";
import EventEmitter, { once } from "node:events";
import { randomFillSync } from 'crypto';
import * as cryptoUtils from '../src/utils/crypto.utils.js';
import { initializeManagers } from "../src/managers/initialization.js";
import { createDatabase } from "../src/database/database.js";
import { buildSpacePayload, generateSpaceSecret } from "../src/utils/space.utils.js";
import { now } from "../src/utils/general.utils.js";
import { buildProfilePayload } from "../src/utils/profile.utils.js";
import { FrameTypes } from "../src/managers/multiplexer.manager.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../migrations');

export async function generateKeypair() {
    return await cryptoUtils.edKeyPairFromSeed(
        cryptoUtils.hexToUint8(cryptoUtils.generateRandomSecretKey(32))
    );
}

export async function createSandbox() {
    const root = await makeTempDir();
    const dbPath = path.join(root, 'db.sqlite');
    return { root, dbPath };
}

export async function createTempDatabase() {
    const { dbPath, root } = await createSandbox();
    const { db, sqlite } = await createDatabase(dbPath, MIGRATIONS_DIR);
    return { db, sqlite };
}

export async function cleanup(dir) {
    await fs.rm(dir, { recursive: true, force: true });
}

export async function makeTempDir() {
    return await fs.mkdtemp(path.join(os.tmpdir(), 'spacebook-test-'));
}

export function getMockSocket(name = 'mock socket') {
    return {
        name: name,
        write: vi.fn(),
        destroy: vi.fn()
    }
}

/**
 * Removes the multiplexer header buffer from the json payload.
 * @param {Buffer} buffer - The received buffer.
 */
export function unframeJson(buffer) {
    const payload = buffer.subarray(5);
    return payload.toString('utf8');
}

export async function buildTestSpacePayload(params) {
    const { publicKey, secretKey } = await generateKeypair();
    const input = buildSpacePayload({
        spaceName: 'My Space',
        publicKey: cryptoUtils.hex(publicKey),
        timestamp: now(),
        permissionBroadcast: 0,
        broadcastWhitelist: [cryptoUtils.hex(publicKey)],
        permissionRead: 0,
        readWhitelist: [cryptoUtils.hex(publicKey)],
        nonce: cryptoUtils.hex(cryptoUtils.randomNonce()),
        secret: generateSpaceSecret(),
        ...params,
    });

    const signature = await cryptoUtils.signJSON(input, secretKey);
    return { ...input, signature };
}

export async function buildTestProfilePayload(params = {}) {
    const { publicKey, secretKey } = await generateKeypair();
    const input = buildProfilePayload({
        username: 'My Profile',
        tag: '@pancake',
        publicKey: params.publicKey ?? cryptoUtils.hex(publicKey),
        profileURL: 'https://example.com',
        timestamp: now(),
        ...params
    });

    const signature = await cryptoUtils.signJSON(input, params.secretKey ?? secretKey);
    return { ...input, signature };
}

export async function createManagerInstance() {
    const emitter = new EventEmitter();
    const { db, sqlite } = await createTempDatabase();
    const { publicKey, secretKey } = await generateKeypair();
    const managers = initializeManagers(emitter);

    managers.session.setDatabase({ db: db, sqlite: sqlite });
    managers.session.setCredentials({
        publicKey: cryptoUtils.hex(publicKey),
        secretKey: cryptoUtils.hex(secretKey)
    });

    return { ...managers, emitter };
}

export async function createFakeP2PConnection(name = 'testSubject') {
    const managers = await createManagerInstance();
    const { publicKey, secretKey } = await generateKeypair();
    const info = { publicKey: publicKey };
    const socket = getMockSocket(name);

    managers.session.setCredentials({
        publicKey: cryptoUtils.hex(publicKey),
        secretKey: cryptoUtils.hex(secretKey)
    });

    return [managers, socket, info];
}

/**
 * Creates stack of [manager, socket, info]. 
 * @param {number} numNodes 
 * @returns {Array[]} returns array of fake P2P managers.
 */
export async function createP2PNetwork(numNodes) {
    const nodes = [];
    for (let index = 0; index < numNodes; index++) {
        const [manager, socket, info] = await createFakeP2PConnection(`node-${index}`);
        const { publicKey, secretKey } = manager.session.getCredentials();
        nodes.push({ manager, socket, info, publicKey, secretKey });
    }

    return nodes;
}

/**
 * Connects stack of P2P managers to each other using one space as topic subscription.
 * @param {Object} space - The space to derive topic hash.
 * @param {Array} nodes - stack of [manager, socket, info].
 */
export function createConnections(topicHash, nodes) {
    for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
        const currentNode = nodes[nodeIndex];

        for (let selectIndex = 0; selectIndex < nodes.length; selectIndex++) {
            if (selectIndex !== nodeIndex) {
                const targetNode = nodes[selectIndex];
                currentNode.manager.sockets.addSocket(targetNode.socket, targetNode.publicKey, [topicHash]);
            }
        }
    }
}

/**
 * generates random port number
 * @returns {number}
 */
export function getRandomPort() {
    return 2000 + Math.floor(Math.random() * (65000 - 2000 + 1));
}

/**
 * Create files with nested directories.
 * @param {string} root - Path to the root directory
 * @param {number} level - Depth of the nested file directory.
 * @returns 
 */
export async function createNestedFiles(root, level = 6) {
    let current = root;
    const expectedFiles = [];
    for (let index = 1; index <= level; index++) {
        const filename = `file-${index}.txt`;
        const filepath = path.join(current, filename);
        await fs.writeFile(filepath, `Content of file ${index}`);

        expectedFiles.push(filepath);
        if (index < level) {
            const subdir = `level-${index}`;
            current = path.join(current, subdir);
            await fs.mkdir(current);
        }
    }

    return expectedFiles.map(filepath => {
        const relativePath = path.relative(root, filepath);
        return relativePath.split(path.sep).join('/');
    });
}

/**
 * Generates a file file fileed with random bytes
 * @param {string} filePath - Path where the file will be created.
 * @param {number} sizeInMB - File size in megabytes
 * @returns {Promise<void>} Resolves when the file gets generated.
 */
export async function generateRandomFile(filePath, sizeInMB) {
    const bytesToWrite = sizeInMB * 1024 * 1024;
    const chunkSize = 64 * 1024; // 64KB chunks
    const buffer = Buffer.alloc(chunkSize);

    const writeStream = createWriteStream(filePath);
    let bytesWritten = 0;

    const writeNextChunk = () => {
        while (bytesWritten < bytesToWrite) {
            const remaining = bytesToWrite - bytesWritten;
            const currentChunkSize = Math.min(chunkSize, remaining);

            randomFillSync(buffer, 0, currentChunkSize);
            const chunk = buffer.subarray(0, currentChunkSize);
            const shouldContinue = writeStream.write(chunk);
            bytesWritten += currentChunkSize;

            if (!shouldContinue) {
                return once(writeStream, 'drain').then(writeNextChunk);
            }
        }

        writeStream.end();
        return once(writeStream, 'finish');
    }

    await writeNextChunk();
}