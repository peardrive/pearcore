// @ts-nocheck
import type { BaseCoreFactory } from './factory.base.js';
import { hexToUint8 } from '../src/utils/crypto.utils.js';
import { getMockSocket } from './general.utils.js';

/**
 * A factory-backed core plus a fake socket used to inject protocol frames.
 *
 * Protocol handlers are tested directly (`handleIncomingMessage`) so replies can
 * be asserted from the fake socket. The core itself is real: account, database,
 * managers and profile all come from the factory.
 */
export interface ProtocolNode {
  name: string;
  core: any;
  manager: any;
  socket: any;
  info: { publicKey: Uint8Array };
  publicKey: string;
  secretKey: string;
  root: string;
  emitter: any;
}

function toNode(core: any, name: string): ProtocolNode {
  return {
    name,
    core,
    manager: core.managers,
    socket: getMockSocket(name),
    // Protocol handlers hex-encode `info.publicKey`, so keep bytes here.
    info: { publicKey: hexToUint8(core.publicKey) },
    publicKey: core.publicKey,
    secretKey: core.secretKey,
    root: core.root,
    emitter: core.emitter,
  };
}

export async function createProtocolNode(
  factory: BaseCoreFactory,
  name = 'node-0',
): Promise<ProtocolNode> {
  const core = await factory.createCore(name);
  return toNode(core, name);
}

export async function createProtocolNodes(
  factory: BaseCoreFactory,
  count: number,
): Promise<ProtocolNode[]> {
  const cores = await factory.createMultipleCores(count);
  return cores.map((core, index) => toNode(core, `node-${index}`));
}

/**
 * Registers every node's fake socket in every other node's socket manager,
 * mirroring a topic clique. No transport is involved; frames are injected
 * directly by the test.
 */
export function connectProtocolNodes(
  topicHash: string,
  nodes: ProtocolNode[],
): void {
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex++) {
    const currentNode = nodes[nodeIndex];

    for (let selectIndex = 0; selectIndex < nodes.length; selectIndex++) {
      if (selectIndex !== nodeIndex) {
        const targetNode = nodes[selectIndex];
        currentNode.manager.sockets.addSocket(
          targetNode.socket,
          targetNode.publicKey,
          [topicHash],
        );
      }
    }
  }
}
