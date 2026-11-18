---
title: File Sharing
description: Upload, download, and monitor file transfers across PearCore spaces.
---

# File Sharing

PearCore's file layer is built around content-addressed trees, provider discovery, chunk scheduling, and resumable downloads.

::: info In progress
The file sharing API reference is being expanded. In the meantime, start from the source:
:::

- `src/services/drive/drive.service.ts` - public drive and file operations
- `src/managers/files/files.manager.ts` - file transfer orchestration
- `src/managers/files/components/` - downloads, providers, scheduling, progress, and local storage
- `src/protocols/files.protocol.ts` - peer-to-peer file protocol

<br>

## Related documentation

- [Core Services](/core-services)
- [Spaces](/spaces)
- [Networking](/networking)
