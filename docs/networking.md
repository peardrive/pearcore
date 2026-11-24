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
- **Delivery** - `src/managers/files/components/delivery.ts` and `src/managers/throttle.manager.ts` coordinate outbound work.

<br>

## Protocol handlers

Every protocol type has its own handler file under `src/protocols/<family>/`, named after the protocol it serves (for example `files/content-request.handler.ts`). `src/protocols/map.ts` is the registry that binds message types to handlers.

Repeated preconditions are composed from `src/protocols/shared/guards.ts`:

- `notRelayed` - the author must be the connected peer.
- `subscribed` - the peer must be subscribed to the message topic.
- `validPayload` - runs a protocol payload validator.
- `canRead` / `canBroadcast` - permission checks against an explicitly resolved space.
- `verified` - async signature or membership checks.

Space topics are resolved by the handlers themselves through the local space queries before the guard stack runs.

Handlers stack guards in the order their protocol requires through `this.enforce(ctx, [...])`. The runner returns `{ result, reason }` without side effects, and the handler sends the rejection with `this.reject(ctx, reason)`.

<br>

## Related documentation

- [Spaces](/spaces)
- [Core Services](/core-services)
- [Messaging](/messages)
- [File Sharing](/files)
