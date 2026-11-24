---
'pearcore': patch
---

Drain in-flight local file watcher handlers before shutdown so asynchronous change and delete handlers cannot query a closed database or surface as unhandled rejections during teardown.
