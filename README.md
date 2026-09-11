# Claude Worker for Codex

**Orchestrate with GPT-5.6 Sol or GPT-6 Astra. Execute with Claude Code.**

[中文文档](README.zh-CN.md)

Claude Worker for Codex is an unofficial, dependency-free local CLI bridge. It lets a Codex engineering leader start, inspect, resume, and cancel bounded jobs in the Claude Code CLI already installed on the same machine. It is not affiliated with, endorsed by, or supported by OpenAI or Anthropic.

## Two model roles

- **Codex Leader:** choose `gpt-5.6-sol` or `gpt-6-astra` in Codex for planning, delegation, review, and acceptance. The plugin does not switch Codex's main model. See the [GPT-5.6 Sol documentation](https://developers.openai.com/api/docs/models/gpt-5.6-sol) and [GPT-6 Astra latest-model guide](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra).
- **Claude Code worker:** the local CLI process that implements the delegated task. `CLAUDE_WORKER_MODEL` or `--model` selects `opus`, `sonnet`, or an exact Claude model ID. This is a worker model setting, not a Codex model setting.

The bridge is not a native subagent system. A typical workflow is:

```text
Codex Leader → local Claude Code worker → independent reviewer
             → resume the original job if rework is needed → Leader acceptance
```

This separation is useful when a leader needs a focused implementation context, durable job state, resumable sessions, and an independent review boundary without adding a daemon, MCP server, or web UI.

## Features

- Background `run` and session-preserving `resume` jobs.
- Durable status, PID/session metadata, stdout, stderr, and result files.
- `check`, `status`, `result`, and process-group `cancel` commands.
- Absolute workspace and task-file validation.
- No third-party runtime dependencies, automatic commits, pushes, merges, deployments, or publishing.

## Requirements

- Claude Code installed locally and signed in.
- Codex installed and signed in.
- Node.js 18 or newer.

## Install

Add the public Git marketplace, then install the plugin:

```sh
codex plugin marketplace add KylinMountain/claude-worker-for-codex --ref main
codex plugin add claude-worker@claude-worker-for-codex
```

Start a new Codex thread after installation so the skill is loaded.

## Quick start

```sh
node plugins/claude-worker/scripts/claude-worker.js check
node plugins/claude-worker/scripts/claude-worker.js run \
  --cwd /path/to/workspace \
  --task "Inspect the failing test and implement the smallest fix"
```

The command returns a job ID immediately after the worker startup handshake:

```sh
node plugins/claude-worker/scripts/claude-worker.js status JOB_ID
node plugins/claude-worker/scripts/claude-worker.js result JOB_ID
```

For reviewer-requested rework, continue the same Claude session:

```sh
node plugins/claude-worker/scripts/claude-worker.js resume JOB_ID \
  --task "Apply the review fixes, rerun the required tests, and report the result"
```

## Commands

```text
check
run --cwd ABSOLUTE_DIR (--task TEXT | --task-file ABSOLUTE_FILE)
status [JOB_ID]
result JOB_ID
resume JOB_ID (--task TEXT | --task-file ABSOLUTE_FILE)
cancel JOB_ID
```

`run` requires an existing absolute `--cwd` and exactly one task input. `resume` reuses the original job's workspace and session. `status` lists all jobs when no ID is supplied. `cancel` only signals a verified job process group.

## Configuration

Settings resolve from highest to lowest priority: explicit CLI flag, supported environment variable, built-in default.

| Setting | CLI flag | Environment variable | Default |
| --- | --- | --- | --- |
| Claude worker model | `--model` | `CLAUDE_WORKER_MODEL` | `opus` |
| Permission mode | `--permission-mode` | `CLAUDE_WORKER_PERMISSION_MODE` | `auto` |
| Private job store | — | `CLAUDE_WORKER_HOME` | user-local `.claude-worker` directory |

Example:

```sh
CLAUDE_WORKER_MODEL=sonnet \
CLAUDE_WORKER_PERMISSION_MODE=plan \
node plugins/claude-worker/scripts/claude-worker.js run \
  --cwd /path/to/workspace --task "Review the migration"
```

Adding `--model opus --permission-mode auto` to that command overrides the environment values. Bypass-style permission modes are rejected.

## Optional Leader policy

The plugin does not modify a user's global instructions. Teams may explicitly opt in by adapting this template in their own `AGENTS.md`:

```md
For behavior changes, new features, bug fixes, and cross-file implementation, the Leader may invoke the installed claude-worker skill for a bounded local Claude Code job. Claude is a bridge-executed worker, not a native collaboration agent. Keep one writing agent per workspace, retain independent review, and resume the original job for rework before Leader acceptance.
```

If Claude Code is unavailable, route the task to a general worker. Keep non-code or mechanical work on the general-worker path when that is the better fit.

## Safety boundary

The default `safe-mode` avoids loading project customizations such as `CLAUDE.md`, hooks, MCP servers, and skills. Deny rules cover common `git push`, `gh pr merge`, deployment, publishing, and infrastructure commands, including several wrapper and `git -C`/`git -c` forms. These controls are defense in depth, not a complete security boundary: review the task, permissions, logs, and resulting changes. The bridge does not automate push, merge, deploy, commit, install, or publish actions.

Job state, stdout, stderr, and result files stay in the private job store. Do not place credentials or other secrets in task text or checked-in files.

## License

MIT. See [LICENSE](LICENSE).
