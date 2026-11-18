---
title: Core Services
description: Overview of PearCore services and the managers that coordinate networking, sessions, messaging, and file delivery.
---

# Core Services

PearCore is organized around a small set of public services backed by lower-level managers and protocols.

::: info In progress
This page is being expanded. The source tree is the best reference for now.
:::

<br>

## Service layers

- **Services** - `src/services/` exposes the public API for accounts, spaces, profiles, messages, and drives.
- **Managers** - `src/managers/` coordinates sessions, connections, multiplexing, messaging, file delivery, and negentropy sync.
- **Protocols** - `src/protocols/` defines the wire-level messages exchanged between peers.
- **Database** - `src/database/` contains the Drizzle schemas and local persistence layer.
- **Utils** - `src/utils/` contains shared parsing, crypto, networking, and file helpers.

<br>

## Entry point

The public API is assembled in `src/core.ts` and exposed through the `createCore()` factory.

<br>

## Related documentation

- [Accounts](/accounts)
- [Spaces](/spaces)
- [Networking](/networking)
- [Messaging](/messages)
- [File Sharing](/files)
