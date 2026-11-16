import * as EVENTS from '../../src/constants/events.constants.js';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { buildTestSpacePayload } from '../general.utils.js';
import { CoreFactory } from '../factory.js';
import { upsertSpace } from '../../src/utils/space.utils.js';

describe('ConnectionManager', () => {
  let factory: CoreFactory;

  beforeEach(async () => {
    factory = new CoreFactory();
    await factory.init();
  });

  afterEach(async () => {
    await factory.cleanup();
  });

  it('should connect two nodes to each other under same space topic', async () => {
    const primary = await factory.createBareCore();
    const secondary = await factory.createBareCore();

    const primaryDB = primary.managers.session.getDatabase().db!;
    const secondaryDB = secondary.managers.session.getDatabase().db!;

    const spaceParams = await buildTestSpacePayload({
      spaceName: 'Connection Test',
    });

    // one has space record and the other has sharelink record
    // both should join same topic
    await upsertSpace(primaryDB, spaceParams);
    await upsertSpace(secondaryDB, spaceParams);

    let primaryConnected = false;
    let secondaryConnected = false;

    const connectionPromise = new Promise<void>((resolve) => {
      const checkAndResolve = () => {
        if (primaryConnected && secondaryConnected) {
          resolve();
        }
      };

      primary.emitter.on(EVENTS.Connection, () => {
        primaryConnected = true;
        checkAndResolve();
      });

      secondary.emitter.on(EVENTS.Connection, () => {
        secondaryConnected = true;
        checkAndResolve();
      });
    });

    await primary.managers.connection.init();
    await secondary.managers.connection.init();

    // waiting for connect to stablish
    await connectionPromise;

    expect(primaryConnected).toBe(true);
    expect(secondaryConnected).toBe(true);
  });
});
