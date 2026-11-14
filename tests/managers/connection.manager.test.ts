import * as EVENTS from '../../src/constants/events.constants.js';
import { describe, it, beforeEach, afterEach, expect } from 'vitest';
import { startBootstrapper } from '../../src/utils/network.utils.js';
import {
  buildTestSpacePayload,
  createManagerInstance,
  getRandomPort,
} from '../general.utils.js';
import { upsertSpace } from '../../src/utils/space.utils.js';

type Bootstrapper = Awaited<ReturnType<typeof startBootstrapper>>;

const killBootstapper = (bootstrapper: Bootstrapper): void => {
  bootstrapper.bootstrapperNode.destroy();
  bootstrapper.persistentNode.destroy();
};

describe('ConnectionManager', () => {
  let bootstrapperInstance: Bootstrapper | null = null;
  let bootstrapperEndpoint = '';

  beforeEach(async () => {
    const randomPort = getRandomPort();
    bootstrapperInstance = await startBootstrapper({
      ipv4: '127.0.0.1',
      port: randomPort,
    });

    bootstrapperEndpoint = `127.0.0.1:${randomPort}`;
  });

  afterEach(() => {
    killBootstapper(bootstrapperInstance!);
  });

  it('should connect two nodes to each other under same space topic', async () => {
    const primary = await createManagerInstance();
    const secondary = await createManagerInstance();

    primary.session.setBootstrapperEndpoint(bootstrapperEndpoint);
    secondary.session.setBootstrapperEndpoint(bootstrapperEndpoint);

    const primaryDB = primary.session.getDatabase().db!;
    const secondaryDB = secondary.session.getDatabase().db!;

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

    await primary.connection.init();
    await secondary.connection.init();

    // waiting for connect to stablish
    await connectionPromise;

    expect(primaryConnected).toBe(true);
    expect(secondaryConnected).toBe(true);
  });
});
