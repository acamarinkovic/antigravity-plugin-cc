---
description: Show the stored answer of a finished Antigravity job
argument-hint: "[job-id]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" result "$ARGUMENTS"`

Present the output verbatim. Do not summarize it. If it is a review, do not fix anything unless the user asks.
