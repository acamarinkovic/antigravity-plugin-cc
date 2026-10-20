import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "plugins", "antigravity", "scripts", "companion.mjs");
const BIN = path.join(HERE, "bin");

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agc-test-"));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo);
  const g = (...a) => spawnSync("git", a, { cwd: repo, encoding: "utf8" });
  g("init", "-q");
  fs.writeFileSync(path.join(repo, "a.py"), "def avg(xs):\n    return sum(xs) / len(xs)\n");
  g("add", ".");
  g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  return { root, repo, log: path.join(root, "calls.jsonl"), data: path.join(root, "data") };
}

function run(box, args, extraEnv = {}, input = "") {
  const env = {
    ...process.env,
    ANTIGRAVITY_COMPANION_DATA: box.data,
    CLAUDE_PLUGIN_DATA: path.join(box.root, "some-other-plugin-data"),
    ANTIGRAVITY_AGY_BIN: path.join(BIN, "agy"),
    ANTIGRAVITY_GEMINI_BIN: path.join(BIN, "gemini"),
    ANTIGRAVITY_COMPANION_SESSION_ID: "session-A",
    FAKE_LOG: box.log,
    ...extraEnv
  };
  delete env.ANTIGRAVITY_COMPANION_MODEL;
  delete env.ANTIGRAVITY_COMPANION_BACKEND;
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: box.repo, env, input, encoding: "utf8" });
}

function calls(box) {
  return fs.existsSync(box.log) ? fs.readFileSync(box.log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
}

function flag(args, name) {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
}

function waitFor(predicate, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (predicate()) return true;
    spawnSync("sleep", ["0.2"]);
  }
  return false;
}

test("read-only question uses plan mode, sandbox and Gemini 4 Argon High by default", () => {
  const box = sandbox();
  const r = run(box, ["task", "--", "what is it?"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /answer to: what is it\?/);
  assert.match(r.stdout, /Antigravity · gemini-4-argon-high/);
  const [c] = calls(box);
  assert.equal(flag(c.args, "--mode"), "plan");
  assert.ok(c.args.includes("--sandbox"));
  assert.equal(flag(c.args, "--model"), "gemini-4-argon-high");
  assert.equal(flag(c.args, "--output-format"), "stream-json");
  assert.equal(flag(c.args, "--print-timeout"), "60m");
});

test("--write switches to accept-edits and --effort strips the model effort suffix", () => {
  const box = sandbox();
  const r = run(box, ["task", "--write", "--effort", "max", "--", "fix it"]);
  assert.equal(r.status, 0, r.stderr);
  const [c] = calls(box);
  assert.equal(flag(c.args, "--mode"), "accept-edits");
  assert.equal(flag(c.args, "--model"), "gemini-4-argon");
  assert.equal(flag(c.args, "--effort"), "max");
});

test("invalid effort is rejected before calling agy", () => {
  const box = sandbox();
  const r = run(box, ["task", "--effort", "ultra", "--", "x"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--effort must be one of/);
  assert.equal(calls(box).length, 0);
});

test("--resume continues the previous conversation of this session only", () => {
  const box = sandbox();
  const first = run(box, ["task", "--", "remember 42"]);
  const conv = first.stdout.match(/agy --conversation (\S+)/)[1];
  const other = run(box, ["task", "--resume", "--", "again"], { ANTIGRAVITY_COMPANION_SESSION_ID: "session-B" });
  assert.equal(other.status, 1);
  assert.match(other.stderr, /no earlier conversation/);
  const second = run(box, ["task", "--resume", "--", "what number?"]);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(flag(calls(box)[1].args, "--conversation"), conv);
  const cand = JSON.parse(run(box, ["resume-candidate", "--json"]).stdout);
  assert.equal(cand.available, true);
  assert.equal(cand.candidate.conversationId, conv);
});

test("review sends the working-tree diff with the schema and renders findings by severity", () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.repo, "a.py"), "def avg(xs):\n    return sum(xs) / (len(xs) - 1)\n");
  fs.writeFileSync(path.join(box.repo, "new.txt"), "hello\n");
  const r = run(box, ["review", "--scope auto"]);
  assert.equal(r.status, 0, r.stderr);
  const [c] = calls(box);
  const prompt = flag(c.args, "-p");
  assert.match(prompt, /len\(xs\) - 1/);
  assert.match(prompt, /\+\+\+ b\/new\.txt/);
  assert.match(flag(c.args, "--json-schema"), /review-output\.schema\.json$/);
  assert.equal(flag(c.args, "--mode"), "plan");
  assert.match(r.stdout, /Verdict: \*\*needs-attention\*\*/);
  assert.ok(r.stdout.indexOf("[critical]") < r.stdout.indexOf("[low]"));
  assert.match(r.stdout, /`a\.py:L2`/);
});

