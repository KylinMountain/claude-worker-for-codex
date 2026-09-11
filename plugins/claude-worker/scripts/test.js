#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ENTRY = path.join(__dirname, 'claude-worker.js');
const SESSION_ID = 'fixture-session';

function envFor(root, extra = {}) {
  return {
    ...process.env,
    CLAUDE_WORKER_MODEL: undefined,
    CLAUDE_WORKER_PERMISSION_MODE: undefined,
    ...extra,
    CLAUDE_WORKER_HOME: path.join(root, 'store'),
  };
}

function call(root, args, extra = {}) {
  return JSON.parse(execFileSync(process.execPath, [ENTRY, ...args], {
    env: envFor(root, extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
}

function failedCall(root, args, extra = {}) {
  try { call(root, args, extra); assert.fail('command should fail'); }
  catch (error) { return `${error.stdout || ''}${error.stderr || ''}`; }
}

async function waitFor(root, id, wanted) {
  for (let i = 0; i < 100; i += 1) {
    const state = call(root, ['status', id]);
    if (wanted.includes(state.status)) return state;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`job ${id} did not reach ${wanted.join('/')}`);
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'claude-worker-test-'));
  const fakeBin = path.join(root, 'bin');
  await fsp.mkdir(fakeBin);
  const fake = path.join(fakeBin, 'claude');
  await fsp.writeFile(fake, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(process.env.FAKE_CAPTURE, JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => setTimeout(() => {
  if (process.env.FAKE_MODE === 'fail') process.exit(23);
  process.stdout.write(JSON.stringify({type:'system', session_id:'${SESSION_ID}'}) + '\\n');
  process.stdout.write(JSON.stringify({type:'result', result:'READY', is_error:false}) + '\\n');
}, Number(process.env.FAKE_DELAY || 0)));
`, { mode: 0o700 });
  const fakeEnv = { PATH: `${fakeBin}:${process.env.PATH}`, FAKE_CAPTURE: path.join(root, 'argv.json') };

  const hookMarker = path.join(root, 'hook-ran');
  const cwd = path.join(root, 'workspace');
  await fsp.mkdir(path.join(cwd, '.claude'), { recursive: true });
  await fsp.writeFile(path.join(cwd, '.claude', 'settings.json'), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `touch ${hookMarker}` }] }] },
  }));

  const normal = call(root, ['run', '--cwd', cwd, '--task', 'normal'], fakeEnv);
  let state = call(root, ['status', normal.id]);
  assert.notEqual(state.status, 'queued');
  state = await waitFor(root, normal.id, ['completed']);
  const argv = JSON.parse(await fsp.readFile(fakeEnv.FAKE_CAPTURE, 'utf8'));
  assert(argv.includes('--safe-mode'));
  assert(argv.includes('--input-format') && argv.includes('stream-json'));
  assert(argv.includes('--output-format') && argv.includes('stream-json'));
  assert(argv.includes('--model') && argv.includes('opus'));
  assert(argv.includes('--permission-mode') && argv.includes('auto'));
  for (const denied of [
    'Bash(git push *)', 'Bash(git -C * push *)', 'Bash(git -c * push *)',
    'Bash(env * git push *)', 'Bash(command git push *)', 'Bash(sudo git push *)',
    'Bash(gh pr merge *)', 'Bash(env * gh pr merge *)',
    'Bash(command gh pr merge *)', 'Bash(sudo gh pr merge *)',
  ]) assert(argv.includes(denied), denied);
  assert.equal(state.session_id, SESSION_ID);
  assert.equal(JSON.parse(execFileSync(process.execPath, [ENTRY, 'result', normal.id], { env: envFor(root), encoding: 'utf8' })).result, 'READY');
  assert.equal(fs.existsSync(hookMarker), false);

  const help = execFileSync(process.execPath, [ENTRY, '--help'], { env: envFor(root), encoding: 'utf8' });
  for (const command of ['check', 'run', 'status', 'result', 'resume', 'cancel']) {
    assert.match(help, new RegExp(`claude-worker ${command}`), command);
  }
  assert.doesNotMatch(help, /doctor/);
  assert.match(help, /CLAUDE_WORKER_MODEL/);
  assert.match(help, /CLAUDE_WORKER_PERMISSION_MODE/);
  assert.match(failedCall(root, ['doctor'], fakeEnv), /unknown command: doctor/);

  const checkCapture = { FAKE_CAPTURE: path.join(root, 'argv-check.json') };
  const checked = call(root, ['check'], { ...fakeEnv, ...checkCapture });
  assert.equal(checked.claude, true);
  assert.equal(checked.model, 'opus');
  assert.equal(checked.permission_mode, 'auto');
  const checkedEnv = call(root, ['check'], {
    ...fakeEnv, ...checkCapture, CLAUDE_WORKER_MODEL: 'sonnet', CLAUDE_WORKER_PERMISSION_MODE: 'plan',
  });
  assert.equal(checkedEnv.model, 'sonnet');
  assert.equal(checkedEnv.permission_mode, 'plan');
  assert.match(
    failedCall(root, ['check'], { ...fakeEnv, ...checkCapture, CLAUDE_WORKER_PERMISSION_MODE: 'bypassPermissions' }),
    /refusing bypass-style permission mode/,
  );

  /* Explicit flag > environment variable > built-in default, for both run and resume. */
  const settingsCases = [
    { command: 'run', args: [], env: {}, model: 'opus', mode: 'auto' },
    {
      command: 'run', args: [],
      env: { CLAUDE_WORKER_MODEL: 'sonnet', CLAUDE_WORKER_PERMISSION_MODE: 'acceptEdits' },
      model: 'sonnet', mode: 'acceptEdits',
    },
    {
      command: 'run', args: ['--model', 'haiku', '--permission-mode', 'plan'],
      env: { CLAUDE_WORKER_MODEL: 'sonnet', CLAUDE_WORKER_PERMISSION_MODE: 'acceptEdits' },
      model: 'haiku', mode: 'plan',
    },
    {
      command: 'resume', args: [],
      env: { CLAUDE_WORKER_MODEL: 'sonnet', CLAUDE_WORKER_PERMISSION_MODE: 'acceptEdits' },
      model: 'sonnet', mode: 'acceptEdits',
    },
    {
      command: 'resume', args: ['--model', 'haiku'],
      env: { CLAUDE_WORKER_MODEL: 'sonnet' },
      model: 'haiku', mode: 'auto',
    },
  ];
  for (const [index, testCase] of settingsCases.entries()) {
    const capture = path.join(root, `argv-settings-${index}.json`);
    const head = testCase.command === 'run' ? ['run', '--cwd', cwd] : ['resume', normal.id];
    const job = call(root, [...head, '--task', 'settings', ...testCase.args], {
      ...fakeEnv, ...testCase.env, FAKE_CAPTURE: capture,
    });
    const settled = await waitFor(root, job.id, ['completed']);
    assert.equal(settled.model, testCase.model, `${testCase.command}/${index} state model`);
    assert.equal(settled.permission_mode, testCase.mode, `${testCase.command}/${index} state mode`);
    const settingsArgv = JSON.parse(await fsp.readFile(capture, 'utf8'));
    assert.equal(settingsArgv[settingsArgv.indexOf('--model') + 1], testCase.model, `${testCase.command}/${index} argv model`);
    assert.equal(settingsArgv[settingsArgv.indexOf('--permission-mode') + 1], testCase.mode, `${testCase.command}/${index} argv mode`);
  }

  /* Empty values and bypass-style permission modes are rejected before any job is created. */
  const beforeRejections = (await fsp.readdir(path.join(root, 'store', 'jobs'))).length;
  for (const [pattern, args, env] of [
    [/unsupported permission mode: nonsense/, ['--permission-mode', 'nonsense'], {}],
    [/unsupported permission mode: nonsense/, [], { CLAUDE_WORKER_PERMISSION_MODE: 'nonsense' }],
    [/refusing bypass-style permission mode: bypassPermissions/, ['--permission-mode', 'bypassPermissions'], {}],
    [/refusing bypass-style permission mode: bypassPermissions/, [], { CLAUDE_WORKER_PERMISSION_MODE: 'bypassPermissions' }],
    [/refusing bypass-style permission mode/, ['--permission-mode', 'dangerously-skip-permissions'], {}],
    [/refusing bypass-style permission mode/, [], { CLAUDE_WORKER_PERMISSION_MODE: 'dangerouslySkipPermissions' }],
    [/--permission-mode must not be empty/, ['--permission-mode', '   '], {}],
    [/--model must not be empty/, ['--model', '   '], {}],
    [/CLAUDE_WORKER_PERMISSION_MODE must not be empty/, [], { CLAUDE_WORKER_PERMISSION_MODE: '' }],
    [/CLAUDE_WORKER_PERMISSION_MODE must not be empty/, [], { CLAUDE_WORKER_PERMISSION_MODE: '   ' }],
    [/CLAUDE_WORKER_MODEL must not be empty/, [], { CLAUDE_WORKER_MODEL: '' }],
    [/CLAUDE_WORKER_MODEL must not be empty/, [], { CLAUDE_WORKER_MODEL: '\t' }],
  ]) {
    assert.match(failedCall(root, ['run', '--cwd', cwd, '--task', 'reject', ...args], { ...fakeEnv, ...env }), pattern);
  }
  assert.equal((await fsp.readdir(path.join(root, 'store', 'jobs'))).length, beforeRejections);

  const failed = call(root, ['run', '--cwd', cwd, '--task', 'fail'], { ...fakeEnv, FAKE_MODE: 'fail' });
  state = await waitFor(root, failed.id, ['failed']);
  assert.notEqual(state.status, 'queued');

  /* Resume starts a new job that reattaches to the original Claude session, end to end. */
  const resumeCapture = path.join(root, 'argv-resume.json');
  const resumed = call(root, ['resume', normal.id, '--task', 'resume'], { ...fakeEnv, FAKE_CAPTURE: resumeCapture });
  assert.notEqual(resumed.id, normal.id);
  state = await waitFor(root, resumed.id, ['completed']);
  const resumeArgv = JSON.parse(await fsp.readFile(resumeCapture, 'utf8'));
  const resumeFlag = resumeArgv.indexOf('--resume');
  assert.notEqual(resumeFlag, -1, 'resume must pass --resume to Claude Code');
  assert.equal(resumeArgv[resumeFlag + 1], SESSION_ID);
  assert(resumeArgv.includes(`claude-worker-${resumed.id}`));
  assert.equal(argv.includes('--resume'), false);
  assert.equal(state.resume_from, SESSION_ID);
  assert.equal(state.session_id, SESSION_ID);
  assert.equal(call(root, ['result', resumed.id]).result, 'READY');

  const corrupt = `${Date.now().toString(36)}-corrupt`;
  const corruptDir = path.join(root, 'store', 'jobs', corrupt);
  await fsp.mkdir(corruptDir, { recursive: true });
  await fsp.writeFile(path.join(corruptDir, 'job.json'), '{bad json');
  assert.match(failedCall(root, ['resume', corrupt, '--task', 'x'], fakeEnv), /Unexpected token|JSON/);

  for (const [suffix, extra] of [['job-id', { worker_job_id: 'different-job' }], ['pgid', { pgid: 999999 }]]) {
    const sentinel = spawn('sleep', ['30']);
    const mismatch = `${Date.now().toString(36)}-${suffix}`;
    const mismatchDir = path.join(root, 'store', 'jobs', mismatch);
    await fsp.mkdir(mismatchDir, { recursive: true });
    await fsp.writeFile(path.join(mismatchDir, 'job.json'), JSON.stringify({
      id: mismatch, status: 'running', cwd, pid: sentinel.pid, pgid: sentinel.pid,
      worker_script: ENTRY, worker_job_id: mismatch, ...extra,
    }));
    assert.match(failedCall(root, ['cancel', mismatch]), /refusing to signal/);
    process.kill(sentinel.pid, 0);
    sentinel.kill('SIGTERM');
  }

  const slow = call(root, ['run', '--cwd', cwd, '--task', 'cancel'], { ...fakeEnv, FAKE_DELAY: '1000' });
  await waitFor(root, slow.id, ['running']);
  assert.equal(call(root, ['cancel', slow.id]).status, 'cancelled');
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal(call(root, ['status', slow.id]).status, 'cancelled');

  const crashed = call(root, ['run', '--cwd', cwd, '--task', 'crash-lock'], {
    ...fakeEnv, NODE_ENV: 'test', FAKE_DELAY: '5000', CLAUDE_WORKER_TEST_HOLD_LOCK_MS: '5000',
  });
  state = await waitFor(root, crashed.id, ['running']);
  for (let i = 0; i < 40 && (!state.claude_pid || !fs.existsSync(path.join(root, 'store', 'jobs', crashed.id, '.lock'))); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
    state = call(root, ['status', crashed.id]);
  }
  assert(state.claude_pid);
  assert(fs.existsSync(path.join(root, 'store', 'jobs', crashed.id, '.lock')));
  const crashedPid = state.pid;
  const owner = JSON.parse(await fsp.readFile(path.join(root, 'store', 'jobs', crashed.id, '.lock', 'owner.json'), 'utf8'));
  assert.equal(owner.pid, crashedPid);
  assert.equal(owner.job_id, crashed.id);
  assert(owner.token && owner.created_at && owner.worker_script === ENTRY);
  const crashedClaudePid = state.claude_pid;
  process.kill(crashedPid, 'SIGKILL');
  await new Promise(resolve => setTimeout(resolve, 100));
  process.kill(crashedClaudePid, 0);
  const recovered = call(root, ['cancel', crashed.id]);
  assert.equal(recovered.status, 'cancelled');
  assert.equal(fs.existsSync(path.join(root, 'store', 'jobs', crashed.id, '.lock')), false);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.throws(() => process.kill(crashedClaudePid, 0), /ESRCH/);
  console.log('claude-worker tests passed');
}

main().catch(error => { console.error(error.stack || error.message); process.exitCode = 1; });
