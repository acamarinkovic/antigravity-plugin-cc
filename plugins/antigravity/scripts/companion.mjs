#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const PLUGIN_ROOT = path.dirname(path.dirname(SELF));
const SESSION_ENV = "ANTIGRAVITY_COMPANION_SESSION_ID";
const DATA_ENV = "ANTIGRAVITY_COMPANION_DATA";
const BACKENDS = ["agy", "gemini"];
const AGY_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const INLINE_LIMIT = 100 * 1024;
const GEMINI_STDIN_LIMIT = 7 * 1024 * 1024;
const UNTRACKED_LIMIT = 24 * 1024;
const MAX_JOBS = 50;
const FOREGROUND_TIMEOUT = "8m";
const BACKGROUND_TIMEOUT = "60m";
const GEMINI_HEADLESS_AUTH = ["oauth-personal", "gemini-api-key", "vertex-ai", "compute-default-credentials"];
const SEVERITY_ORDER = { critical: 0, high: 1, medium: 2, low: 3 };

const DENIED_RETRY_PROMPT = "Your last action was blocked: in this headless session terminal commands are never allowed, and trying one ends your turn without an answer. Do not run any command. Using only the files you can read and the content already given, give your complete final answer now, in the exact format that was requested.";
const HEADLESS_NOTE = {
  read: "Headless, read-only session: you can read files but cannot edit them, and terminal commands are blocked (trying one ends your turn with no answer). Everything you need is in the files or in this message.",
  write: "Headless session: you may edit files directly, but terminal commands are blocked (trying one ends your turn with no answer), so you cannot run tests or builds. Make the changes, then summarize what you changed."
};

class UserError extends Error {}

function fail(message) {
  throw new UserError(message);
}

function splitArgs(argv) {
  if (argv.length !== 1) return argv;
  const text = argv[0];
  const out = [];
  let cur = "";
  let quote = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || cur) out.push(cur);
      cur = "";
      started = false;
      continue;
    }
    cur += ch;
  }
  if (quote) return text.split(/\s+/).filter(Boolean);
  if (started || cur) out.push(cur);
  return out;
}

function parseFlags(args, { flags = [], values = [], anywhere = false }) {
  const opts = {};
  if (anywhere) {
    const rest = [];
    for (let i = 0; i < args.length; i++) {
      const name = args[i].startsWith("--") ? args[i].slice(2) : null;
      if (name && values.includes(name)) {
        if (i + 1 >= args.length) fail(`--${name} needs a value`);
        opts[name] = args[++i];
      } else if (name && flags.includes(name)) {
        opts[name] = true;
      } else {
        rest.push(args[i]);
      }
    }
    return { opts, rest };
  }
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("--")) break;
    const name = arg.slice(2);
    if (values.includes(name)) {
      if (i + 1 >= args.length) fail(`--${name} needs a value`);
      opts[name] = args[++i];
    } else if (flags.includes(name)) {
      opts[name] = true;
    } else {
      fail(`Unknown option --${name}`);
    }
  }
  return { opts, rest: args.slice(i) };
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

function workspaceRoot(cwd) {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  return top ? top.trim() : cwd;
}

function stateDir(root) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
  const data = process.env[DATA_ENV] || path.join(configDir, "plugins", "data", "antigravity-antigravity-cc");
  const base = path.join(data, "state");
  let real = root;
  try {
    real = fs.realpathSync(root);
  } catch {}
  const slug = path.basename(real).replace(/[^A-Za-z0-9._-]/g, "_") || "root";
  const hash = crypto.createHash("sha256").update(real).digest("hex").slice(0, 16);
  return path.join(base, `${slug}-${hash}`);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function loadConfig(dir) {
  return readJson(path.join(dir, "config.json"), { stopReviewGate: false });
}

function saveConfig(dir, config) {
  writeJson(path.join(dir, "config.json"), config);
}

function jobsDir(dir) {
  return path.join(dir, "jobs");
}

function jobFile(dir, id) {
  return path.join(jobsDir(dir), `${id}.json`);
}

function logFile(dir, id) {
  return path.join(jobsDir(dir), `${id}.log`);
}

function saveJob(dir, job) {
  job.updatedAt = new Date().toISOString();
  writeJson(jobFile(dir, job.id), job);
}

