---
'pearcore': patch
---

Split protocol handlers into one file per protocol and compose their shared preconditions from guards. Space topics are resolved through a replaceable `SpaceResolver` port, and guard stacks now return an explicit outcome so handlers own rejection.
