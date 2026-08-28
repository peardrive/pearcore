import { isDefined, isString } from '../utils/general.utils.js';
import { loadAccountDatabase } from '../database/database.js';
import {
  listAccountsWithMeta,
  createAccount,
  authenticateAccount,
  deleteAccount,
} from '../utils/accounts.utils.js';


export class AccountService {
  constructor(emitter, { managers, root }) {
    this.managers = managers;
    this.root = root;
  }

  static STATES = {
    AUTHENTICATED: 'authenticated',
    LOGIN_REQUIRED: 'login required'
  }

  /**
   * Lists all accounts under the given root directory.
   * @returns {Promise<Array>} Array of accounts with metadata
   */
  async list() {
    return await listAccountsWithMeta(this.root);
  }

  /**
   * Creates a new account with the given username and password.
   * Additionally initializes the user's Spacebook database.
   * @param {string} username - Username for the new account
   * @param {string} password - Password for the new account
   * @returns {Promise<Object>} Account metadata
   */
  async create(username, password) {
    if (!isString(username)) {
      throw new Error('Invalid username parameter');
    }

    if (!isString(password)) {
      throw new Error('Invalid password parameter');
    }

    const account = await createAccount(username, password, this.root);
    const { sqlite } = await loadAccountDatabase(username, this.root);

    // close connection afte creation
    await sqlite.close();

    return account;
  }

  async delete(username) {
    if (!isString(username)) {
      throw new Error('Invalid username parameter');
    }

    await deleteAccount(username, this.root);
  }

  /**
   * Authenticates a user with username and password.
   * Loads the Spacebook database and initiates the user's discovery node.
   * @param {string} username - Username to authenticate
   * @param {string} password - Password to authenticate
   * @returns {Promise<Object>} Object containing username, publicKey, and secretKey
   */
  async authenticate(username, password) {
    if (!isString(username)) {
      throw new Error('Invalid username parameter');
    }

    if (!isString(password)) {
      throw new Error('Invalid password parameter');
    }

    const creds = await authenticateAccount(username, password, this.root);
    const { sqlite, db } = await loadAccountDatabase(username, this.root);

    this.managers.session.setCredentials({
      publicKey: creds.publicKey,
      secretKey: creds.secretKey
    });

    this.managers.session.setAccount({ username: creds.username, directory: this.root });
    this.managers.session.setDatabase({ db, sqlite });

    // loads the p2p discovery for the account
    await this.managers.connection.init();
    // setup message throttler memory
    await this.managers.throttle.load();
    // load space file management 
    await this.managers.spaceFiles.init();
    // load file-content delivery managerment
    await this.managers.delivery.init();

    return {
      username: creds.username,
      publicKey: creds.publicKey,
      secretKey: creds.secretKey
    };
  }

  /**
   * Logs out the current user and clears the session.
   * @returns {Promise<void>} True if logout succeeds
   */
  async logout() {
    await this.managers.connection.destroy();

    const { sqlite } = this.managers.session.getDatabase();
    sqlite.close();

    this.managers.session.reset();
    this.managers.throttle.clear();
    this.managers.spaceFileList.clear();
    await this.managers.spaceFiles.stop();
    await this.managers.delivery.stop();
  }

  /**
   * Indicates whether the user is logged in and credentials are valid.
   * @returns {Object} State object with username, publicKey and authentication state.
   */
  getCurrentState() {
    const { db, sqlite } = this.managers.session.getDatabase();
    const { publicKey, secretKey } = this.managers.session.getCredentials();
    const { username } = this.managers.session.getAccount();

    if (
      isDefined(db) && isDefined(sqlite) &&
      isDefined(publicKey) && isDefined(secretKey)
    ) {
      return {
        publicKey: publicKey,
        username: username,
        state: AccountService.STATES.AUTHENTICATED
      };
    }

    else {
      return {
        state: AccountService.STATES.LOGIN_REQUIRED
      };
    }
  }

  loginRequired() {
    const current = this.getCurrentState();
    if (current.state === AccountService.STATES.LOGIN_REQUIRED) {
      throw new Error('Login is required.');
    }
  }
}