# Claude Worker for Codex

An unofficial, dependency-free bridge for running bounded local Claude Code jobs from Codex. It is not affiliated with, endorsed by, or supported by Anthropic or OpenAI.

## Requirements

- Claude Code installed locally and signed in.
- Codex installed and signed in.
- Node.js 18 or newer.

## Install

From the public GitHub marketplace:

```sh
codex plugin marketplace add KylinMountain/claude-worker-for-codex --ref main
codex plugin add claude-worker@claude-worker-for-codex
```

Start a new Codex thread after installation so it loads the skill.

## Defaults and configuration

Jobs invoke Claude Code with `opus`, permission mode `auto`, stream JSON input/output, verbose output, and `safe-mode`. Configuration precedence is:

```text
CLI flags > supported environment variables > built-in defaults
```

The supported environment variables are `CLAUDE_WORKER_HOME` for the private job store, plus `CLAUDE_WORKER_MODEL` and `CLAUDE_WORKER_PERMISSION_MODE`. Explicit `--model` and `--permission-mode` flags override those environment values:

```sh
CLAUDE_WORKER_HOME=/tmp/claude-worker \
  CLAUDE_WORKER_MODEL=sonnet CLAUDE_WORKER_PERMISSION_MODE=plan \
  node plugins/claude-worker/scripts/claude-worker.js run \
  --cwd /absolute/workspace \
  --task "Inspect the failing test and report a minimal fix"
```

There is no hidden config file or third-party dependency.

## Commands

Run from the repository root, or replace the script path with its installed path:

```sh
node plugins/claude-worker/scripts/claude-worker.js check
node plugins/claude-worker/scripts/claude-worker.js run --cwd /absolute/workspace --task "..."
node plugins/claude-worker/scripts/claude-worker.js status [JOB_ID]
node plugins/claude-worker/scripts/claude-worker.js result JOB_ID
node plugins/claude-worker/scripts/claude-worker.js resume JOB_ID --task "..."
node plugins/claude-worker/scripts/claude-worker.js cancel JOB_ID
```

`check` is the health check command. `run` and `resume` require an absolute `--cwd` (resume reuses the prior job's cwd) and exactly one task text or absolute `--task-file`. `status` lists jobs when no ID is supplied.

## Optional Leader policy

This repository does not modify a user's global instructions. A team may explicitly opt in by adding a policy like this to its own `AGENTS.md`:

```md
For behavior changes, new features, bug fixes, and cross-file implementation, the Leader may invoke the installed claude-worker skill for a bounded local Claude Code job. Claude is a bridge-executed worker, not a native collaboration agent. Keep one writing agent per workspace, retain Terra review, and resume the original job for rework.
```

## Safety boundary

The default `safe-mode` avoids loading project customizations such as `CLAUDE.md`, hooks, MCP servers, and skills. Additional deny rules cover common `git push`, `gh pr merge`, deployment, publishing, and infrastructure commands, including several wrapper and `git -C`/`git -c` forms. These are defense-in-depth controls, not a complete security boundary; review tasks, permissions, logs, and resulting changes. The bridge does not automate push, merge, deploy, commit, install, or publish actions.

Job state, stdout, stderr, and result files stay in the private job store. Do not place credentials or other secrets in task text or checked-in files.
