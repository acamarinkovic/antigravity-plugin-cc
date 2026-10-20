---
description: Google Antigravity reviews the current changes (working tree, or branch vs base) and returns structured findings
argument-hint: "[--background|--wait] [--base <ref>] [--scope auto|working-tree|branch] [--backend agy|gemini] [--model <id>] [--effort <level>] [focus]"
disable-model-invocation: true
allowed-tools: Read, Glob, Grep, Bash(node:*), Bash(git:*), AskUserQuestion
---

Run an Antigravity code review. This command is review-only: do not fix anything and do not announce fixes.

Raw arguments:
`$ARGUMENTS`

Execution mode:
- `--wait` → foreground. `--background` → background. Otherwise size the change first with `git status --short --untracked-files=all` and `git diff --shortstat HEAD` (or `git diff --shortstat <base>...HEAD` with `--base`). If it is roughly 1–3 files, run in the foreground without asking. Otherwise ask once with `AskUserQuestion`: `Run in background (Recommended)` / `Wait for results`.

Start it with one Bash call with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" review --args-stdin <--background or --wait> <<'ANTIGRAVITY_ARGS'
$ARGUMENTS
ANTIGRAVITY_ARGS
```

Copy the raw arguments into the quoted heredoc exactly as given, even when empty; never put them on the command line. Pass `--background` after `--args-stdin` when running in the background, otherwise `--wait`; the script detaches its own worker, so do not use `run_in_background`.

Long runs:
- If the output says the job is still running, it has not failed: run the `Wait for it` command it prints with Bash (`timeout: 600000`) and repeat while it keeps saying still running. Present the final answer only.

Output:
- Return the command stdout verbatim.
- Then, for each finding, add one line marking it `agreed` or `disputed` with a short reason taken from the actual code (read the cited lines first).
- Stop there and ask the user which findings, if any, they want fixed.
