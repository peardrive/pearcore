import os from 'os';
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { connectSwarm, getIPv4, joinSwarmTopic, startBootstrapper } from "../../src/utils/network.utils.js";
import { edKeyPairFromSeed, generateRandomSecretKey, hex, hexToUint8, hash } from '../../src/utils/crypto.utils.js';
import { getRandomPort } from '../general.utils.js';

describe('P2P networking', () => {
    describe('getIPv4', () => {
        beforeEach(() => {
            vi.clearAllMocks();
        });

        it('should return empty array when no network interfaces exist', () => {
            vi.spyOn(os, 'networkInterfaces').mockReturnValue({});

            const result = getIPv4();
            expect(result).toEqual([]);
        });

        it('should handle multiple non-internal IPv4 addresses', () => {
            const mockInterfaces = {
                eth0: [
                    { address: '192.168.1.100', internal: false, family: 'IPv4' }
                ],
                wlan0: [
                    { address: '10.0.0.5', internal: false, family: 'IPv4' }
                ],
                lo: [
                    { address: '127.0.0.1', internal: true, family: 'IPv4' } // should be filtered out
                ]
            };

            vi.spyOn(os, 'networkInterfaces').mockReturnValue(mockInterfaces);

            const result = getIPv4();
            expect(result).toEqual(['192.168.1.100', '10.0.0.5']);
        });

        it('should handle various network interface types', () => {
            const mockInterfaces = {
                eth0: [
                    { address: '192.168.1.100', internal: false, family: 'IPv4' },
                    { address: 'fe80::1', internal: false, family: 'IPv6' } // IPv6 should be ignored
                ],
                lo: [
                    { address: '127.0.0.1', internal: true, family: 'IPv4' }, // internal should be ignored
                    { address: '10.0.0.1', internal: false, family: 'IPv4' }
                ],
                wlan0: [
                    { address: '10.0.0.5', internal: false, family: 'IPv4' },
                    { address: 'ff02::1', internal: false, family: 'IPv6' } // IPv6 should be ignored
                ]
            };

            vi.spyOn(os, 'networkInterfaces').mockReturnValue(mockInterfaces);

            const result = getIPv4();
            expect(result).toEqual(['192.168.1.100', '10.0.0.1', '10.0.0.5']);
        });
    });

    describe('Local Bootstrapper + Node discovery', () => {
        let bootstrapperIP = '127.0.0.1';
        let bootstapperPort;
        let bootstrapperInstance;

        const generateSwarm = ({ ipv4, port, keyPair }) => connectSwarm({
            bootstrap: {
                host: ipv4,
                port: port
            },
            keyPair: keyPair
        })

        const generateSwarmArmy = ({ ipv4, port, count = 2 }) => {
            return Array.from({ length: count }, () => {
                return generateSwarm({ ipv4, port });
            })
        }

        const destroySwarmAmry = async (swarms) => {
            for (const swarm of swarms) {
                await swarm.destroy();
            }
        }

        const killBootstapper = (bootstrapper) => {
            bootstrapper.bootstrapperNode.destroy();
            bootstrapper.persistentNode.destroy();
        }

        beforeEach(async () => {
            bootstapperPort = getRandomPort();
            bootstrapperInstance = await startBootstrapper({
                ipv4: bootstrapperIP,
                port: bootstapperPort
            });
        })

        afterEach(async () => {
            killBootstapper(bootstrapperInstance);
        })

        it('should establish connection between peers and send message', async () => {
            const topic = hex(hash('pearcore-local-test'));
            const swarms = generateSwarmArmy({
                ipv4: bootstrapperIP,
                port: bootstapperPort,
                count: 2
            })

            const testData = 'Hello world';
            let recievedData = null;

            const dataRecievedPromise = new Promise((resolve) => {
                swarms[1].on('connection', (socket, info) => {
                    socket.on('data', (rawBuffer) => {
                        recievedData = rawBuffer.toString();
                        resolve(recievedData);
                    })
                })
            });

            const connectionEstablishedPromise = new Promise((resolve) => {
                swarms[0].on('connection', (socket, info) => {
                    // wait for 100ms before sending socket data
                    // second node needs to be fully ready to handle data
                    setTimeout(() => {
                        socket.write(testData);
                    }, 100);
                    resolve();
                })
            });

            await joinSwarmTopic(swarms[0], topic, { server: true, client: false });
            await joinSwarmTopic(swarms[1], topic, { server: false, client: true });

            await Promise.all([
                dataRecievedPromise,
                connectionEstablishedPromise,
            ]);

            expect(recievedData.toString()).toEqual(testData);
            destroySwarmAmry(swarms);
        })

        it('should establish connection between peers with validated predefined keypairs', async () => {
            const topic = hex(hash('pearcore-local-test'));

            const firstSeed = generateRandomSecretKey();
            const firstKeyPair = await edKeyPairFromSeed(hexToUint8(firstSeed));
            const swarmOne = generateSwarm({
                ipv4: bootstrapperIP,
                port: bootstapperPort,
                keyPair: firstKeyPair
            })

            const secondSeed = generateRandomSecretKey();
            const secondKeyPair = await edKeyPairFromSeed(hexToUint8(secondSeed));
            const swarmtwo = generateSwarm({
                ipv4: bootstrapperIP,
                port: bootstapperPort,
                keyPair: secondKeyPair
            })

            const swarms = [ swarmOne, swarmtwo ];

            let secondNodeInfo;
            let firstNodeInfo;

            const secondConnection = new Promise((resolve) => {
                swarms[1].on('connection', (socket, info) => {
                    firstNodeInfo = hex(info.publicKey);
                    resolve();
                })
            });

            const firstConnection = new Promise((resolve) => {
                swarms[0].on('connection', (socket, info) => {
                    secondNodeInfo = hex(info.publicKey);
                    resolve();
                })
            });

            await joinSwarmTopic(swarms[0], topic, { server: true, client: false });
            await joinSwarmTopic(swarms[1], topic, { server: false, client: true });


            await Promise.all([
                firstConnection,
                secondConnection,
            ]);

            expect(firstNodeInfo).toEqual(hex(firstKeyPair.publicKey));
            expect(secondNodeInfo).toEqual(hex(secondKeyPair.publicKey));
            destroySwarmAmry(swarms);
        })
    })
})