function loadJob(dir, id) {
  return readJson(jobFile(dir, id), null);
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function isActive(job) {
  return job.status === "queued" || job.status === "running";
}

function listJobs(dir) {
  let names = [];
  try {
    names = fs.readdirSync(jobsDir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return [];
  }
  const jobs = names.map((n) => readJson(path.join(jobsDir(dir), n), null)).filter(Boolean);
  for (const [i, job] of jobs.entries()) {
    if (isActive(job) && job.pid && !pidAlive(job.pid)) {
      const fresh = loadJob(dir, job.id);
      if (!fresh || !isActive(fresh)) {
        if (fresh) jobs[i] = fresh;
        continue;
      }
      job.status = "failed";
      job.error = "The worker process exited before finishing.";
      job.completedAt = new Date().toISOString();
      saveJob(dir, job);
    }
  }
  return jobs.sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
}

function pruneJobs(dir) {
  const jobs = listJobs(dir);
  for (const job of jobs.slice(MAX_JOBS)) {
    if (isActive(job)) continue;
    for (const f of [jobFile(dir, job.id), logFile(dir, job.id), path.join(dir, "inputs", `${job.id}.md`)]) {
      fs.rmSync(f, { force: true });
    }
  }
}

function sessionJobs(jobs, all) {
  const session = process.env[SESSION_ENV];
  if (all || !session) return jobs;
  return jobs.filter((j) => j.sessionId === session);
}

function findJob(dir, ref, predicate, what) {
  const jobs = listJobs(dir);
  if (ref) {
    const matches = jobs.filter((j) => j.id === ref || j.id.startsWith(ref));
    if (matches.length === 0) fail(`No job matches "${ref}". Run /antigravity:status to list jobs.`);
    if (matches.length > 1) fail(`"${ref}" matches several jobs: ${matches.map((j) => j.id).join(", ")}`);
    return matches[0];
  }
  const candidates = sessionJobs(jobs).filter(predicate);
  if (candidates.length === 0) fail(`No ${what} job in this session. Run /antigravity:status --all to see every job.`);
  return candidates[0];
}

function newId(kind) {
  return `${kind === "task" ? "task" : "review"}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
}

function resolveBackend(name) {
  const backend = name || process.env.ANTIGRAVITY_COMPANION_BACKEND || "agy";
  if (!BACKENDS.includes(backend)) fail(`Unknown backend "${backend}". Use one of: ${BACKENDS.join(", ")}.`);
  return backend;
}

function binaryFor(backend) {
  return backend === "agy"
    ? process.env.ANTIGRAVITY_AGY_BIN || "agy"
    : process.env.ANTIGRAVITY_GEMINI_BIN || "gemini";
}

function resolveModel(backend, model, effort) {
  if (backend === "gemini") {
    if (effort) fail("--effort is only supported by the agy backend.");
    return model || process.env.ANTIGRAVITY_COMPANION_GEMINI_MODEL || "";
  }
  if (effort && !AGY_EFFORTS.includes(effort)) fail(`--effort must be one of: ${AGY_EFFORTS.join(", ")}.`);
  const chosen = model || process.env.ANTIGRAVITY_COMPANION_MODEL || "gemini-4-argon-high";
  return effort ? chosen.replace(new RegExp(`-(${AGY_EFFORTS.join("|")})$`), "") : chosen;
}

function fileInputNote(file) {
  return `The full input is too large to inline. It is saved at ${file}; read that file completely before answering.`;
}

function buildInvocation(job, dir) {
  const req = job.request;
  const bin = binaryFor(job.backend);
  if (job.backend === "agy") {
    let prompt = req.resume && req.prompt === DENIED_RETRY_PROMPT ? req.prompt : `${HEADLESS_NOTE[job.write ? "write" : "read"]}\n\n${req.prompt}`;
    const addDirs = [];
    if (Buffer.byteLength(prompt) > INLINE_LIMIT) {
      const inputs = ensureDir(path.join(dir, "inputs"));
      const file = path.join(inputs, `${job.id}.md`);
      fs.writeFileSync(file, prompt, { mode: 0o600 });
      prompt = `Read your complete instructions from ${file} and follow them exactly. ${req.schema ? "Your final answer must match the provided JSON schema." : ""}`.trim();
      addDirs.push(inputs);
    }
    const args = ["-p", prompt, "--output-format", "json", "--print-timeout", req.timeout, "--sandbox"];
    args.push("--mode", job.write ? "accept-edits" : "plan");
    if (job.model) args.push("--model", job.model);
    if (job.effort) args.push("--effort", job.effort);
    if (req.resume) args.push("--conversation", req.resume);
    for (const d of addDirs) args.push("--add-dir", d);
    if (req.schema) args.push("--json-schema", req.schema);
    return { bin, args, stdin: null };
  }
  let prompt = req.prompt;
  if (req.schema) {
    prompt += `\n\nReturn only a single JSON object, with no prose and no code fences, matching this JSON schema:\n${fs.readFileSync(req.schema, "utf8")}`;
  }
  if (Buffer.byteLength(prompt) > GEMINI_STDIN_LIMIT) fail("Input is larger than this plugin's 7 MB limit for Gemini CLI stdin.");
  const args = ["-p", "", "-o", "json", "--approval-mode", job.write ? "auto_edit" : "plan"];
  if (job.model) args.push("-m", job.model);
  if (req.resume) args.push("--resume", req.resume);
  return { bin, args, stdin: prompt };
}

function tail(text, lines = 12) {
  return text.trim().split("\n").slice(-lines).join("\n");
}

function extractJsonObject(text) {
  if (!text) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced && fenced[1], text];
  for (const c of candidates) {
    if (!c) continue;
    const start = c.indexOf("{");
    const end = c.lastIndexOf("}");
    if (start < 0 || end <= start) continue;
    try {
      return JSON.parse(c.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function parseAgy(stdout, stderr, code) {
  let d;
  try {
    d = JSON.parse(stdout.trim());
  } catch {
    return { ok: false, error: tail(stderr) || `agy exited with code ${code} and printed no JSON.` };
  }
  if (d.status !== "SUCCESS") {
    return { ok: false, conversationId: d.conversation_id || null, error: d.error || tail(stderr) || "agy reported an error." };
  }
  const timedOut = /print timeout after/.test(stderr);
  return {
    ok: !timedOut,
    conversationId: d.conversation_id || null,
    text: plainLinks((d.response || "").trim()),
    structured: d.structured_output ?? null,
    denied: (d.denied_actions || []).map((a) => a.display_name || a.action),
    durationSeconds: d.duration_seconds,
    error: timedOut ? "Antigravity hit the print timeout before finishing; the answer below is partial." : null
  };
}

function parseGemini(stdout, stderr, code) {
  const d = extractJsonObject(stdout);
  if (d && typeof d.response === "string" && !d.error) {
    return {
      ok: true,
      conversationId: d.session_id || null,
      text: d.response.trim(),
      structured: null,
      denied: [],
      model: d.stats && d.stats.models ? Object.keys(d.stats.models).join(", ") : null
    };
  }
  const errStart = stderr.search(/\{\s*"session_id"/);
  const errJson = errStart >= 0 ? extractJsonObject(stderr.slice(errStart)) : null;
  const message = (d && d.error && d.error.message) || (errJson && errJson.error && errJson.error.message);
  let error = message || tail(stderr) || `gemini exited with code ${code}.`;
  if (code === 55 || /trusted (directory|folder)/i.test(error)) {
    error += "\nGemini CLI does not trust this folder. Open it once with `gemini` and choose to trust it if you trust the repository's .gemini settings, then retry, or use --backend agy.";
  }
  if (code === 41 || /auth method/i.test(error)) {
    error += "\nGemini CLI is not signed in for headless use. Run `! gemini`, choose \"Login with Google\", then retry. /antigravity:setup shows the details.";
  }
  return { ok: false, conversationId: (errJson && errJson.session_id) || null, error };
}

function durationMs(text) {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(String(text).trim());
  if (!m) fail(`Invalid --timeout "${text}". Use values like 90s, 8m or 1h.`);
  return Number(m[1]) * { ms: 1, s: 1000, m: 60000, h: 3600000 }[m[2] || "s"];
}

function runBackend(job, dir) {
  let inv;
  let limitMs;
  try {
    limitMs = durationMs(job.request.timeout) + (job.backend === "agy" ? 30000 : 0);
    inv = buildInvocation(job, dir);
  } catch (err) {
    return Promise.resolve({ ok: false, error: err.message });
  }
  const log = fs.openSync(logFile(dir, job.id), "a");
  fs.writeSync(log, `[${new Date().toISOString()}] ${inv.bin} ${inv.args.filter((a, i) => inv.args[i - 1] !== "-p").join(" ")}\n`);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(inv.bin, inv.args, { cwd: job.cwd, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      fs.closeSync(log);
      resolve({ ok: false, error: `Could not start ${inv.bin}: ${err.message}` });
      return;
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, limitMs);
    const stop = () => child.kill("SIGTERM");
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    child.stdout.on("data", (b) => (stdout += b));
    child.stderr.on("data", (b) => {
      stderr += b;
      fs.writeSync(log, b);
    });
    child.on("error", (err) => {
      stderr += `\n${err.code === "ENOENT" ? `${inv.bin} is not installed or not on PATH. Run /antigravity:setup.` : err.message}`;
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      process.removeListener("SIGTERM", stop);
      process.removeListener("SIGINT", stop);
      fs.closeSync(log);
      if (timedOut) {
        resolve({ ok: false, error: `${inv.bin} did not finish within ${job.request.timeout}. Retry with --background or a larger --timeout.` });
        return;
      }
      if (signal) {
        resolve({ ok: false, error: `${inv.bin} was stopped (${signal}).` });
        return;
      }
      resolve(job.backend === "agy" ? parseAgy(stdout, stderr, code) : parseGemini(stdout, stderr, code));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(inv.stdin ?? "");
  });
}

function backendLabel(job) {
  const name = job.backend === "agy" ? "Antigravity" : "Gemini CLI";
  const model = job.result?.model || job.model || "default model";
  return `${name} · ${model}${job.effort ? ` · effort ${job.effort}` : ""}`;
}

function resumeHint(job) {
  const id = job.result?.conversationId;
  if (!id) return null;
  return job.backend === "agy" ? `agy --conversation ${id}` : `gemini --resume ${id}`;
}

function footer(job) {
  const lines = ["", "---", backendLabel(job) + (job.durationSeconds ? ` · ${job.durationSeconds}s` : "")];
  if (job.result?.denied?.length) lines.push(`Blocked (headless agy cannot ask for permission): ${[...new Set(job.result.denied)].join(", ")}`);
  const hint = resumeHint(job);
  if (hint && job.kind === "task") lines.push(`Follow up: /antigravity:ask --resume <question> · terminal: ${hint}`);
  lines.push(`Job: ${job.id}`);
  return lines.join("\n");
}

function renderReview(job, review) {
  const title = job.kind === "adversarial-review" ? "Adversarial Review" : "Review";
  const out = [`# ${job.backend === "agy" ? "Antigravity" : "Gemini"} ${title}`, "", `Target: ${job.target}`, `Verdict: **${review.verdict}**`, "", review.summary || ""];
  const findings = [...(review.findings || [])].sort((a, b) => (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9));
  out.push("", "## Findings");
  if (findings.length === 0) out.push("", "No material findings.");
  for (const f of findings) {
    const lines = f.line_end && f.line_end !== f.line_start ? `L${f.line_start}-${f.line_end}` : `L${f.line_start}`;
    const conf = typeof f.confidence === "number" ? ` (confidence ${f.confidence})` : "";
    out.push("", `- **[${f.severity}] ${f.title}** — \`${f.file}:${lines}\`${conf}`, `  ${String(f.body).replace(/\n/g, "\n  ")}`);
    if (f.recommendation) out.push(`  Recommendation: ${f.recommendation}`);
  }
  if (review.next_steps?.length) {
    out.push("", "## Next steps");
    for (const s of review.next_steps) out.push(`- ${s}`);
  }
  return out.join("\n");
}

function looksLikeReview(value) {
  return value && typeof value === "object" && typeof value.verdict === "string" && Array.isArray(value.findings);
}

function render(job) {
  const r = job.result || {};
  if (!r.ok && !r.text) return `${backendLabel(job)} failed.\n\n${r.error || job.error || "Unknown error."}\n${footer(job)}`;
  let body;
  if (job.kind === "review" || job.kind === "adversarial-review") {
    const review = looksLikeReview(r.structured) ? r.structured : extractJsonObject(r.text);
    body = looksLikeReview(review) ? renderReview(job, review) : `Could not parse a structured review; raw answer:\n\n${r.text}`;
  } else {
    body = r.text || "(No text was returned.)";
  }
  const warn = r.error ? `> ${r.error}\n\n` : "";
  return `${warn}${body}\n${footer(job)}`;
}

async function executeJob(dir, job) {
  job.status = "running";
  job.pid = process.pid;
  job.startedAt = new Date().toISOString();
  saveJob(dir, job);
  const started = Date.now();
  let result = await runBackend(job, dir);
  const remainingMs = durationMs(job.request.timeout) - (Date.now() - started);
  const retry =
    job.backend === "agy" && result.ok && !result.text && result.structured == null &&
    result.denied?.length && result.conversationId && remainingMs >= 60000 &&
    loadJob(dir, job.id)?.status !== "cancelled";
  if (retry) {
    const first = result;
    const original = job.request;
    job.request = { ...original, resume: first.conversationId, prompt: DENIED_RETRY_PROMPT, timeout: `${Math.floor(remainingMs / 1000)}s` };
    result = await runBackend(job, dir);
    job.request = original;
    result.denied = [...first.denied, ...(result.denied || [])];
    result.conversationId = result.conversationId || first.conversationId;
  }
  const current = loadJob(dir, job.id);
  if (current && current.status === "cancelled") return current;
  job.result = result;
  job.durationSeconds = Math.round((Date.now() - started) / 1000);
  job.status = result.ok || result.text ? "completed" : "failed";
  job.error = result.ok ? null : result.error;
  job.completedAt = new Date().toISOString();
  job.rendered = render(job);
  saveJob(dir, job);
  return job;
}

function createJob(cwd, fields) {
  const root = workspaceRoot(cwd);
  const dir = stateDir(root);
  ensureDir(jobsDir(dir));
  const job = {
    id: newId(fields.kind),
    status: "queued",
    cwd,
    workspaceRoot: root,
    sessionId: process.env[SESSION_ENV] || null,
    createdAt: new Date().toISOString(),
    ...fields
  };
  saveJob(dir, job);
  pruneJobs(dir);
  return { dir, job };
}

async function launch(dir, job, background) {
  if (!background) {
    const done = await executeJob(dir, job);
    process.stdout.write(done.rendered + "\n");
    process.exitCode = done.status === "completed" ? 0 : 1;
    return;
  }
  const child = spawn(process.execPath, [SELF, "worker", dir, job.id], {
    cwd: job.cwd,
    detached: true,
    stdio: "ignore",
    env: process.env
  });
  child.unref();
  job.pid = child.pid;
  saveJob(dir, job);
  process.stdout.write(`${job.title} started in the background as ${job.id}.\nCheck /antigravity:status ${job.id} for progress and /antigravity:result ${job.id} for the answer.\n`);
}

function resumeCandidate(dir, backend) {
  return sessionJobs(listJobs(dir)).find(
    (j) => j.kind === "task" && j.backend === backend && j.result?.conversationId && !isActive(j)
  );
}

async function cmdTask(args) {
  const { opts, rest } = parseFlags(args, {
    flags: ["background", "write", "resume", "fresh", "json", "stdin"],
    values: ["backend", "model", "effort", "timeout", "prompt-file", "conversation"]
  });
  let prompt = rest.join(" ").trim();
  if (opts["prompt-file"]) prompt = fs.readFileSync(opts["prompt-file"], "utf8");
  if (opts.stdin) prompt = [prompt, fs.readFileSync(0, "utf8").trim()].filter(Boolean).join("\n");
  const backend = resolveBackend(opts.backend);
  const cwd = process.cwd();
  const dir = stateDir(workspaceRoot(cwd));
  let resume = opts.conversation || null;
  if (opts.resume && !opts.fresh && !resume) {
    const prev = resumeCandidate(dir, backend);
    if (!prev) fail("There is no earlier conversation to resume in this session. Run without --resume.");
    if (listJobs(dir).some((j) => j.kind === "task" && isActive(j) && j.sessionId === prev.sessionId)) {
      fail("A task is still running in this session. Wait for it or cancel it before resuming.");
    }
    resume = prev.result.conversationId;
  }
  if (!prompt) {
    if (!resume) fail("Provide a question or task.");
    prompt = "Continue from where we left off. Pick the most valuable next step and finish it.";
  }
  const effort = opts.effort || null;
  if (opts.timeout) durationMs(opts.timeout);
  const { job } = createJob(cwd, {
    kind: "task",
    title: `${backend === "agy" ? "Antigravity" : "Gemini"} ${opts.write ? "task" : "question"}`,
    summary: prompt.replace(/\s+/g, " ").slice(0, 80),
    backend,
    model: resolveModel(backend, opts.model, effort),
    effort,
    write: Boolean(opts.write),
    request: { prompt, resume, timeout: opts.timeout || (opts.background ? BACKGROUND_TIMEOUT : FOREGROUND_TIMEOUT) }
  });
  await launch(dir, job, opts.background);
}

function defaultBranch(cwd) {
  const head = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], cwd);
  if (head) return head.trim().replace("refs/remotes/", "");
  for (const b of ["main", "master", "trunk"]) {
    if (git(["rev-parse", "--verify", "--quiet", b], cwd) !== null) return b;
  }
  return null;
}

