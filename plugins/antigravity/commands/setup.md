---
description: Check that Antigravity (agy) and Gemini CLI are installed and signed in; toggle the stop review gate
argument-hint: "[--enable-review-gate|--disable-review-gate]"
allowed-tools: Bash(node:*)
---

Run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup "$ARGUMENTS"
```

Present the output. Keep every `! agy` / `! gemini` sign-in instruction exactly as printed, because the user must run those themselves.
If the stop review gate was just enabled, add one line: every time Claude finishes a turn with uncommitted changes, Antigravity reviews them (about a minute) and can ask Claude to keep fixing; it runs only once per stop.