test("review on a clean tree with no default branch explains what to pass", () => {
  const box = sandbox();
  spawnSync("git", ["branch", "-m", "work"], { cwd: box.repo });
  const r = run(box, ["review", ""]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /--base/);
});

test("adversarial review passes focus text into the prompt", () => {
  const box = sandbox();
  fs.appendFileSync(path.join(box.repo, "a.py"), "x = 1\n");
  const r = run(box, ["adversarial-review", "--wait race conditions"]);
  assert.equal(r.status, 0, r.stderr);
  const prompt = flag(calls(box)[0].args, "-p");
  assert.match(prompt, /adversarial reviewer/);
  assert.match(prompt, /race conditions/);
  assert.match(r.stdout, /Antigravity Adversarial Review/);
});

test("prompts over the inline limit go through a file and --add-dir", () => {
  const box = sandbox();
  const big = "x".repeat(200 * 1024);
  const r = run(box, ["task", "--", big]);
  assert.equal(r.status, 0, r.stderr);
  const [c] = calls(box);
  const dir = flag(c.args, "--add-dir");
  assert.ok(dir && dir.startsWith(box.data));
  assert.match(flag(c.args, "-p"), /Read your complete instructions from/);
  const file = fs.readdirSync(dir).map((f) => path.join(dir, f))[0];
  assert.ok(fs.readFileSync(file, "utf8").endsWith(`\n\n${big}`));
});

