import * as messageConstants from '../constants/messages.constants.js';
import * as eventConstants from '../constants/events.constants.js';

export class SessionManager {
    constructor(defaultSession) {
        this.STATIC_SESSION = defaultSession || {
            account: {
                username: undefined,
                directory: undefined, // account's file directory
            },

            // these parameter will be updated after successful account login (accountService.authenticate())
            credentials: {
                publicKey: undefined,
                secretKey: undefined
            },

            // these parameter will be updated after successful account login (accountService.authenticate())
            database: {
                db: undefined,
                sqlite: undefined,
            },

            // optional parameter to use custom DHT node for peer discovery
            // format (IPv4:Port) - example: 192.168.100.23:8000
            bootstrap: undefined,

            connection: {
                // early handshake with the connected peer for space hash list and profile update.
                // if false, the connection would have limited functinality without additional manual handshake
                enableHandshake: true
            },

            // all static variables related to p2p messaging
            messaging: {
                rawLimitSize: messageConstants.MAX_MESSAGE_SIZE,
                frequencyThrottle: messageConstants.MAX_FREQUENCY_THROTTLE,
                maxQuarantineTime: messageConstants.MAX_QUARANTINE_TIME, // replace with 1000000
                allowThrottleRejection: messageConstants.ALLOW_THROTTLE_REJECTIONS,

                // limit the number of messages that are stored per event type to prevent
                // excessive disk consumption and maintain system performance. 
                recordMessagesForEvents: [
                    eventConstants.SpaceMessage
                ]
            },

            files: {
                broadcastThrottleTime: 1000, // 1-second
                // minimum required leaf count for advertising file availability
                minLeafCountForAdvertisement: 10,
                treeRequestInterval: 10000, // 10 seconds
            }
        }

        this.session = this.STATIC_SESSION;
        this._createProxyInterface();
    }

    reset() {
        this.session = this.STATIC_SESSION;
    }

    setBootstrapperEndpoint(bootstrapper) {
        this.session.set('bootstrap', bootstrapper);
    }

    getBootstrapperEndpoint() {
        return this.session.get('bootstrap');
    }

    setDatabase({ db, sqlite }) {
        this.session.set('database.db', db);
        this.session.set('database.sqlite', sqlite);
    }

    getDatabase() {
        return {
            db: this.session.get('database.db'),
            sqlite: this.session.get('database.sqlite')
        };
    }

    getCredentials() {
        return {
            publicKey: this.session.get('credentials.publicKey'),
            secretKey: this.session.get('credentials.secretKey'),
        };
    }

    setCredentials({ publicKey, secretKey }) {
        this.session.set('credentials.publicKey', publicKey);
        this.session.set('credentials.secretKey', secretKey);
    }

    getAccount() {
        return this.session.get('account');
    }

    setAccount(params) {
        const setting = this.session.get('account');
        this.session.set('account', { ...setting, ...params });
    }

    getConnectionConfig() {
        return { ...this.session.connection };
    }

    getMessageConfig() {
        return { ...this.session.messaging };
    }

    setMessageConfig(params) {
        const config = this.getMessageConfig();
        this.session.set('messaging', {...config, ...params});
    }

    _createProxyInterface() {
        const sessionProxy = new Proxy(this.session, {
            get: (target, prop) => {
                if (prop === 'get') return this._getProperty.bind(this);
                if (prop === 'set') return this._setProperty.bind(this);
                if (prop === 'update') return this._updateSection.bind(this);
                return target[prop];
            }
        });

        this.session = sessionProxy;
    }

    _getProperty(path) {
        const keys = path.split('.');
        let current = this.session;

        for (let i = 0; i < keys.length - 1; i++) {
            if (!current[keys[i]]) return undefined;
            current = current[keys[i]];
        }

        return current[keys[keys.length - 1]];
    }

    _setProperty(path, value) {
        const keys = path.split('.');
        let current = this.session;

        for (let i = 0; i < keys.length - 1; i++) {
            if (!current[keys[i]]) {
                current[keys[i]] = {};
            }
            current = current[keys[i]];
        }

        current[keys[keys.length - 1]] = value;
    }

    _updateSection(section, updates) {
        if (this.session[section]) {
            Object.assign(this.session[section], updates);
        } else {
            this.session[section] = updates;
        }
    }
}