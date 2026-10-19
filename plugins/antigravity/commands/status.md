---
description: Show running and recent Antigravity jobs for this repository
argument-hint: "[job-id] [--wait] [--timeout-ms <ms>] [--all]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" status "$ARGUMENTS"`

Without a job id: present the output as-is (it is already a compact table). With a job id: present the full output without condensing it.