function untrackedContent(root) {
  const files = (git(["-c", "core.quotePath=false", "ls-files", "-z", "--others", "--exclude-standard"], root) || "").split("\0").filter(Boolean);
  let out = "";
  for (const f of files) {
    let buf;
    try {
      const st = fs.statSync(path.join(root, f));
      if (!st.isFile()) continue;
      if (st.size > UNTRACKED_LIMIT) {
        out += `\nNew untracked file (not inlined, ${st.size} bytes): ${f}\n`;
        continue;
      }
      buf = fs.readFileSync(path.join(root, f));
    } catch {
      continue;
    }
    if (buf.includes(0)) {
      out += `\nNew untracked binary file: ${f}\n`;
      continue;
    }
    out += `\ndiff --git a/${f} b/${f}\nnew file (untracked)\n--- /dev/null\n+++ b/${f}\n${buf.toString("utf8").replace(/^/gm, "+")}\n`;
  }
  return out;
}

function collectTarget(root, opts) {
  const scope = opts.base ? "branch" : opts.scope || "auto";
  if (!["auto", "working-tree", "branch"].includes(scope)) fail("--scope must be auto, working-tree or branch.");
  if (git(["rev-parse", "--git-dir"], root) === null) fail("Not inside a git repository.");
  const dirty = (git(["status", "--porcelain", "--untracked-files=all"], root) || "").trim();
  if (scope === "working-tree" || (scope === "auto" && dirty)) {
    const hasHead = git(["rev-parse", "--verify", "--quiet", "HEAD"], root) !== null;
    const tracked = hasHead ? git(["diff", "HEAD"], root) || "" : (git(["diff", "--cached"], root) || "") + (git(["diff"], root) || "");
    return { label: "the uncommitted changes in the working tree", diff: tracked + untrackedContent(root) };
  }
  const base = opts.base || defaultBranch(root);
  if (!base) fail("Working tree is clean and no default branch was found. Pass --base <ref>.");
  const diff = git(["diff", `${base}...HEAD`], root);
  if (diff === null) fail(`Could not diff against "${base}".`);
  const log = git(["log", "--oneline", `${base}..HEAD`], root) || "";
  return { label: `the branch changes against ${base}`, diff: log ? `Commits:\n${log}\n${diff}` : diff };
}

