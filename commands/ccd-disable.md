---
description: Disarm Cyber Delegation for this project
---

# /ccd-disable

Disarms the plugin for the current project by removing `.ccd/enabled`. Both
hooks go back to doing no work on every subagent stop and start. Existing
ledger evidence and run history are left untouched.

Run this command and report its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" disable
```
