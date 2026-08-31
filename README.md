<h1 align="center">PearCore</h1>

<p align="center">
  <a href="https://github.com/peardrive/Pearcore">
    <img src="https://img.shields.io/badge/version-0.2.1-blue" alt="version">
  </a>
  <a href="LICENSE">
    <img src="https://img.shields.io/badge/license-MIT-green" alt="license">
  </a>
  <a href="https://github.com/peardrive/Pearcore/pulls">
    <img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome">
  </a>
</p>

<p align="center">
  <strong>PearCore</strong> is a modular, peer‑to‑peer framework for building decentralized applications. It provides account management, encrypted spaces (topics), profile broadcasting, message routing, and multi‑source file download system. Built on top of <code>hyperdht</code> and <code>hyperswarm</code>, it enables secure, permissioned communication without central servers.
</p>

<br>

## 📦 Installation

Since PearCore is not yet published to npm, you can install it directly from Github:
```bash
npm install npm install git+https://github.com/peardrive/Pearcore.git
```

Or if you prefer to clone and build locally:
```bash
git clone https://github.com/peardrive/Pearcore.git
cd pearcore
npm install
```

<br>

## Quick Example
Here's a minimal setup to create an account, authenticate, and start using PearCore:
```javascript
import { createCore } from 'pearcore';

async function main() {
  // create fresh core instance
  const core = await createCore({
    rootPath: './data', // directory path to store account metadata
  });

  // create new account (publicKey + secretKey + internal database)
  await core.accounts.create('alice', 'securePassword123');

  // load the account
  await core.accounts.authenticate('alice', 'securePassword123');

  // create new space for peers to join
  const space = await core.space.create({ spaceName: 'ChatApp' });
  
  console.log('PearCore is running!');
  console.log(`use this sharelink to join space: ${space.sharelink}`);
}

main().catch(error => {
  console.error(`Setting up PearCore has failed: ${error}`)
});
```

For more practical examples checkout **[examples/](./docs/examples.md)** directory.

<br>

## Documentation

Full API documentation and advanced usage examples are located in the [`docs/`](./docs) folder:

- **[Core Services Overview](./docs/core-services.md)** – all services and low‑level managers
- **[P2P Networking Overview](./docs/networking.md)** - all topics related to p2p networking of pearcore
- **[Account Management](./docs/accounts.md)** – creation, authentication, logout
- **[Spaces (Channels)](./docs/spaces.md)** – create, join, leave, and discover spaces
- **[Profile Management](./docs/profiles.md)** – update, broadcast, and list profiles
- **[Messaging](./docs/messages.md)** – send, receive, and filter messages
- **[File Sharing](./docs/files.md)** – upload, download, and monitor file transfers