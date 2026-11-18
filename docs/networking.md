---
title: Networking
description: Peer discovery, connections, and topic-based routing in PearCore.
---

# Networking

PearCore uses `hyperdht` and `hyperswarm` for peer discovery and direct connections. Spaces map to topics, and connected peers exchange protocol messages over multiplexed sockets.

::: info In progress
This page is being expanded. The source tree is the best reference for now.
:::

<br>

## Layers

- **Discovery** - `src/managers/connection.manager.ts` joins space topics and discovers peers.
- **Sessions** - `src/managers/session.manager.ts` tracks peer sessions and authentication state.
- **Multiplexing** - `src/managers/multiplexer.manager.ts` manages protocol streams over a connection.
- **Protocols** - `src/protocols/` defines the messages exchanged between peers.
- **Delivery** - `src/managers/delivery.manager.ts` and `src/managers/throttle.manager.ts` coordinate outbound work.

<br>

## Related documentation

- [Spaces](/spaces)
- [Core Services](/core-services)
- [Messaging](/messages)
- [File Sharing](/files)
