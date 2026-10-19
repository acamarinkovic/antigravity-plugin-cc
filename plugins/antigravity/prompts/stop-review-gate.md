<task>
Claude Code is about to end its turn. Decide whether the code changes it made in that turn are safe to stop on.
Only judge the edits made in the turn described below. If that turn only reported status, answered a question, ran a setup or review command, or made no code edits, answer ALLOW immediately.
If the turn did edit code, check the current uncommitted diff below for bugs that must be fixed before stopping: wrong behavior, crashes, missing edge cases, broken tests, security issues.
Do not block on style or on edits from earlier turns.
You cannot run commands (no git, no tests): the complete diff is below, and you may read repository files.

Claude's final message for the turn:
{{CLAUDE_MESSAGE}}
</task>

<output>
Your first line must be exactly one of:
ALLOW: <short reason>
BLOCK: <short reason naming the file and the problem>
Nothing may come before that line.
</output>

<change>
{{INPUT}}
</change>
