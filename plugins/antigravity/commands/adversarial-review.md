---
description: Google Antigravity tries to break confidence in the current changes (adversarial, structured findings)
argument-hint: "[--background|--wait] [--base <ref>] [--scope auto|working-tree|branch] [--backend agy|gemini] [--model <id>] [--effort <level>] [focus]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an adversarial Antigravity review: it looks for the strongest reasons the change should not ship (auth, data loss, races, retries, null/empty inputs, migrations). Free text after the options is the focus. Review-only: do not fix anything.

Raw arguments:
`$ARGUMENTS`

Execution mode:
- `--wait` → foreground. `--background` → background. Otherwise size the change with `git status --short --untracked-files=all` and `git diff --shortstat HEAD`; 1–3 files run in the foreground without asking, larger changes ask once with `AskUserQuestion`: `Run in background (Recommended)` / `Wait for results`.

Start it with one Bash call with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" adversarial-review --args-stdin <--background or --wait> <<'ANTIGRAVITY_ARGS'
$ARGUMENTS
ANTIGRAVITY_ARGS
```

Copy the raw arguments into the quoted heredoc exactly as given, even when empty; never put them on the command line. Pass `--background` after `--args-stdin` when running in the background, otherwise `--wait`; do not use `run_in_background`.

Long runs:
- If the output says the job is still running, it has not failed: run the `Wait for it` command it prints with Bash (`timeout: 600000`) and repeat while it keeps saying still running. Present the final answer only.

Output:
- Return the command stdout verbatim.
- Then mark each finding `agreed` or `disputed` with a short reason from the actual code (read the cited lines first).
- Stop and ask the user which findings to fix.
