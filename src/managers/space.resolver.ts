import type { SessionManager } from './session.manager.js';
import type { Database } from '../types/database.js';
import {
  getSpaceByTopicHash,
  getSpaceTopicHash,
  listSpaces,
} from '../utils/space.utils.js';
import type { SpaceWithWhitelists } from '../utils/space.utils.js';

/**
 * Port used by protocol code to resolve a space topic to its local space record.
 *
 * Protocol handlers depend on this interface rather than on a database query so
 * the implementation can be replaced (for example by a cache) without touching
 * handlers or guards.
 */
export interface SpaceResolver {
  /**
   * Resolves one topic hash.
   *
   * @param topic - Hashed space topic.
   * @returns The matching space with its whitelists, or null when unknown.
   */
  resolve(topic: string): Promise<SpaceWithWhitelists | null>;

  /**
   * Resolves many topic hashes at once.
   *
   * @param topics - Topic hashes to resolve.
   * @returns A map of resolved topics; unknown topics are omitted.
   */
  resolveMany(
    topics: Iterable<string>,
  ): Promise<Map<string, SpaceWithWhitelists>>;
}

/**
 * Database-backed {@link SpaceResolver}.
 *
 * Topics are not stored on space rows: they are derived from the space name,
 * public key and nonce. Resolution therefore scans the local spaces once and
 * keeps the records, including their whitelists, in the result.
 */
export class DatabaseSpaceResolver implements SpaceResolver {
  sessionManager: SessionManager;

  /**
   * @param sessionManager - Provides the database connection of the current session.
   */
  constructor(sessionManager: SessionManager) {
    this.sessionManager = sessionManager;
  }

  /** Database connection of the current session. */
  get db(): Database {
    return this.sessionManager.getDatabase().db as Database;
  }

  /** @inheritdoc */
  async resolve(topic: string): Promise<SpaceWithWhitelists | null> {
    return getSpaceByTopicHash(this.db, topic);
  }

  /** @inheritdoc */
  async resolveMany(
    topics: Iterable<string>,
  ): Promise<Map<string, SpaceWithWhitelists>> {
    const wanted = new Set(topics);
    const resolved = new Map<string, SpaceWithWhitelists>();

    if (wanted.size === 0) return resolved;

    for (const space of await listSpaces(this.db)) {
      const topic = getSpaceTopicHash(space);

      if (!wanted.has(topic)) continue;

      resolved.set(topic, space);

      if (resolved.size === wanted.size) break;
    }

    return resolved;
  }
}
