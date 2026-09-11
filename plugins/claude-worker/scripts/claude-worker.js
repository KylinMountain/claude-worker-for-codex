#!/usr/bin/env node
/* Local, dependency-free bridge between Codex and Claude Code. */
'use strict';

const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const DEFAULT_MODEL = 'opus';
const DEFAULT_PERMISSION_MODE = 'auto';
const VALID_PERMISSION_MODES = new Set(['acceptEdits', 'auto', 'manual', 'dontAsk', 'plan']);
const UNSAFE_PERMISSION_MODE_RE = /bypass|dangerous|skip-permission/i;
const MODEL_ENV = 'CLAUDE_WORKER_MODEL';
const PERMISSION_MODE_ENV = 'CLAUDE_WORKER_PERMISSION_MODE';
const JOB_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const DISALLOWED_TOOLS = [
  'Bash(git push)',
  'Bash(git push *)',
  'Bash(git -C * push)',
  'Bash(git -C * push *)',
  'Bash(git -c * push)',
  'Bash(git -c * push *)',
  'Bash(command git push *)',
  'Bash(env * git push *)',
  'Bash(sudo git push *)',
  'Bash(gh pr merge)',
  'Bash(gh pr merge *)',
  'Bash(command gh pr merge *)',
  'Bash(env * gh pr merge *)',
  'Bash(sudo gh pr merge *)',
  'Bash(vercel *)',
  'Bash(netlify *)',
  'Bash(npm publish *)',
  'Bash(pnpm publish *)',
  'Bash(yarn publish *)',
  'Bash(terraform apply *)',
  'Bash(terraform destroy *)',
  'Bash(kubectl apply *)',
  'Bash(kubectl delete *)',
  'Bash(docker push *)',
];
const SAFETY_PROMPT = [
  'Default safety policy: do not run git push (including --force), gh pr merge, or deployment/publishing/destructive infrastructure commands.',
  'Do not commit, deploy, publish, or change remote state unless the user explicitly asks in this task.',
  'If the task is materially ambiguous, or the same operation fails twice, stop and report the issue instead of guessing.',
].join(' ');

function storeRoot() {
  const configured = process.env.CLAUDE_WORKER_HOME;
  const root = configured ? path.resolve(configured) : path.join(os.homedir(), '.claude-worker');
  if (!path.isAbsolute(root)) throw new Error('CLAUDE_WORKER_HOME must be an absolute path');
  return root;
}

function jobsRoot() { return path.join(storeRoot(), 'jobs'); }
function jobDir(id) { validateJobId(id); return path.join(jobsRoot(), id); }
function statePath(id) { return path.join(jobDir(id), 'job.json'); }
function now() { return new Date().toISOString(); }

function fail(message, code = 2) {
  console.error(`claude-worker: ${message}`);
  process.exitCode = code;
}

function validateJobId(id) {
  if (typeof id !== 'string' || !JOB_ID_RE.test(id)) throw new Error('invalid job id');
  return id;
}

function validatePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid > 4194304) throw new Error('invalid pid');
  return pid;
}

function validateCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) throw new Error('--cwd must be an absolute path');
  const resolved = path.resolve(cwd);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) throw new Error('--cwd must be an existing directory');
  return resolved;
}

function readOptions(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const key = arg.slice(2);
    if (key === 'help') { out.help = true; continue; }
    if (!['cwd', 'task', 'task-file', 'model', 'permission-mode', 'job-id'].includes(key)) throw new Error(`unknown option --${key}`);
    const value = argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    out[key] = value;
  }
  return out;
}

/* Resolution order is explicit flag, then environment variable, then built-in default. */
function resolveSetting(flagValue, envName, fallback, label) {
  if (typeof flagValue === 'string') {
    const value = flagValue.trim();
    if (!value) throw new Error(`--${label} must not be empty`);
    return value;
  }
  const fromEnv = process.env[envName];
  if (typeof fromEnv === 'string') {
    const value = fromEnv.trim();
    if (!value) throw new Error(`${envName} must not be empty`);
    return value;
  }
  return fallback;
}

