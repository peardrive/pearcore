import { describe, it, expect, beforeEach } from 'vitest';
import { SocketManager } from '../../src/managers/sockets.manager.js';
import type { ManagedSocket } from '../../src/managers/sockets.manager.js';
import { getMockSocket } from '../general.utils.js';

describe('SocketManager', () => {
  let manager: SocketManager;
  let sockets: ManagedSocket[] = [];

  beforeEach(() => {
    manager = new SocketManager();

    const socketA = getMockSocket('socketA');
    const socketB = getMockSocket('socketB');
    const socketC = getMockSocket('socketC');

    sockets = [socketA, socketB, socketC];

    manager.addSocket(socketA, 'peerA', ['topic0xA', 'topic0xB']);
    manager.addSocket(socketB, 'peerB', ['topic0xB', 'topic0xC']);
    manager.addSocket(socketC, 'peerC', ['topic0xC', 'topic0xA']);
  });

  describe('addSocket', () => {
    it('should register new peer with topics', () => {
      const socket = getMockSocket();
      const peerKey = '0xAABBCC';
      const topics = ['Topic0x1', 'Topic0x2'];

      manager.addSocket(socket, peerKey, topics);

      expect(manager.peers.has(peerKey)).toBe(true);

      const peer = manager.peers.get(peerKey)!;
      expect(peer.socket).toBe(socket);
      expect(peer.topics.size).toBe(2);

      expect(manager.topicIndex.get('Topic0x1')!.has(peerKey)).toBe(true);
      expect(manager.topicIndex.get('Topic0x2')!.has(peerKey)).toBe(true);

      expect(manager.socketIndex.get(socket)).toBe(peerKey);
    });
  });

  describe('removeSocket', () => {
    it('should remove peer and clean indexes', () => {
      const socket = getMockSocket();
      const peerKey = '0xAABBCC';
      const topics = ['Topic0x1', 'Topic0x2'];

      manager.addSocket(socket, peerKey, topics);
      manager.removeSocket(socket);

      expect(manager.peers.has(peerKey)).toBe(false);
      expect(manager.socketIndex.get(socket)).toBeUndefined();
      expect(manager.topicIndex.has('Topic0x1')).toBe(false);
      expect(manager.topicIndex.has('Topic0x2')).toBe(false);

      expect(socket.destroy).toHaveBeenCalled();
    });

    it('should remove the correct peer from topicIndex', () => {
      const socketA = getMockSocket();
      const socketB = getMockSocket();

      manager = new SocketManager();
      manager.addSocket(socketA, 'peerA', ['shared']);
      manager.addSocket(socketB, 'peerB', ['shared']);

      manager.removeSocket(socketA);

      expect(manager.peers.has('peerA')).toBe(false);
      expect(manager.peers.has('peerB')).toBe(true);

      const set = manager.topicIndex.get('shared')!;
      expect(set.has('peerB')).toBe(true);
      expect(set.has('peerA')).toBe(false);
    });
  });

  describe('getPeerInfoBySocket', () => {
    it('should return publicKey and topics for socket', () => {
      const [socketA, socketB, socketC] = sockets;

      const resultA = manager.getPeerInfoBySocket(socketA);
      expect(resultA.publicKey).toBe('peerA');
      expect(resultA.topics).toEqual(['topic0xA', 'topic0xB']);

      const resultB = manager.getPeerInfoBySocket(socketB);
      expect(resultB.publicKey).toBe('peerB');
      expect(resultB.topics).toEqual(['topic0xB', 'topic0xC']);

      const resultC = manager.getPeerInfoBySocket(socketC);
      expect(resultC.publicKey).toBe('peerC');
      expect(resultC.topics).toEqual(['topic0xC', 'topic0xA']);
    });

    it('should throw when socket is not found in manager', () => {
      expect(() => {
        manager.getPeerInfoBySocket(getMockSocket('socketRandom'));
      }).toThrow('socket has no peerkey record');
    });
  });

  describe('getConnectedSockets', () => {
    it('should return all socket if query is empty', () => {
      const sockets = manager.getConnectedSockets();
      expect(sockets.length).toBe(3);
      expect(sockets.map((s) => s.name).sort()).toEqual([
        'socketA',
        'socketB',
        'socketC',
      ]);
    });

    it('should return sockets filtered by peerKey', () => {
      const sockets = manager.getConnectedSockets({
        peers: ['peerA', 'peerC'],
      });

      expect(sockets.length).toBe(2);
      expect(sockets.map((s) => s.name)).toEqual(['socketA', 'socketC']);
    });

    it('should return sockets filtered by topics', () => {
      const sockets = manager.getConnectedSockets({
        topics: ['topic0xA', 'topic0xB'],
      });

      expect(sockets.length).toBe(3);
      expect(sockets.map((s) => s.name).sort()).toEqual([
        'socketA',
        'socketB',
        'socketC',
      ]);
    });

    it('should return intersection of peerKeys and topics', () => {
      const sockets = manager.getConnectedSockets({
        peers: ['peerA', 'peerB'],
        topics: ['topic0xA'],
      });
      // between peerA and peerB, only peerA is subscribed to topic0xA, thus
      // the result of intersection is only socket A
      expect(sockets.length).toBe(1);
      expect(sockets.map((s) => s.name).sort()).toEqual(['socketA']);
    });

    it('should return empty result for intersection of topics with empty peers array', () => {
      const sockets = manager.getConnectedSockets({
        peers: [],
        topics: ['topic0xA'],
      });
      expect(sockets.length).toBe(0);
    });
  });

  describe('getPeerKeys', () => {
    it('should return all peer keys if no filter is provided', () => {
      const peerKeys = manager.getPeerKeys();
      expect(peerKeys.length).toBe(3);
      expect(peerKeys).toEqual(['peerA', 'peerB', 'peerC']);
    });

    it('should return subset of peer keys if filter is provided', () => {
      const peerKeys = manager.getPeerKeys((key) =>
        ['peerA', 'peerB'].includes(key),
      );
      expect(peerKeys.length).toBe(2);
      expect(peerKeys).toEqual(['peerA', 'peerB']);
    });

    it('should throw error if filter is not function', () => {
      expect(() => {
        // @ts-expect-error -- exercise the runtime filter type guard
        manager.getPeerKeys('filter');
      }).toThrow();
    });
  });

  describe('getSnapShot', () => {
    it('should return snapshot sorted by peers', () => {
      const result = manager.getSnapShot({
        sortByPeers: true,
        sortByTopic: false,
      });
      expect(result).toEqual({
        peerA: ['topic0xA', 'topic0xB'],
        peerB: ['topic0xB', 'topic0xC'],
        peerC: ['topic0xC', 'topic0xA'],
      });
    });

    it('should return snapshot sorted by topics', () => {
      const result = manager.getSnapShot({
        sortByPeers: false,
        sortByTopic: true,
      });

      expect(result).toEqual({
        topic0xA: ['peerA', 'peerC'],
        topic0xB: ['peerA', 'peerB'],
        topic0xC: ['peerB', 'peerC'],
      });
    });

    it('should throw error when both sortByPeers and sortByTopic are true', () => {
      expect(() => {
        manager.getSnapShot({ sortByPeers: true, sortByTopic: true });
      }).toThrow('Cannot sort by both peers and topics simultaneously');
    });

    it('should throw error when neither sortByPeers nor sortByTopic is true', () => {
      expect(() => {
        manager.getSnapShot({ sortByPeers: false, sortByTopic: false });
      }).toThrow("Either 'sortByPeers' or 'sortByTopic' must be true.");
    });
  });
});
