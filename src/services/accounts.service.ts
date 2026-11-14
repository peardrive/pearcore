import { isDefined, isString } from '../utils/general.utils.js';
import { loadAccountDatabase } from '../database/database.js';
import {
  listAccountsWithMeta,
  createAccount,
  authenticateAccount,
  deleteAccount,
  createAccountFromMnemonic,
} from '../utils/accounts.utils.js';

export class AccountService {
  [key: string]: any;

  constructor(emitter: any, { managers, root }: any) {
    this.managers = managers;
    this.root = root;
  }

  static STATES = {
    AUTHENTICATED: 'authenticated',
    LOGIN_REQUIRED: 'login required',
  };

  /**
   * Lists all accounts under the given root directory.
   * @returns Array of accounts with metadata
   */
  async list() {
    return await listAccountsWithMeta(this.root);
  }

  /**
   * Creates a new account with the given username and password.
   * Additionally initializes the user's Spacebook database.
   * @param username - Username for the new account
   * @param password - Password for the new account
   * @returns Account metadata
   */
  async create(username: string, password: string) {
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

  async delete(username: string) {
    if (!isString(username)) {
      throw new Error('Invalid username parameter');
    }

    await deleteAccount(username, this.root);
  }

  /**
   * Recover credentials using mnemonic recovery phrases
   * @param username - local account's username
   * @param password - local account's password
   * @param mnemonic - 12 or 24-word BIP39 mnemonic phrases
   * @returns Account path and public key.
   */
  async recover(username: string, password: string, mnemonic: string) {
    const account = await createAccountFromMnemonic(
      username,
      password,
      mnemonic,
      this.root,
    );

    return {
      path: account.path,
      publicKey: account.publicKey,
    };
  }

  /**
   * Authenticates a user with username and password.
   * Loads the Spacebook database and initiates the user's discovery node.
   * @param username - Username to authenticate
   * @param password - Password to authenticate
   * @returns Object containing username, publicKey, and secretKey
   */
  async authenticate(username: string, password: string) {
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
      secretKey: creds.secretKey,
    });

    this.managers.session.setAccount({
      username: creds.username,
      directory: this.root,
    });
    this.managers.session.setDatabase({ db, sqlite });

    // loads the p2p discovery for the account
    await this.managers.connection.init();
    // load space file management
    await this.managers.spaceFiles.init();
    // load file-content delivery managerment
    await this.managers.delivery.init();
    // load message-history reconciliation
    await this.managers.sync.init();

    return {
      username: creds.username,
      publicKey: creds.publicKey,
      secretKey: creds.secretKey,
    };
  }

  /**
   * Logs out the current user and clears the session.
   * @returns True if logout succeeds
   */
  async logout() {
    await this.managers.connection.destroy();
    await this.managers.spaceFiles.stop();
    await this.managers.delivery.stop();
    await this.managers.sync.stop();

    const { sqlite } = this.managers.session.getDatabase();
    sqlite.close();

    this.managers.session.reset();
    this.managers.throttle.clear();
    this.managers.spaceFileList.clear();
  }

  /**
   * Indicates whether the user is logged in and credentials are valid.
   * @returns State object with username, publicKey and authentication state.
   */
  getCurrentState() {
    const { db, sqlite } = this.managers.session.getDatabase();
    const { publicKey, secretKey } = this.managers.session.getCredentials();
    const { username } = this.managers.session.getAccount();

    if (
      isDefined(db) &&
      isDefined(sqlite) &&
      isDefined(publicKey) &&
      isDefined(secretKey)
    ) {
      return {
        publicKey: publicKey,
        username: username,
        state: AccountService.STATES.AUTHENTICATED,
      };
    } else {
      return {
        state: AccountService.STATES.LOGIN_REQUIRED,
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
