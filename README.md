# Antigravity for Claude Code

Ask Google Antigravity what it thinks without leaving Claude Code. Get a second opinion, a structured code review, an adversarial review, or hand a whole task over, using whichever models your Antigravity account offers (for example Gemini 4 Argon, Gemini Flash or Claude models). Antigravity runs on your own sign-in, so no API key is needed and no extra API tokens are billed.

This is an unofficial community plugin. It is not affiliated with or endorsed by Google or Anthropic. It drives the `agy` CLI that ships with Antigravity, and can optionally use Gemini CLI as a second backend.

## Requirements

- Claude Code with plugin support
- Node.js 18 or newer
- Google Antigravity with its CLI `agy`, signed in once interactively (run `agy` and finish the Google sign-in)
- Optional: Gemini CLI (`npm install -g @google/gemini-cli`), signed in with "Login with Google" or an API key

## Install

```bash
claude plugin marketplace add acamarinkovic/antigravity-plugin-cc
claude plugin install antigravity@antigravity-cc
```

Then run `/antigravity:setup` in Claude Code. It reports whether `agy` and `gemini` are installed and signed in, and lists the models your account can use.

### Choose your default model and thinking level

Accounts differ, so nothing is hard-coded: until you choose, the plugin lets `agy` use your account's default model. To set a default for all projects:

```text
/antigravity:setup --choose                              # pick from your account's models interactively
/antigravity:setup --model gemini-4-argon --effort high  # or set it directly
/antigravity:setup --reset-defaults                      # back to agy's account default
```

`setup` checks the model against `agy models` before saving it. `--model` and `--effort` on a single command still override the saved default. Every answer ends with the model that actually ran.

## Commands

| Command | What it does |
|---|---|
| `/antigravity:ask <question>` | Read-only second opinion. Claude shows Antigravity's answer verbatim, then adds its own view only where it disagrees. |
| `/antigravity:review [focus]` | Reviews uncommitted changes, or the branch against its base when the tree is clean. Returns a verdict and findings sorted by severity, each with `file:line`. |
| `/antigravity:adversarial-review [focus]` | Same input, but Antigravity tries to break the change: auth, data loss, races, retries, null and empty inputs, migrations. |
| `/antigravity:rescue <task>` | Hands an investigation or a fix to Antigravity through a forwarding subagent. Antigravity may edit files by default; pass `--read-only` to prevent that. |
| `/antigravity:status [job] [--wait] [--all]` | Lists running and recent jobs, or shows one job in detail. |
| `/antigravity:result [job]` | Prints the stored answer of a finished job. |
| `/antigravity:cancel [job]` | Stops a running job. |
| `/antigravity:setup [--enable-review-gate\|--disable-review-gate]` | Checks the installation and sign-in, and turns the stop review gate on or off. |

Common options (they go before the question or focus text):

- `--background` runs detached; follow it with `status` and `result`.
- `--resume` continues the last Antigravity conversation of this Claude session; `--fresh` starts a new one.
- `--model <id>` picks a model for this command, as a family (`gemini-4-argon`) or a full id with a level (`gemini-4-argon-high`). `/antigravity:setup` lists what your account has.
- `--effort low|medium|high|xhigh|max` (agy only) sets reasoning effort and overrides the effort suffix of the model id.
- `--backend agy|gemini` selects the CLI.
- For reviews: `--base <ref>` and `--scope auto|working-tree|branch`.

Examples:

```text
/antigravity:ask Is the retry logic in src/payments/retry.ts safe against duplicate charges?
/antigravity:ask --resume And what would you change first?
/antigravity:review --background
/antigravity:adversarial-review --base main tenant isolation
/antigravity:rescue --model gemini-4-argon-high the flaky test in tests/api.test.ts, find the cause and fix it
```

## What Antigravity can and cannot do

| Mode | Reads repo files | Edits files | Runs shell commands |
|---|---|---|---|
| ask, review, adversarial-review, stop gate | yes | no (agy `--mode plan --sandbox`, gemini `--approval-mode plan`) | no |
| rescue (default) | yes | yes (agy `--mode accept-edits`, gemini `--approval-mode auto_edit`) | no |

