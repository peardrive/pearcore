---
title: Quick Start
description: Create a PearCore account, authenticate, and create your first peer-to-peer space.
---

# Quick Start

Here is a minimal setup to create an account, authenticate, and start using PearCore:

```javascript
import { createCore } from 'pearcore';

async function main() {
  // Create a fresh core instance.
  const core = await createCore({
    rootPath: './data', // Directory used to store account metadata.
  });

  // Create a new account (publicKey + secretKey + internal database).
  await core.accounts.create('alice', 'securePassword123');

  // Load the account for this session.
  await core.accounts.authenticate('alice', 'securePassword123');

  // Create a new space for peers to join.
  const space = await core.space.create({ spaceName: 'ChatApp' });

  console.log('PearCore is running!');
  console.log(`Use this sharelink to join the space: ${space.sharelink}`);
}

main().catch((error) => {
  console.error(`Setting up PearCore failed: ${error}`);
});
```

::: info More examples are coming
See [Accounts](/accounts) and [Spaces](/spaces) for detailed walkthroughs of the current API.
:::
