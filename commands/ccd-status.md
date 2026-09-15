---
description: Show whether Cyber Delegation is armed here and summarize the risk ledger
---

# /ccd-status

Reports whether the plugin is armed for this project, the ledger path and
whether it exists, the number of scored areas, the highest-scoring areas with
their evidence counts, any area the ledger reports as stale, and the
unattributed totals.

Run this command and report its output:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/gate.mjs" status
```
