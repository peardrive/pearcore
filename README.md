# PearCore

[![version](https://img.shields.io/badge/version-1.0.0-blue)](https://github.com/peardrive/Pearcore)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](https://github.com/peardrive/Pearcore/pulls)

**PearCore** is a modular, peer‑to‑peer framework for building decentralized applications. It provides account management, encrypted spaces (topics), profile broadcasting, message routing, and multi‑source file download system. Built on top of `hyperdht` and `hyperswarm`, it enables secure, permissioned communication without central servers.

<br>

## 📦 Installation

Since PearCore is not yet published to npm, you can install it directly from Github:
```bash
npm install git+https://github.com/your-org/pearcore.git
```

Or if you prefer to clone and build locally:
```bash
git clone https://github.com/your-org/pearcore.git
cd pearcore
npm install
```

<br>

## Quick Example
Here's a minimal setup to create an account, authenticate, and start using PearCore:
```javascript
import { createCore } from 'pearcore';

const core = await createCore({
  rootPath: './data',          // where accounts and databases are stored
});

// Create a new account
await core.accounts.create('alice', 'securePassword123');

// Authenticate (load account and start P2P node)
await core.accounts.authenticate('alice', 'securePassword123');

// Now you're ready to use spaces, messages, files, etc.
console.log('PearCore is ready!');
```

For more practical examples checkout **[examples/](./docs/examples)** directory.

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

For a quick reference of the main services, see the table below.
