import { createCore } from "../src/core.js";
import { startBootstrapper } from "../src/utils/network.utils.js";
import { createProfileForPublicKey } from "../src/utils/profile.utils.js";
import { getRandomPort, cleanup, makeTempDir } from "./general.utils.js";

export class CoreFactory {
    constructor() {
        this.bootstrapperInstance = null;
        this.bootstrapperEndpoint = null;
        this.cores = [];
    }

    async init() {
        const randomPort = getRandomPort();
        this.bootstrapperInstance = await startBootstrapper({
            ipv4: '127.0.0.1',
            port: randomPort
        });

        this.bootstrapperEndpoint = `127.0.0.1:${randomPort}`;
    }

    async cleanup() {
        for (const core of this.cores) {
            try {
                await core.accounts.logout();

                if (core.root) {
                    await cleanup(core.root);
                }
            }
            catch (error) {
                console.error(error);
            }
        }

        this.cores = [];

        if (this.bootstrapperInstance) {
            await this.bootstrapperInstance.bootstrapperNode.destroy();
            await this.bootstrapperInstance.persistentNode.destroy();
        }
    }

    async createCore(username = 'test user') {
        const root = await makeTempDir();
        const core = await createCore({
            bootstrap: this.bootstrapperEndpoint,
            rootPath: root
        });

        await core.accounts.create(username, 'testPassword');
        await core.accounts.authenticate(username, 'testPassword');

        const { publicKey, secretKey } = core.managers.session.getCredentials();
        const { db } = core.managers.session.getDatabase();

        const profile = {
            username: username,
            tag: `tag@${username}`,
            profileURL: null,
        }

        await createProfileForPublicKey(db, { ...profile, publicKey }, secretKey);

        const extendedCore = { ...core, root, publicKey, secretKey };
        this.cores.push(extendedCore);
        return extendedCore;
    }

    async createMultipleCores(count) {
        const cores = [];
        for (let index = 0; index < count; index++) {
            const username = `testUserIndex_${index}`;
            const core = await this.createCore(username);
            cores.push(core);
        }

        return cores;
    }

    async condition(fn, opts = {}) {
        const { excludeIndices = [], timeout = 10000 } = opts;

        return new Promise((resolve, reject) => {
            let results = [];
            const corePromises = [];

            const timer = setTimeout(() => {
                reject(new Error(`condition timeout after ${timeout} ms`))
            },
                timeout
            );

            const resolverFactory = (resolver, index) => {
                const caller = (successState) => {
                    return (data = {}) => {
                        results.push({
                            index: index,
                            success: successState,
                            data: data
                        });

                        resolver();
                    }
                }

                return {
                    success: caller(true),
                    failure: caller(false)
                };
            }

            for (let index = 0; index < this.cores.length; index++) {
                if (excludeIndices.includes(index)) continue;

                corePromises.push(new Promise(resolveCore => {
                    const { success, failure } = resolverFactory(resolveCore, index);
                    fn(this.cores[index], success, failure);
                }))
            }

            Promise.allSettled(corePromises)
                .then(() => {
                    clearTimeout(timer);
                    resolve(results);
                })
                .catch(error => {
                    clearTimeout(timer);
                    reject(error);
                });
        });
    }
}