test("agy errors fail with the agy message and exit 1", () => {
  const box = sandbox();
  const r = run(box, ["task", "--model", "nope", "--", "x"], { FAKE_MODE: "error" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /invalid model selection: nope/);
});

test("a print timeout is reported as partial, denied tools are listed", () => {
  const box = sandbox();
  const t = run(box, ["task", "--", "x"], { FAKE_MODE: "timeout" });
  assert.match(t.stdout, /print timeout before finishing/);
  const d = run(box, ["task", "--", "x"], { FAKE_MODE: "denied" });
  assert.match(d.stdout, /Blocked \(headless agy cannot ask for permission\): RunCommand/);
});

test("background job can be followed with status and result", () => {
  const box = sandbox();
  const r = run(box, ["task", "--background", "--", "slow one"], { FAKE_DELAY_MS: "800" });
  assert.equal(r.status, 0, r.stderr);
  const id = r.stdout.match(/background as (\S+)\./)[1];
  assert.match(run(box, ["status", ""]).stdout, new RegExp(`${id} .*\\| (queued|running|completed) `));
  assert.ok(waitFor(() => /completed/.test(run(box, ["status", id]).stdout)));
  const res = run(box, ["result", id]);
  assert.match(res.stdout, /answer to: slow one/);
  assert.equal(flag(calls(box)[0].args, "--print-timeout"), "60m");
});

test("cancel stops a running background job", () => {
  const box = sandbox();
  const r = run(box, ["task", "--background", "--", "never ends"], { FAKE_DELAY_MS: "30000" });
  const id = r.stdout.match(/background as (\S+)\./)[1];
  assert.ok(waitFor(() => /Status: running/.test(run(box, ["status", id]).stdout)));
  const c = run(box, ["cancel", ""]);
  assert.match(c.stdout, new RegExp(`Cancelled ${id}`));
  assert.match(run(box, ["status", id]).stdout, /Status: cancelled/);
  const job = JSON.parse(run(box, ["status", `${id} --json`]).stdout);
  assert.ok(waitFor(() => { try { process.kill(job.pid, 0); return false; } catch { return true; } }));
});

test("gemini backend sends the prompt on stdin in plan mode and parses a fenced review", () => {
  const box = sandbox();
  fs.appendFileSync(path.join(box.repo, "a.py"), "y = 2\n");
  const r = run(box, ["review", "--backend gemini"]);
  assert.equal(r.status, 0, r.stderr);
  const [c] = calls(box);
  assert.equal(c.bin, "gemini");
  assert.equal(flag(c.args, "--approval-mode"), "plan");
  assert.ok(!c.args.includes("--skip-trust"));
  assert.match(c.stdin, /y = 2/);
  assert.match(r.stdout, /Verdict: \*\*approve\*\*/);
  assert.match(r.stdout, /Gemini CLI · gemini-3.1-pro-preview/);
});

test("gemini auth failure explains how to sign in", () => {
  const box = sandbox();
  const r = run(box, ["task", "--backend", "gemini", "--", "x"], { FAKE_MODE: "auth" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /Invalid auth method selected/);
  assert.match(r.stdout, /Login with Google/);
  assert.doesNotMatch(r.stdout, /"session_id"/);
});

test("stop gate is silent when disabled and blocks on BLOCK when enabled", () => {
  const box = sandbox();
  fs.appendFileSync(path.join(box.repo, "a.py"), "z = 3\n");
  const hookInput = JSON.stringify({ session_id: "session-A", cwd: box.repo, last_assistant_message: "I edited a.py" });
  const hookEnv = { ANTIGRAVITY_COMPANION_DATA: "", CLAUDE_PLUGIN_DATA: box.data };
  const off = run(box, ["hook-stop"], hookEnv, hookInput);
  assert.equal(off.stdout, "");
  assert.equal(calls(box).length, 0);
  run(box, ["setup", "--enable-review-gate"]);
  const block = run(box, ["hook-stop"], { ...hookEnv, FAKE_RESPONSE: "BLOCK: a.py:3 z is unused" }, hookInput);
  assert.deepEqual(JSON.parse(block.stdout).decision, "block");
  assert.match(JSON.parse(block.stdout).reason, /z is unused/);
  const allow = run(box, ["hook-stop"], { ...hookEnv, FAKE_RESPONSE: "ALLOW: fine" }, hookInput);
  assert.equal(allow.stdout, "");
  const active = run(box, ["hook-stop"], { ...hookEnv, FAKE_RESPONSE: "BLOCK: x" }, JSON.stringify({ cwd: box.repo, stop_hook_active: true }));
  assert.equal(active.stdout, "");
});

test("agy file:// links are rewritten to readable file:line references", () => {
  const box = sandbox();
  const response = "Fixed [`add`](file:///tmp/x/calc.py#L1-L2) in [calc.py](file:///tmp/x/calc.py) and [test](file:///tmp/x/t%20a.py#L4).";
  const r = run(box, ["task", "--", "x"], { FAKE_RESPONSE: response });
  assert.match(r.stdout, /Fixed `add` \(`calc\.py:1-2`\) in `calc\.py` and test \(`t a\.py:4`\)\./);
});

test("session start hook exports the session id and its own data dir, never CLAUDE_PLUGIN_DATA", () => {
  const box = sandbox();
  const envFile = path.join(box.root, "env");
  const ours = path.join(box.root, "ours");
  run(box, ["hook-session-start"], { CLAUDE_ENV_FILE: envFile, CLAUDE_PLUGIN_DATA: ours, ANTIGRAVITY_COMPANION_DATA: "" }, JSON.stringify({ session_id: "abc'1" }));
  const text = fs.readFileSync(envFile, "utf8");
  assert.match(text, /export ANTIGRAVITY_COMPANION_SESSION_ID='abc'"'"'1'/);
  assert.ok(text.includes(`export ANTIGRAVITY_COMPANION_DATA='${ours}'`));
  assert.doesNotMatch(text, /export CLAUDE_PLUGIN_DATA=/);
});

test("commands ignore another plugin's CLAUDE_PLUGIN_DATA; hooks use their own", () => {
  const box = sandbox();
  const foreign = path.join(box.root, "some-other-plugin-data");
  run(box, ["task", "--", "x"]);
  assert.ok(!fs.existsSync(foreign));
  assert.ok(fs.existsSync(path.join(box.data, "state")));
  const hookData = path.join(box.root, "hook-data");
  fs.appendFileSync(path.join(box.repo, "a.py"), "q = 1\n");
  run(box, ["setup", "--enable-review-gate"], { ANTIGRAVITY_COMPANION_DATA: hookData });
  const r = run(box, ["hook-stop"], { ANTIGRAVITY_COMPANION_DATA: "", CLAUDE_PLUGIN_DATA: hookData, FAKE_RESPONSE: "BLOCK: q unused" }, JSON.stringify({ cwd: box.repo }));
  assert.equal(JSON.parse(r.stdout).decision, "block");
});

test("an empty answer caused by a blocked command is retried once in the same conversation", () => {
  const box = sandbox();
  const r = run(box, ["task", "--", "check it"], { FAKE_MODE: "denied-once", FAKE_RESPONSE: "final answer" });
  assert.equal(r.status, 0, r.stderr);
  const [first, second] = calls(box);
  assert.match(flag(second.args, "--conversation"), /^conv-/);
  assert.ok(!first.args.includes("--conversation"));
  assert.match(flag(second.args, "-p"), /Your last action was blocked/);
  assert.match(r.stdout, /final answer/);
  assert.match(r.stdout, /Blocked \(headless agy cannot ask for permission\): RunCommand/);
  assert.equal(calls(box).length, 2);
});

test("review arguments read from stdin keep shell metacharacters literal and keep user flags next to --background", () => {
  const box = sandbox();
  fs.appendFileSync(path.join(box.repo, "a.py"), "w = 4\n");
  const raw = "--scope working-tree --effort low check that `validateToken` and $(whoami) don't \"leak\"";
  const r = run(box, ["review", "--args-stdin", "--wait"], {}, raw);
  assert.equal(r.status, 0, r.stderr);
  const [c] = calls(box);
  assert.equal(flag(c.args, "--effort"), "low");
  const prompt = flag(c.args, "-p");
  assert.match(prompt, /`validateToken` and \$\(whoami\)/);
  assert.match(prompt, /w = 4/);
});

test("task --stdin takes the question from stdin verbatim", () => {
  const box = sandbox();
  const question = "What's wrong with `retry()`; doesn't it $(double) charge?";
  const r = run(box, ["task", "--stdin"], { FAKE_RESPONSE: "ok" }, question);
  assert.equal(r.status, 0, r.stderr);
  const sent = flag(calls(box)[0].args, "-p");
  assert.ok(sent.endsWith(`\n\n${question}`));
  assert.match(sent, /terminal commands are blocked/);
});

test("untracked files with unicode names are included in the review input", () => {
  const box = sandbox();
  fs.writeFileSync(path.join(box.repo, "café ünï.md"), "unicode body\n");
  const r = run(box, ["review", ""]);
  assert.equal(r.status, 0, r.stderr);
  const prompt = flag(calls(box)[0].args, "-p");
  assert.match(prompt, /\+\+\+ b\/café ünï\.md/);
  assert.match(prompt, /\+unicode body/);
});

test("gemini runs are killed at --timeout and report it", () => {
  const box = sandbox();
  const started = Date.now();
  const r = run(box, ["task", "--backend", "gemini", "--timeout", "1s", "--", "slow"], { FAKE_DELAY_MS: "20000" });
  assert.equal(r.status, 1);
  assert.ok(Date.now() - started < 10000);
  assert.match(r.stdout, /did not finish within 1s/);
});

test("gemini untrusted folder (exit 55) explains how to trust it", () => {
  const box = sandbox();
  const r = run(box, ["task", "--backend", "gemini", "--", "x"], { FAKE_MODE: "untrusted" });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /does not trust this folder/);
});

test("an invalid --timeout is rejected before any job or backend call", () => {
  const box = sandbox();
  const r = run(box, ["task", "--timeout", "soon", "--", "x"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Invalid --timeout/);
  assert.equal(calls(box).length, 0);
});

test("state falls back to a private per-user directory when CLAUDE_PLUGIN_DATA is unset", () => {
  const box = sandbox();
  const home = path.join(box.root, "home");
  fs.mkdirSync(home);
  const r = run(box, ["task", "--", "x"], { ANTIGRAVITY_COMPANION_DATA: "", HOME: home });
  assert.equal(r.status, 0, r.stderr);
  const dir = path.join(home, ".claude", "plugins", "data", "antigravity-antigravity-cc", "state");
  assert.ok(fs.existsSync(dir));
  assert.equal(fs.statSync(dir).mode & 0o077, 0);
});

test("the denied-command retry runs at most once even if the resumed turn is blocked again", () => {
  const box = sandbox();
  const r = run(box, ["task", "--", "x"], { FAKE_MODE: "denied-always", FAKE_RESPONSE: "" });
  assert.equal(calls(box).length, 2);
  assert.match(r.stdout, /RunCommand/);
});

test("no retry when the answer has text, or when a review already has structured output", () => {
  const box = sandbox();
  run(box, ["task", "--", "x"], { FAKE_MODE: "denied" });
  assert.equal(calls(box).length, 1);
  fs.appendFileSync(path.join(box.repo, "a.py"), "s = 1\n");
  const r = run(box, ["review", ""], { FAKE_MODE: "denied-empty-structured", FAKE_RESPONSE: "" });
  assert.equal(calls(box).length, 2);
  assert.match(r.stdout, /Verdict: \*\*needs-attention\*\*/);
});

test("the retry only gets the remaining time budget and is skipped when under a minute is left", () => {
  const box = sandbox();
  run(box, ["task", "--timeout", "10m", "--", "x"], { FAKE_MODE: "denied-once", FAKE_RESPONSE: "ok" });
  const [first, second] = calls(box);
  assert.equal(flag(first.args, "--print-timeout"), "10m");
  const secs = Number(flag(second.args, "--print-timeout").replace("s", ""));
  assert.ok(secs > 500 && secs <= 600, String(secs));
  const box2 = sandbox();
  run(box2, ["task", "--timeout", "50s", "--", "x"], { FAKE_MODE: "denied-once", FAKE_RESPONSE: "ok" });
  assert.equal(calls(box2).length, 1);
});

test("a failed retry keeps the first conversation id so the work can be resumed", () => {
  const box = sandbox();
  const r = run(box, ["task", "--", "x"], { FAKE_MODE: "retry-crash" });
  const conv = flag(calls(box)[1].args, "--conversation");
  assert.match(r.stdout, new RegExp(`agy --conversation ${conv}`));
  const cand = JSON.parse(run(box, ["resume-candidate", "--json"]).stdout);
  assert.equal(cand.candidate.conversationId, conv);
});

test("write jobs get the write variant of the headless note, read-only jobs the read variant", () => {
  const box = sandbox();
  run(box, ["task", "--write", "--", "fix"]);
  run(box, ["task", "--", "look"]);
  const [w, ro] = calls(box);
  assert.match(flag(w.args, "-p"), /^Headless session: you may edit files directly/);
  assert.match(flag(ro.args, "-p"), /^Headless, read-only session/);
});

test("state fallback honours CLAUDE_CONFIG_DIR", () => {
  const box = sandbox();
  const cfg = path.join(box.root, "cfg");
  run(box, ["task", "--", "x"], { ANTIGRAVITY_COMPANION_DATA: "", CLAUDE_CONFIG_DIR: cfg });
  assert.ok(fs.existsSync(path.join(cfg, "plugins", "data", "antigravity-antigravity-cc", "state")));
});

test("a run longer than the wait window hands off to the background with progress, and status --wait collects it", () => {
  const box = sandbox();
  const r = run(box, ["task", "--", "long one"], { FAKE_DELAY_MS: "3000", ANTIGRAVITY_COMPANION_WAIT_MS: "1200" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /is still running .* continues in the background as (task-\S+)\./);
  assert.match(r.stdout, /Last step: step 1: view_file a\.py; 1 steps so far/);
  const id = r.stdout.match(/background as (\S+)\./)[1];
  assert.match(r.stdout, new RegExp(`status ${id} --wait`));
  const mid = run(box, ["status", id]);
  assert.match(mid.stdout, /Now: step 1: view_file a\.py/);
  const done = run(box, ["status", `${id} --wait`], { ANTIGRAVITY_COMPANION_WAIT_MS: "15000" });
  assert.match(done.stdout, /Status: completed/);
  assert.match(done.stdout, /answer to: long one/);
});

test("progress steps from the stream are recorded in the job", () => {
  const box = sandbox();
  const r = run(box, ["task", "--", "x"]);
  const id = r.stdout.match(/Job: (\S+)/)[1];
  const job = JSON.parse(run(box, ["status", `${id} --json`]).stdout);
  assert.equal(job.steps, 2);
  assert.match(job.progress.text, /step 2: thinking/);
  const log = fs.readFileSync(path.join(path.dirname(path.dirname(fs.readdirSync(path.join(box.data, "state")).map((d) => path.join(box.data, "state", d, "jobs", "x"))[0])), "jobs", `${id}.log`), "utf8");
  assert.match(log, /step 1: read_file a\.py\n.*step 2: thinking/s);
});

test("interrupting a foreground wait cancels the job and stops agy", async () => {
  const box = sandbox();
  const { spawn } = await import("node:child_process");
  const env = { ...process.env, ANTIGRAVITY_COMPANION_DATA: box.data, ANTIGRAVITY_AGY_BIN: path.join(BIN, "agy"), FAKE_LOG: box.log, FAKE_DELAY_MS: "30000", ANTIGRAVITY_COMPANION_SESSION_ID: "session-A" };
  const child = spawn(process.execPath, [SCRIPT, "task", "--", "x"], { cwd: box.repo, env });
  assert.ok(waitFor(() => calls(box).length === 1));
  child.kill("SIGINT");
  await new Promise((res) => child.on("close", res));
  const list = JSON.parse(run(box, ["status", "--json --all"]).stdout).jobs;
  assert.equal(list[0].status, "cancelled");
  assert.ok(waitFor(() => { try { process.kill(list[0].pid, 0); return false; } catch { return true; } }));
});

test("a job whose agy process is stopped by a signal is recorded as cancelled, not failed", () => {
  const box = sandbox();
  const r = run(box, ["task", "--background", "--", "x"], { FAKE_DELAY_MS: "30000" });
  const id = r.stdout.match(/background as (\S+)\./)[1];
  assert.ok(waitFor(() => calls(box).length === 1));
  const agyPid = Number(spawnSync("pgrep", ["-f", `${BIN}/agy`], { encoding: "utf8" }).stdout.trim().split("\n")[0]);
  process.kill(agyPid, "SIGTERM");
  assert.ok(waitFor(() => /Status: cancelled/.test(run(box, ["status", id]).stdout)));
});

test("interrupting status --wait cancels the running job", async () => {
  const box = sandbox();
  const r = run(box, ["task", "--background", "--", "x"], { FAKE_DELAY_MS: "30000" });
  const id = r.stdout.match(/background as (\S+)\./)[1];
  assert.ok(waitFor(() => /Status: running/.test(run(box, ["status", id]).stdout)));
  const { spawn } = await import("node:child_process");
  const env = { ...process.env, ANTIGRAVITY_COMPANION_DATA: box.data, ANTIGRAVITY_COMPANION_SESSION_ID: "session-A" };
  const waiter = spawn(process.execPath, [SCRIPT, "status", id, "--wait"], { cwd: box.repo, env });
  await new Promise((res) => setTimeout(res, 800));
  waiter.kill("SIGINT");
  await new Promise((res) => waiter.on("close", res));
  assert.match(run(box, ["status", id]).stdout, /Status: cancelled/);
});
