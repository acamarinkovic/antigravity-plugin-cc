---
description: Check Antigravity (agy) and Gemini CLI, pick the default model and thinking level for all projects, toggle the stop review gate
argument-hint: "[--choose] [--model <id>] [--effort low|medium|high|xhigh|max] [--reset-defaults] [--enable-review-gate|--disable-review-gate]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Raw arguments:
`$ARGUMENTS`

If the arguments contain `--choose`, or the user asks to pick or change the model or thinking level without naming them:
1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json` and read `agy.families` (each has `model`, `name`, `efforts`) and the current `defaultModel` / `defaultEffort`.
2. Ask once with `AskUserQuestion`, two questions:
   - Model: 2 to 4 options from `agy.families`, using `name` as the label and `model` as the description; put the current default first with `(Current)`, otherwise the most capable-looking family first. If the account has only one family, add `Account default` (no saved model) as the second option. The user can type any other family through "Other".
   - Thinking level: only the levels in the chosen family's `efforts` (agy rejects any other level). Ask this as a second step after the model is known; skip it when the family has fewer than two levels.
3. Save with `setup --model <model> --effort <level>` (omit `--effort` when no level was asked), or `setup --reset-defaults` for `Account default`, and show the result.

Otherwise run, passing the other options through unchanged:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --args-stdin <<'ANTIGRAVITY_ARGS'
$ARGUMENTS
ANTIGRAVITY_ARGS
```

Present the output. Keep every sign-in instruction exactly as printed, because the user must run those themselves.
Saved model and thinking level apply to every project for this user; `--model` / `--effort` on a single command still override them.
If the stop review gate was just enabled, add one line: whenever Claude finishes a turn with uncommitted changes, Antigravity reviews them (about a minute) and can ask Claude to keep fixing; it runs only once per stop.
