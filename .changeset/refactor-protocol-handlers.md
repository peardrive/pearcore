---
'pearcore': patch
---

Split protocol handlers into one file per protocol and compose their shared preconditions from guards. File and message handlers now reject peers that are not subscribed to the message topic.