function resolveModel(flagValue) {
  return resolveSetting(flagValue, MODEL_ENV, DEFAULT_MODEL, 'model');
}

function resolvePermissionMode(flagValue) {
  const mode = resolveSetting(flagValue, PERMISSION_MODE_ENV, DEFAULT_PERMISSION_MODE, 'permission-mode');
  if (UNSAFE_PERMISSION_MODE_RE.test(mode)) throw new Error(`refusing bypass-style permission mode: ${mode}`);
  if (!VALID_PERMISSION_MODES.has(mode)) throw new Error(`unsupported permission mode: ${mode}`);
  return mode;
}

async function taskFrom(options) {
  const hasText = typeof options.task === 'string';
  const hasFile = typeof options['task-file'] === 'string';
  if (hasText === hasFile) throw new Error('provide exactly one of --task or --task-file');
  if (hasText && !options.task.trim()) throw new Error('--task must not be empty');
  if (hasFile) {
    const file = options['task-file'];
    if (!path.isAbsolute(file)) throw new Error('--task-file must be an absolute path');
    const stat = await fsp.stat(file).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error('--task-file must be an existing file');
    return fsp.readFile(file, 'utf8');
  }
  return options.task;
}

async function writeJson(file, value) {
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fsp.rename(temp, file);
}

