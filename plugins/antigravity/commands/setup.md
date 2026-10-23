---
description: Check or install the Antigravity CLI (agy), pick the default model and thinking level for all projects, toggle the stop review gate
argument-hint: "[--install-agy] [--choose] [--model <id>] [--effort low|medium|high|xhigh|max] [--reset-defaults] [--permission auto|accept-edits|dangerous] [--enable-review-gate|--disable-review-gate]"
allowed-tools: Bash(node:*), AskUserQuestion
---

Raw arguments:
`$ARGUMENTS`

Every Bash call below uses `timeout: 600000`.

First run `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --json`. If `agy.installed` is false:
- Always ask once with `AskUserQuestion` before installing, even when the arguments contain `--install-agy`: `Install Antigravity CLI (Recommended)` (description: runs Google's official installer, `agy.installCommand`) / `Skip for now`. Never install without that answer.
- On install, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" setup --install-agy` and present its output. Then tell the user to run `agy` once in a terminal to sign in with Google, and to rerun `/antigravity:setup` afterwards.
- On skip, present the normal setup output.
Never pass `--install-agy` in any other case.

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
Saved model, thinking level and write permission apply to every project for this user; `--model` / `--effort` / `--permission` on a single command still override them.
If `--permission dangerous` was just saved, add one line: write tasks now run agy with `--dangerously-skip-permissions`, so Antigravity edits files and runs commands without asking; read-only commands are unchanged.
If the stop review gate was just enabled, add one line: whenever Claude finishes a turn with uncommitted changes, Antigravity reviews them (about a minute) and can ask Claude to keep fixing; it runs only once per stop.
