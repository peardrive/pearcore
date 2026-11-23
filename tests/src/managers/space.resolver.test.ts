import { describe, it, expect, beforeEach } from 'vitest';
import type { SessionManager } from '../../../src/managers/session.manager.js';
import { DatabaseSpaceResolver } from '../../../src/managers/space.resolver.js';
import {
  createSpace,
  getSpaceTopicHash,
} from '../../../src/utils/space.utils.js';
import {
  buildTestSpacePayload,
  createTempDatabase,
} from '../../helpers/general.utils.js';
import type { Database } from '../../../src/types/database.js';
import type { SignedSpace } from '../../../src/utils/space.utils.js';

describe('DatabaseSpaceResolver', () => {
  let db: Database;
  let resolver: DatabaseSpaceResolver;
  let testSpace: SignedSpace;

  beforeEach(async () => {
    const { db: dbInstance } = await createTempDatabase();
    db = dbInstance;

    const sessionManager = {
      getDatabase: () => ({ db }),
    } as unknown as SessionManager;

    resolver = new DatabaseSpaceResolver(sessionManager);
    testSpace = await buildTestSpacePayload();
  });

  it('resolves a known topic to the space record with whitelists', async () => {
    const { spaceId } = await createSpace(db, testSpace);

    const space = (await resolver.resolve(getSpaceTopicHash(testSpace)))!;

    expect(space.id).toBe(spaceId);
    expect(space.readWhitelist).toEqual([testSpace.publicKey]);
  });

  it('returns null for an unknown topic', async () => {
    expect(await resolver.resolve('f'.repeat(64))).toBeNull();
  });

  it('resolves many topics in one pass and omits unknown ones', async () => {
    await createSpace(db, testSpace);

    const known = getSpaceTopicHash(testSpace);
    const unknown = 'f'.repeat(64);
    const spaces = await resolver.resolveMany([known, unknown]);

    expect(spaces.size).toBe(1);
    expect(spaces.get(known)?.spaceName).toBe(testSpace.spaceName);
    expect(spaces.has(unknown)).toBe(false);
  });

  it('returns an empty map when no topics are requested', async () => {
    const spaces = await resolver.resolveMany([]);

    expect(spaces.size).toBe(0);
  });
});
