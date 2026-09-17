# Accounts
Accounts in PearCore are your idenitity on the network. Think of them as your digital passport that proves who you are, and enables you to create and manage spaces. Every account is tighed to a cryptography keypair that ensures only you can control spaces and content.

When you create and account, PearCore generates a secure keypair for you. The `publicKey` becomes you network identity, while the `secretKey` which is kept encrypted locally with your password, allowes you to sign messages and prove ownership of your spaces. This means your credentials are entirely local and only managed by you.

Each account required both a **username** and **password**, and PearCore requires to authenticate the account to local the credentials internally during runtime. Here is an example:

```javascript
import { createCore } from 'pearcore';

const core = await createCore({
    root: '/temp/'
});

// Creating your first account
const account await core.accounts.create('alice', 'securePassword123');
console.log(`Created new account at ${account.path}`);

// Authenticating for your session
await core.accounts.authenticate('alice', 'securePassword123');

// You're now ready to create spaces!
const space = await core.space.create({ spaceName: 'MyChat' });
```

Explanation:
- `core.accounts.create()` - generates new account locally with randomly generated credentials. you can find the account directly within the root path which in this example is `/temp/`.

- `core.accounts.authenticate()` - attempts to decrypt the account against the password and when succeed, this method will load the account credentials and database into PearCore, enabling the used to interact with the network.

**Note**: The `authenticate()` method immediately attempts to reach the network and starts to communicate with the rest of the peers. This means PearCore will internally starts to handshake with the rest of the network.

## Account Recovery
What happens if you lose access to your device? PearCore provides a recovery mechanism using **BIP39 mnemonic phrases** which introduces 12 words that can regenerate your keypair. This is your backup plan, and it's crucial to store these words safely.

When you create an account, the mnemonic is generated automatically. You can use it to recover you identity on any new device.

```javascript
const account = await core.accounts.create("original", "somePassword");
console.log(`Mnemonics: ${account.mnemonic}`);

const backup = await core.accounts.recover("backupAccount", "pass123", account.mnemonics);
```

>>> **Warning:** Anyone with your mnemonics can recover your idenitity and access your spaces. Keep it safe and never share it digitally.

## State Management

Account authentication is session-based. Once authenticated, PearCore maintains your session until you explicitly logout

Here's how to check your current state:
```javascript
const state = core.accounts.getCurrentState();

if (state.state === 'authenticated') {
    console.log(`Logged in as: ${state.username}`);
    console.log(`Public Key: ${state.publicKey}`);
} else {
    console.log('Please log in first');
}
```

All operations within PearCore are disabled and will throw error if you intend to interact with network without an authenticated account.

## Account Operations
You can manage multiple accounts on a single device. Each account maintains its own independent identity, spaces, and data:

```javascript
const accounts = await core.accounts.list();

console.log(`You have ${accounts.length} accounts configured`);

// if you every want to delete an accounts
await core.accounts.delete('username');
```

When you're done, proper logout ensures your session is cleanly terminated, this also ensure that the network would know your absence.

```javascript
await core.accounts.logout();
```

This operation:
1. Disconnects from the P2P network
2. Closes all database connections
3. Clears session credentials from memory
4. Stops all space file management processes

For applications that require multiple identities, you can create separate accounts for different purposes - work, personal, or project-specific - and switch between them seamlessly.