function fillTemplate(name, values) {
  let text = fs.readFileSync(path.join(PLUGIN_ROOT, "prompts", `${name}.md`), "utf8");
  for (const [k, v] of Object.entries(values)) text = text.split(`{{${k}}}`).join(v);
  return text;
}

async function cmdReview(kind, argv) {
  const args = argv.includes("--args-stdin")
    ? [...splitArgs([fs.readFileSync(0, "utf8").trim()]), ...argv.filter((a) => a !== "--args-stdin")]
    : splitArgs(argv);
  const { opts, rest } = parseFlags(args, {
    flags: ["background", "wait"],
    values: ["backend", "model", "effort", "base", "scope", "timeout"],
    anywhere: true
  });
  const cwd = process.cwd();
  const root = workspaceRoot(cwd);
  const target = collectTarget(root, opts);
  if (!target.diff.trim()) {
    process.stdout.write(`Nothing to review: ${target.label} are empty.\n`);
    return;
  }
  const backend = resolveBackend(opts.backend);
  const effort = opts.effort || null;
  const focus = rest.join(" ").trim() || "No extra focus provided.";
  const prompt = fillTemplate(kind, { TARGET: target.label, FOCUS: focus, INPUT: target.diff });
  if (opts.timeout) durationMs(opts.timeout);
  const { dir, job } = createJob(root, {
    kind,
    title: `${backend === "agy" ? "Antigravity" : "Gemini"} ${kind}`,
    summary: `${target.label}${rest.length ? ` · focus: ${focus.slice(0, 60)}` : ""}`,
    target: target.label,
    backend,
    model: resolveModel(backend, opts.model, effort),
    effort,
    write: false,
    request: {
      prompt,
      schema: path.join(PLUGIN_ROOT, "schemas", "review-output.schema.json"),
      timeout: opts.timeout || (opts.background ? BACKGROUND_TIMEOUT : FOREGROUND_TIMEOUT)
    }
  });
  await launch(dir, job, opts.background && !opts.wait);
}

