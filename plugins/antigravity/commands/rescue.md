---
description: Delegate an investigation or a fix to Google Antigravity through the rescue subagent
argument-hint: "[--background|--wait] [--resume|--fresh] [--read-only] [--backend agy|gemini] [--model <id>] [--effort <level>] [--permission auto|accept-edits|dangerous] [--add-dir <path>] [task]"
allowed-tools: Bash(node:*), AskUserQuestion, Agent
---

Invoke the `antigravity:antigravity-rescue` subagent with the `Agent` tool (`subagent_type: "antigravity:antigravity-rescue"`), forwarding the raw user request as the prompt.
It is a subagent, not a skill: do not call `Skill(antigravity:antigravity-rescue)` or `Skill(antigravity:rescue)`; the second one re-enters this command.

Raw request:
$ARGUMENTS

Execution mode:
- `--background`: run the subagent in the background. `--wait` or neither: foreground. Do not forward these two flags.
- If the request has neither `--resume` nor `--fresh`, first run:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" resume-candidate --json
```

  Add `--backend <name>` to that call when the request contains it.

- If it reports `"available": true`, ask once with `AskUserQuestion` whether to `Continue current Antigravity conversation` or `Start a new Antigravity conversation`. Put Continue first with `(Recommended)` when the request reads like a follow-up ("continue", "keep going", "apply the fix", "dig deeper"); otherwise put Start first with `(Recommended)`. Add `--resume` or `--fresh` accordingly.
- If it reports `"available": false`, do not ask.

The final user-visible response is the subagent's output verbatim. After it, if Antigravity edited files, list the changed files from `git status --short` and offer to review them; do not revert or change them yourself unasked.
