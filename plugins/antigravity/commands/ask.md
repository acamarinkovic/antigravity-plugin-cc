---
description: Ask Google Antigravity what it thinks — read-only second opinion, using your saved or chosen model
argument-hint: "[--background] [--resume|--fresh] [--backend agy|gemini] [--model <id>] [--effort low|medium|high|xhigh|max] <question>"
allowed-tools: Bash(node:*)
---

Ask Antigravity a question and show its answer.

Raw request:
`$ARGUMENTS`

How to run it:
- Leading `--background`, `--resume`, `--fresh`, `--backend`, `--model`, `--effort` are options; everything after them is the question.
- Antigravity can read files in this repository but cannot see this conversation. If the question depends on context only this conversation has (an error message, a decision, which file), rewrite it into a self-contained question with the relevant paths and facts. Otherwise keep the user's wording.
- Start it with one Bash call with `timeout: 600000`. Put the options on the command line and the question in a quoted heredoc, copied as-is (no escaping needed; the shell does not expand anything inside it):

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/companion.mjs" task <options> --stdin <<'ANTIGRAVITY_PROMPT'
<question>
ANTIGRAVITY_PROMPT
```

- Do not pass `--write`; this command is read-only.
- If the user did not pass `--resume` or `--fresh` and the question is clearly a follow-up ("and what about…", "continue", "dig deeper"), add `--resume`.

Long runs:
- If the output says the job is still running, it has not failed: run the `Wait for it` command it prints with Bash (`timeout: 600000`) and repeat while it keeps saying still running. Present the final answer only.

Presenting the answer:
- Show the command output verbatim under the heading `## Antigravity`.
- Then add a short `## Claude` section only where you disagree, see a factual error, or have something important to add. Ground it in the code. If you agree, say so in one line.
- Do not start changing code because of the answer; ask the user first.