Headless `agy` cannot ask for permission, so any shell command it tries is denied automatically, and the denial ends its turn. The plugin therefore tells Antigravity up front that commands are unavailable. If a turn still ends empty because of a blocked command, the plugin resumes the same conversation once and asks for the answer without commands. The answer lists what was blocked. To allow specific commands, add allow-rules such as `command(npm test)` under `permissions.allow` in `~/.gemini/antigravity-cli/settings.json`. This plugin never passes `--dangerously-skip-permissions`, `--yolo` or `--skip-trust`. Gemini CLI keeps its folder-trust check, so it does not load a repository's own `.gemini/settings.json` (MCP servers, hooks) until you trust that folder in Gemini CLI yourself.

User text (questions, review focus) is handed to the script through a quoted heredoc or stdin, never interpolated into a shell command line.

Antigravity does not see the Claude conversation, only the repository. `/antigravity:ask` and `/antigravity:rescue` tell Claude to turn the request into a self-contained one. Reviews send the diff itself. Prompts over 100 KB are written to a file under the plugin data directory, and Antigravity reads that file through `--add-dir`.

## Stop review gate

`/antigravity:setup --enable-review-gate` turns the gate on for the current repository. From then on, whenever Claude ends a turn with uncommitted changes, Antigravity reviews them read-only, which takes about a minute. If it answers `BLOCK`, Claude is told to keep working on the reported issue.

The gate runs once per stop: the follow-up stop after a block is allowed through, to avoid loops. If Antigravity is unavailable or gives no verdict, the stop is allowed and a warning is shown.

## Configuration

| Environment variable | Default | Meaning |
|---|---|---|
| `ANTIGRAVITY_COMPANION_BACKEND` | `agy` | Default backend |
| `ANTIGRAVITY_COMPANION_MODEL`, `ANTIGRAVITY_COMPANION_EFFORT` | saved setup default, else agy's account default | Override the default agy model / thinking level |
| `ANTIGRAVITY_COMPANION_GEMINI_MODEL` | Gemini CLI default | Default Gemini CLI model |
| `ANTIGRAVITY_AGY_BIN`, `ANTIGRAVITY_GEMINI_BIN` | `agy`, `gemini` | Binary paths |
| `ANTIGRAVITY_COMPANION_WAIT_MS` | `540000` | How long a foreground command or `status --wait` waits before handing back (capped at 570000, below the 10-minute Bash limit) |
| `ANTIGRAVITY_COMPANION_DATA` | set by the SessionStart hook | State directory; the plugin never reads or exports the shared `CLAUDE_PLUGIN_DATA` outside its own hooks, so it cannot collide with other plugins |

Job state is stored per repository under the plugin data directory (`$ANTIGRAVITY_COMPANION_DATA/state`, by default `<Claude config dir>/plugins/data/antigravity-antigravity-cc/state`), readable only by your user. The last 50 jobs are kept.

## Limitations

- Each call starts a fresh `agy` process, which takes roughly 40–90 seconds. Use `--background` for anything large.
- Every run is a detached job with a 60-minute limit (`--timeout 2h` changes it). A foreground command waits up to 9 minutes, because Claude Code's Bash tool allows at most 10 per call. If Antigravity is still working by then, nothing is lost: the job keeps running and Claude keeps waiting with `status <job> --wait` until it finishes. Interrupting the command (Esc) cancels the job.
- Gemini CLI has no structured-output flag, so its reviews are parsed from JSON in the reply. If parsing fails, the raw text is shown.
- Gemini CLI's `gateway` sign-in cannot be used headless. `/antigravity:setup` says so and explains how to switch.
- Antigravity cannot import a Claude transcript, so there is no command to move a Claude session into Antigravity.
- Jobs and `--resume` are scoped to the Claude session through a SessionStart hook. If the plugin was installed in the middle of a session, run `/reload-plugins` or start a new session; until then, job lists and `--resume` cover the whole repository.

## Development

```bash
npm test
```

The tests use fake `agy` and `gemini` binaries from `tests/bin`. They never call a real model.

## License

MIT