function elapsed(job) {
  const start = Date.parse(job.startedAt || job.createdAt);
  const end = job.completedAt ? Date.parse(job.completedAt) : Date.now();
  const s = Math.max(0, Math.round((end - start) / 1000));
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s` : `${s}s`;
}

async function cmdStatus(args) {
  const { opts, rest } = parseFlags(splitArgs(args), { flags: ["all", "wait", "json"], values: ["timeout-ms"], anywhere: true });
  const dir = stateDir(workspaceRoot(process.cwd()));
  if (rest[0]) {
    let job = findJob(dir, rest[0], () => true, "");
    const deadline = Date.now() + Number(opts["timeout-ms"] || 240000);
    while (opts.wait && isActive(job) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      job = findJob(dir, job.id, () => true, "");
    }
    if (opts.json) return void process.stdout.write(JSON.stringify(job, null, 2) + "\n");
    const lines = [
      `Job ${job.id}`,
      `Kind: ${job.kind} · ${backendLabel(job)}${job.write ? " · write" : " · read-only"}`,
      `Status: ${job.status} · ${elapsed(job)}`,
      `Summary: ${job.summary}`
    ];
    if (isActive(job)) {
      const logTail = tail(readText(logFile(dir, job.id)), 6);
      if (logTail) lines.push("", "Recent log:", logTail);
      lines.push("", `Cancel with /antigravity:cancel ${job.id}`);
    } else {
      lines.push("", job.rendered || job.error || "");
    }
    process.stdout.write(lines.join("\n") + "\n");
    return;
  }
  const jobs = sessionJobs(listJobs(dir), opts.all).slice(0, opts.all ? MAX_JOBS : 8);
  const config = loadConfig(dir);
  if (opts.json) return void process.stdout.write(JSON.stringify({ config, jobs }, null, 2) + "\n");
  const out = [`Stop review gate: ${config.stopReviewGate ? "on" : "off"}`];
  if (jobs.length === 0) {
    out.push("No Antigravity jobs" + (opts.all ? "." : " in this session. Use --all to see every job in this repository."));
  } else {
    out.push("", "| Job | Kind | Backend | Status | Time | Summary |", "|---|---|---|---|---|---|");
    for (const j of jobs) {
      out.push(`| ${j.id} | ${j.kind}${j.write ? " (write)" : ""} | ${j.backend}${j.model ? ` ${j.model}` : ""} | ${j.status} | ${elapsed(j)} | ${String(j.summary).replace(/\|/g, "/")} |`);
    }
    out.push("", "Details: /antigravity:status <job> · answer: /antigravity:result <job> · stop: /antigravity:cancel <job>");
  }
  process.stdout.write(out.join("\n") + "\n");
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function cmdResult(args) {
  const { rest } = parseFlags(splitArgs(args), { anywhere: true });
  const dir = stateDir(workspaceRoot(process.cwd()));
  const job = findJob(dir, rest[0], (j) => !isActive(j), "finished");
  if (isActive(job)) fail(`${job.id} is still ${job.status}. Check /antigravity:status ${job.id}.`);
  process.stdout.write((job.rendered || job.error || "No output was stored.") + "\n");
}

function terminate(pid) {
  if (!pid) return;
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function cmdCancel(args) {
  const { rest } = parseFlags(splitArgs(args), { anywhere: true });
  const dir = stateDir(workspaceRoot(process.cwd()));
  let job;
  if (rest[0]) {
    job = findJob(dir, rest[0], () => true, "");
  } else {
    const active = sessionJobs(listJobs(dir)).filter(isActive);
    if (active.length === 0) fail("No running Antigravity job in this session.");
    if (active.length > 1) fail(`Several jobs are running: ${active.map((j) => j.id).join(", ")}. Pass one id.`);
    job = active[0];
  }
  if (!isActive(job)) return void process.stdout.write(`${job.id} already ${job.status}.\n`);
  job.status = "cancelled";
  job.completedAt = new Date().toISOString();
  job.rendered = `${job.title} was cancelled.`;
  saveJob(dir, job);
  terminate(job.pid);
  process.stdout.write(`Cancelled ${job.id}.\n`);
}

function which(bin) {
  const r = spawnSync("/bin/sh", ["-c", `command -v "$1"`, "sh", bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function checkAgy() {
  const bin = binaryFor("agy");
  const found = which(bin);
  if (!found) {
    return { ready: false, detail: "not installed", next: "Install Google Antigravity and its CLI (`agy`), then run `agy install` once." };
  }
  const version = spawnSync(found, ["--version"], { encoding: "utf8", timeout: 15000 }).stdout?.trim();
  const models = spawnSync(found, ["models"], { encoding: "utf8", timeout: 30000, input: "" });
  const ids = (models.stdout || "").split("\n").map((l) => l.split("\t")[0].trim()).filter((l) => /^[a-z0-9][a-z0-9.-]+$/.test(l));
  if (models.status !== 0 || ids.length === 0) {
    return { ready: false, path: found, version, detail: "installed but not signed in", next: "Run `! agy` once and complete the Google sign-in, then rerun /antigravity:setup." };
  }
  return { ready: true, path: found, version, models: ids, detail: `signed in, ${ids.length} models` };
}

function checkGemini() {
  const bin = binaryFor("gemini");
  const found = which(bin);
  if (!found) return { ready: false, detail: "not installed (optional)", next: "Optional: `npm install -g @google/gemini-cli` to enable --backend gemini." };
  const version = spawnSync(found, ["--version"], { encoding: "utf8", timeout: 15000 }).stdout?.trim();
  const home = process.env.GEMINI_CLI_HOME || os.homedir();
  const settings = readJson(path.join(home, ".gemini", "settings.json"), {});
  const selected = settings?.security?.auth?.selectedType || null;
  const envKey = Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_USE_VERTEXAI);
  const ready = selected ? GEMINI_HEADLESS_AUTH.includes(selected) : envKey;
  return {
    ready,
    path: found,
    version,
    detail: ready ? `auth ${selected || "from environment"}` : `auth "${selected || "none"}" cannot be used headless`,
    next: ready ? null : "Optional: run `! gemini`, choose \"Login with Google\" (uses your Google account, no API key), then rerun setup."
  };
}

function cmdSetup(args) {
  const { opts } = parseFlags(splitArgs(args), { flags: ["json", "enable-review-gate", "disable-review-gate"], anywhere: true });
  if (opts["enable-review-gate"] && opts["disable-review-gate"]) fail("Choose only one of --enable-review-gate and --disable-review-gate.");
  const dir = stateDir(workspaceRoot(process.cwd()));
  const config = loadConfig(dir);
  const actions = [];
  if (opts["enable-review-gate"] || opts["disable-review-gate"]) {
    config.stopReviewGate = Boolean(opts["enable-review-gate"]);
    saveConfig(dir, config);
    actions.push(`Stop review gate ${config.stopReviewGate ? "enabled" : "disabled"} for this repository.`);
  }
  const agy = checkAgy();
  const gemini = checkGemini();
  const report = {
    ready: agy.ready || gemini.ready,
    node: process.version,
    agy,
    gemini,
    defaultBackend: resolveBackend(),
    defaultModel: resolveModel("agy", null, null),
    stopReviewGate: config.stopReviewGate,
    actions,
    nextSteps: [agy.next, gemini.next].filter(Boolean)
  };
  if (opts.json) return void process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  const argon = agy.models ? agy.models.filter((m) => m.startsWith("gemini-4")).join(", ") : "";
  const out = [
    `Antigravity companion: ${report.ready ? "ready" : "not ready"}`,
    `- Node ${report.node}`,
    `- agy: ${agy.detail}${agy.version ? ` (v${agy.version})` : ""}${argon ? ` · ${argon}` : ""}`,
    `- gemini: ${gemini.detail}${gemini.version ? ` (v${gemini.version})` : ""}`,
    `- Default: ${report.defaultBackend} · ${report.defaultModel}`,
    `- Stop review gate: ${config.stopReviewGate ? "on" : "off"}`,
    ...actions.map((a) => `- ${a}`)
  ];
  if (report.nextSteps.length) out.push("", "Next steps:", ...report.nextSteps.map((s) => `- ${s}`));
  process.stdout.write(out.join("\n") + "\n");
}

function cmdResumeCandidate(args) {
  const { opts } = parseFlags(splitArgs(args), { flags: ["json"], values: ["backend"], anywhere: true });
  const dir = stateDir(workspaceRoot(process.cwd()));
  const job = resumeCandidate(dir, resolveBackend(opts.backend));
  const payload = job
    ? { available: true, candidate: { id: job.id, summary: job.summary, conversationId: job.result.conversationId, completedAt: job.completedAt } }
    : { available: false };
  process.stdout.write(JSON.stringify(payload) + "\n");
}

async function cmdWorker([dir, id]) {
  const job = loadJob(dir, id);
  if (!job || job.status !== "queued") return;
  process.chdir(job.cwd);
  await executeJob(dir, job);
}

function readStdinJson() {
  try {
    const raw = fs.readFileSync(0, "utf8").trim();
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function hookSessionStart() {
  const input = readStdinJson();
  const envFile = process.env.CLAUDE_ENV_FILE;
  if (!envFile) return;
  const lines = [];
  if (input.session_id) lines.push(`export ${SESSION_ENV}=${shellQuote(input.session_id)}`);
  if (process.env[DATA_ENV]) lines.push(`export ${DATA_ENV}=${shellQuote(process.env[DATA_ENV])}`);
  if (lines.length) fs.appendFileSync(envFile, lines.join("\n") + "\n");
}

function hookSessionEnd() {
  const input = readStdinJson();
  if (!input.session_id) return;
  const dir = stateDir(workspaceRoot(input.cwd || process.cwd()));
  for (const job of listJobs(dir)) {
    if (job.sessionId !== input.session_id || !isActive(job)) continue;
    job.status = "cancelled";
    job.completedAt = new Date().toISOString();
    job.rendered = `${job.title} was cancelled because the Claude session ended.`;
    saveJob(dir, job);
    terminate(job.pid);
  }
}

async function hookStop() {
  const input = readStdinJson();
  const cwd = input.cwd || process.cwd();
  const root = workspaceRoot(cwd);
  const dir = stateDir(root);
  if (!loadConfig(dir).stopReviewGate || input.stop_hook_active) return;
  let target;
  try {
    target = collectTarget(root, { scope: "working-tree" });
  } catch {
    return;
  }
  if (!target.diff.trim()) return;
  if (input.session_id) process.env[SESSION_ENV] = input.session_id;
  const backend = resolveBackend();
  const { job } = createJob(root, {
    kind: "stop-gate",
    title: "Antigravity stop gate",
    summary: "Stop-time review of the last Claude turn",
    target: target.label,
    backend,
    model: resolveModel(backend, null, null),
    effort: null,
    write: false,
    request: {
      prompt: fillTemplate("stop-review-gate", { CLAUDE_MESSAGE: input.last_assistant_message || "(not provided)", INPUT: target.diff }),
      timeout: "13m"
    }
  });
  const done = await executeJob(dir, job);
  const text = (done.result?.text || "").trim();
  const first = text.split("\n").find((l) => l.trim()) || "";
  if (/^BLOCK:/.test(first.trim())) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: `Antigravity stop gate found issues to fix before stopping: ${first.trim().slice(6).trim()}` }) + "\n");
    return;
  }
  if (!/^ALLOW:/.test(first.trim())) {
    process.stdout.write(JSON.stringify({ systemMessage: `Antigravity stop gate did not give a verdict (${done.error || "unexpected answer"}); stopping anyway. Run /antigravity:review to check manually.` }) + "\n");
  }
}

async function main() {
  const [sub, ...args] = process.argv.slice(2);
  if (sub?.startsWith("hook-") && process.env.CLAUDE_PLUGIN_DATA) process.env[DATA_ENV] = process.env.CLAUDE_PLUGIN_DATA;
  switch (sub) {
    case "task":
      return cmdTask(args);
    case "review":
    case "adversarial-review":
      return cmdReview(sub, args);
    case "status":
      return cmdStatus(args);
    case "result":
      return cmdResult(args);
    case "cancel":
      return cmdCancel(args);
    case "setup":
      return cmdSetup(args);
    case "resume-candidate":
      return cmdResumeCandidate(args);
    case "worker":
      return cmdWorker(args);
    case "hook-session-start":
      return hookSessionStart();
    case "hook-session-end":
      return hookSessionEnd();
    case "hook-stop":
      return hookStop();
    default:
      fail("Usage: companion.mjs <task|review|adversarial-review|status|result|cancel|setup> [options]");
  }
}

function plainLinks(text) {
  return text.replace(/\[([^\]]+)\]\(file:\/\/([^)#]+)(?:#L(\d+)(?:-L(\d+))?)?\)/g, (all, label, file, from, to) => {
    const name = path.basename(decodeURIComponent(file));
    const where = from ? `${name}:${from}${to && to !== from ? `-${to}` : ""}` : name;
    return label.replace(/`/g, "") === name || label.replace(/`/g, "") === where ? `\`${where}\`` : `${label} (\`${where}\`)`;
  });
}

main().catch((err) => {
  process.stderr.write(`${err instanceof UserError ? err.message : err.stack || err}\n`);
  process.exitCode = 1;
});