async function withStateLock(id, fn) {
  const lock = path.join(jobDir(id), '.lock');
  const owner = {
    pid: process.pid,
    job_id: id,
    token: crypto.randomUUID(),
    created_at: now(),
    worker_script: path.resolve(__filename),
  };
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fsp.mkdir(lock);
      await writeJson(path.join(lock, 'owner.json'), owner);
      try { return await fn(); } finally {
        const current = await fsp.readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
        if (current && current.token === owner.token) await fsp.rm(lock, { recursive: true, force: true });
      }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const current = await fsp.readFile(path.join(lock, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
      const alive = current && current.job_id === id && current.worker_script === path.resolve(__filename) && processIdentity(current.pid, id);
      if (!alive) {
        const quarantine = `${lock}.reclaim-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
        try {
          await fsp.rename(lock, quarantine);
          const moved = await fsp.readFile(path.join(quarantine, 'owner.json'), 'utf8').then(JSON.parse).catch(() => null);
          if (!moved || moved.token === (current && current.token)) await fsp.rm(quarantine, { recursive: true, force: true });
          else await fsp.rename(quarantine, lock).catch(() => {});
        } catch (reclaimError) { if (!['ENOENT', 'EEXIST'].includes(reclaimError.code)) throw reclaimError; }
        continue;
      }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  throw new Error('job state lock timeout');
}

async function readState(id) {
  const text = await fsp.readFile(statePath(id), 'utf8');
  return JSON.parse(text);
}

async function updateState(id, update) {
  return withStateLock(id, async () => {
    const file = statePath(id);
    const state = await readState(id);
    if (update.status === 'queued' && state.status !== 'queued') throw new Error('invalid job state transition');
    const next = { ...state, ...update, updated_at: now() };
    await writeJson(file, next);
    return next;
  });
}

function commandHelp() {
  return [
    'Usage:',
    '  claude-worker check',
    '  claude-worker run --cwd /absolute/dir (--task TEXT | --task-file /absolute/file) [--model MODEL] [--permission-mode MODE]',
    '  claude-worker status [JOB_ID]',
    '  claude-worker result JOB_ID',
    '  claude-worker resume JOB_ID (--task TEXT | --task-file /absolute/file) [--model MODEL] [--permission-mode MODE]',
    '  claude-worker cancel JOB_ID',
    '',
    `Model and permission mode resolve as: explicit flag > environment variable > default (${DEFAULT_MODEL} / ${DEFAULT_PERMISSION_MODE}).`,
    `Optional environment variables: ${MODEL_ENV}, ${PERMISSION_MODE_ENV}.`,
    'Empty values and bypass or dangerously-skip permission modes are rejected.',
    `Permission modes: ${[...VALID_PERMISSION_MODES].join(', ')}`,
    'Jobs are stored under $CLAUDE_WORKER_HOME/jobs or ~/.claude-worker/jobs.',
    '',
  ].join('\n');
}

function claudeArgs({ model, permissionMode, resumeSession, jobId }) {
  const args = ['-p', '--safe-mode', '--name', `claude-worker-${jobId}`, '--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', permissionMode, '--append-system-prompt', SAFETY_PROMPT];
  if (resumeSession) args.push('--resume', resumeSession);
  args.push('--disallowed-tools', ...DISALLOWED_TOOLS);
  return args;
}

function extractResult(events) {
  let result = null;
  let text = '';
  for (const event of events) {
    if (event && event.type === 'result') result = event;
    if (event && event.type === 'assistant' && event.message && Array.isArray(event.message.content)) {
      for (const item of event.message.content) if (item && item.type === 'text') text += item.text || '';
    }
  }
  return result || { type: 'assistant', text };
}

async function parseJsonLines(file) {
  const content = await fsp.readFile(file, 'utf8').catch(() => '');
  return content.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

async function runWorker(id, task, resumeSession) {
  let state;
  try { state = await readState(id); } catch { return; }
  if (state.status === 'cancelled') return;
  const workerScript = path.resolve(__filename);
  const pgid = processGroupId(process.pid);
  await updateState(id, {
    status: 'running', started_at: now(), pid: process.pid, pgid,
    worker_script: workerScript, worker_job_id: id,
  });
  process.stdout.write(`${JSON.stringify({ type: 'worker-ready', pid: process.pid, pgid, job_id: id })}\n`);
  const dir = jobDir(id);
  let stdoutFd;
  let stderrFd;
  let child;
  try {
    stdoutFd = fs.openSync(path.join(dir, 'stdout.log'), 'a', 0o600);
    stderrFd = fs.openSync(path.join(dir, 'stderr.log'), 'a', 0o600);
    const env = { ...process.env }; delete env.CLAUDECODE;
    child = spawn('claude', claudeArgs({ model: state.model, permissionMode: state.permission_mode, resumeSession, jobId: id }), {
      cwd: state.cwd,
      env,
      stdio: ['pipe', stdoutFd, stderrFd],
    });
  } catch (error) {
    if (stdoutFd !== undefined) fs.closeSync(stdoutFd);
    if (stderrFd !== undefined) fs.closeSync(stderrFd);
    await updateState(id, { status: 'failed', error: error.message, finished_at: now() }).catch(() => {});
    return;
  }
  await updateState(id, { claude_pid: child.pid });
  const input = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: task }] } }) + '\n';
  child.stdin.end(input);
  child.on('error', async error => {
    await updateState(id, { status: 'failed', error: error.message, finished_at: now() }).catch(() => {});
  });
  child.on('close', async (code, signal) => {
    fs.closeSync(stdoutFd); fs.closeSync(stderrFd);
    const latest = await readState(id).catch(() => state);
    if (latest.status === 'cancelled') return;
    const events = await parseJsonLines(path.join(dir, 'stdout.log'));
    const sessionEvent = events.find(event => event && event.session_id);
    const result = extractResult(events);
    await writeJson(path.join(dir, 'result.json'), result).catch(() => {});
    await updateState(id, {
      status: code === 0 ? 'completed' : 'failed',
      exit_code: code,
      signal: signal || null,
      session_id: latest.session_id || (sessionEvent && sessionEvent.session_id) || null,
      finished_at: now(),
    }).catch(() => {});
  });
  if (process.env.NODE_ENV === 'test' && process.env.CLAUDE_WORKER_TEST_HOLD_LOCK_MS) {
    const hold = Number(process.env.CLAUDE_WORKER_TEST_HOLD_LOCK_MS);
    if (Number.isFinite(hold) && hold > 0) await withStateLock(id, () => new Promise(resolve => setTimeout(resolve, hold)));
  }
}

async function createJob({ cwd, task, model, permissionMode, resumeFrom }) {
  await fsp.mkdir(jobsRoot(), { recursive: true, mode: 0o700 });
  const id = `${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`;
  const dir = jobDir(id);
  await fsp.mkdir(dir, { mode: 0o700 });
  const state = {
    id, status: 'queued', created_at: now(), updated_at: now(),
    cwd, model, permission_mode: permissionMode, pid: null, pgid: null,
    worker_script: path.resolve(__filename), worker_job_id: id, claude_pid: null,
    claude_name: `claude-worker-${id}`,
    session_id: resumeFrom || null, resume_from: resumeFrom || null,
  };
  await writeJson(statePath(id), state);
  const worker = spawn(process.execPath, [__filename, '_worker', '--job-id', id], {
    cwd: storeRoot(), detached: true, stdio: ['pipe', 'pipe', 'ignore'],
  });
  validatePid(worker.pid);
  worker.stdin.end(JSON.stringify({ task, resumeSession: resumeFrom || null }));
  await waitForWorkerReady(worker, id);
  worker.stdout.destroy();
  worker.unref();
  return id;
}

function processGroupId(pid) {
  const result = spawnSync('ps', ['-p', String(validatePid(pid)), '-o', 'pgid='], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const pgid = Number((result.stdout || '').trim());
  return Number.isSafeInteger(pgid) && pgid > 1 ? pgid : null;
}

function processIdentity(pid, id) {
  try {
    const validPid = validatePid(pid);
    const result = spawnSync('ps', ['-p', String(validPid), '-o', 'command='], { encoding: 'utf8' });
    const command = (result.stdout || '').trim();
    return result.status === 0 && command.includes(path.resolve(__filename)) && command.includes(id);
  } catch { return false; }
}

function waitForWorkerReady(worker, id) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    const timer = setTimeout(() => finish(new Error('worker startup handshake timed out')), 5000);
    worker.stdout.setEncoding('utf8');
    worker.stdout.on('data', chunk => {
      buffer += chunk;
      for (const line of buffer.split('\n').slice(0, -1)) {
        try {
          const message = JSON.parse(line);
          if (message.type === 'worker-ready' && message.job_id === id) return finish();
        } catch {}
      }
      buffer = buffer.split('\n').at(-1) || '';
    });
    worker.on('error', error => finish(error));
    worker.on('exit', (code, signal) => {
      if (!settled) finish(new Error(`worker exited before handshake (${code ?? signal})`));
    });
  });
}

function isAlive(pid) {
  try { process.kill(validatePid(pid), 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function workerIdentity(id, state) {
  try {
    if (state.worker_job_id !== id || state.worker_script !== path.resolve(__filename)) return false;
    const pid = validatePid(state.pid);
    const pgid = validatePid(state.pgid);
    if (pgid !== pid) return false;
    const result = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,pgid=,command='], { encoding: 'utf8' });
    if (result.status !== 0) return false;
    const line = (result.stdout || '').trim();
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match || Number(match[1]) !== pid || Number(match[2]) !== pgid) return false;
    const command = match[3];
    return command.includes(state.worker_script) && command.includes(`_worker --job-id ${id}`);
  } catch { return false; }
}

function groupIdentity(id, state) {
  if (!workerIdentity(id, state)) {
    if (state.pid && isAlive(state.pid)) return false;
    try {
      const pid = validatePid(state.claude_pid);
      const pgid = validatePid(state.pgid);
      const result = spawnSync('ps', ['-p', String(pid), '-o', 'pid=,pgid=,command='], { encoding: 'utf8' });
      const match = (result.stdout || '').trim().match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
      if (!match || Number(match[1]) !== pid || Number(match[2]) !== pgid) return false;
      return match[3].includes(`--name claude-worker-${id}`);
    } catch { return false; }
  }
  return true;
}

async function check() {
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  const result = { claude: probe.status === 0, version: (probe.stdout || '').trim(), store: storeRoot() };
  try {
    result.model = resolveModel(undefined);
    result.permission_mode = resolvePermissionMode(undefined);
  } catch (error) {
    result.config_error = error.message;
  }
  console.log(JSON.stringify(result, null, 2));
  if (!result.claude || result.config_error) process.exitCode = 1;
}

async function listStatus(id) {
  if (id) {
    const state = await readState(id);
    if (state.status === 'running' && state.pid && !isAlive(state.pid)) state.status = 'unknown';
    console.log(JSON.stringify(state, null, 2));
    return;
  }
  const entries = await fsp.readdir(jobsRoot(), { withFileTypes: true }).catch(() => []);
  const states = [];
  for (const entry of entries) if (entry.isDirectory() && JOB_ID_RE.test(entry.name)) {
    try { states.push(await readState(entry.name)); } catch {}
  }
  states.sort((a, b) => b.created_at.localeCompare(a.created_at));
  console.log(JSON.stringify(states, null, 2));
}

async function cancel(id) {
  let pid = null;
  let result;
  let signal = false;
  await withStateLock(id, async () => {
    const state = await readState(id);
    if (state.status === 'completed' || state.status === 'failed' || state.status === 'cancelled') {
      result = state; return;
    }
    if (!groupIdentity(id, state)) throw new Error('worker identity or process group does not match; refusing to signal');
    pid = validatePid(state.pgid);
    result = { ...state, status: 'cancelled', finished_at: now(), updated_at: now() };
    await writeJson(statePath(id), result);
    signal = true;
  });
  if (signal) {
    try { process.kill(-pid, 'SIGTERM'); } catch (error) {
      if (error.code !== 'ESRCH') throw new Error(`cancel signal failed: ${error.message}`);
    }
  }
  console.log(JSON.stringify(result, null, 2));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === '--help' || command === 'help') { console.log(commandHelp()); return; }
  if (command === '_worker') {
    const options = readOptions(rest);
    const id = validateJobId(options['job-id'] || options._[0]);
    let input = ''; process.stdin.setEncoding('utf8'); for await (const chunk of process.stdin) input += chunk;
    try {
      const payload = JSON.parse(input);
      if (typeof payload.task !== 'string') throw new Error('worker task is missing');
      await runWorker(id, payload.task, payload.resumeSession);
    } catch (error) {
      await updateState(id, { status: 'failed', error: error.message, finished_at: now() }).catch(() => {});
    }
    return;
  }
  if (command === 'check') { await check(); return; }
  if (command === 'status') { await listStatus(rest[0]); return; }
  const id = rest[0];
  if (command === 'result') {
    validateJobId(id); console.log(await fsp.readFile(path.join(jobDir(id), 'result.json'), 'utf8')); return;
  }
  if (command === 'cancel') { validateJobId(id); await cancel(id); return; }
  if (command !== 'run' && command !== 'resume') throw new Error(`unknown command: ${command}`);
  const options = readOptions(command === 'run' ? rest : rest.slice(1));
  let cwd;
  let resumeFrom = null;
  if (command === 'run') cwd = validateCwd(options.cwd);
  else {
    validateJobId(id);
    const old = await readState(id);
    cwd = validateCwd(old.cwd);
    if (!old.session_id) throw new Error('job has no session_id to resume');
    resumeFrom = old.session_id;
  }
  const task = await taskFrom(options);
  const model = resolveModel(options.model);
  const permissionMode = resolvePermissionMode(options['permission-mode']);
  console.log(JSON.stringify({ id: await createJob({ cwd, task, model, permissionMode, resumeFrom }) }));
}

main().catch(error => fail(error.message));
