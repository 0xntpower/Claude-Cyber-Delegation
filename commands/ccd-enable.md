---
description: Arm Cyber Delegation for this project
---

# /ccd-enable

Arms the plugin for the current project by creating `.ccd/enabled`. The
setting is sticky: it survives across sessions until `/ccd-disable` removes
it. Both hooks stay inert until this has been run.

Run this command and report its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" enable
```
