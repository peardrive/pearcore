---
title: Messaging
description: Send, receive, and synchronize messages across PearCore spaces.
---

# Messaging

PearCore routes messages between peers that share a space and have the required read or broadcast permissions. Message history is reconciled between peers with the negentropy manager.

::: info In progress
The messaging API reference is being expanded. In the meantime, start from the source:
:::

- `src/services/message.service.ts` - public messaging operations
- `src/managers/message.manager.ts` - message routing and delivery
- `src/managers/negentropy/` - history synchronization
- `src/protocols/message.protocol.ts` - peer-to-peer message protocol
- `src/constants/messages.constants.ts` - message constants

<br>

## Related documentation

- [Core Services](/core-services)
- [Spaces](/spaces)
- [Networking](/networking)
