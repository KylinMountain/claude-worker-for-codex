---
name: claude-worker
description: Use the local Claude Worker bridge to run, inspect, resume, or cancel bounded implementation tasks on a local Claude Code job. Use when an engineering leader delegates a code behavior change to Claude Code, or when the user explicitly asks to configure AGENTS instructions or a leader orchestration workflow around this bridge.
---

# Claude Worker

An unofficial bridge to the Claude Code CLI installed on this machine. It is not affiliated with, endorsed by, or supported by Anthropic or OpenAI.

Use this skill when the engineering leader explicitly delegates a code behavior change, new feature, bug fix, or cross-file implementation to Claude Code. It is a delegation bridge, not a code reviewer: an independent reviewer remains responsible for reviewing the diff.

## Running a task

Before starting, send Claude a compact task envelope containing the goal, scope, constraints, acceptance criteria, known evidence, and required verification. Require an absolute workspace `cwd` and exactly one of task text or an absolute task file.

```text
node <plugin>/scripts/claude-worker.js check
node <plugin>/scripts/claude-worker.js run --cwd /absolute/workspace --task "..."
node <plugin>/scripts/claude-worker.js status [<job-id>]
node <plugin>/scripts/claude-worker.js result <job-id>
node <plugin>/scripts/claude-worker.js resume <job-id> --task "..."
node <plugin>/scripts/claude-worker.js cancel <job-id>
```

`check` reports whether the Claude Code CLI is reachable, the job store path, and the resolved model and permission mode.

## Defaults and settings

Defaults are Claude Code `opus` with permission mode `auto`, stream JSON input/output, verbose output, `--safe-mode`, and explicit deny rules for git push, `gh pr merge`, and common deployment or publishing commands.

Model and permission mode resolve in this order: the explicit `--model` / `--permission-mode` flag, then the optional `CLAUDE_WORKER_MODEL` / `CLAUDE_WORKER_PERMISSION_MODE` environment variables, then `opus` / `auto`. Empty values are rejected, and bypass or dangerously-skip permission modes are always refused. Safe mode plus deny rules are defense in depth, not a complete security boundary; review the task and resulting commands.

Keep one writing agent per workspace. When a reviewer requires changes, `resume` the original job instead of starting a new one. If Claude encounters an ambiguity that changes the result, or the same path fails twice, stop and return a structured handoff: conclusion, key results, modified files, tests and results, risks/blockers, and any decision needed from the leader.

Jobs live under `$CLAUDE_WORKER_HOME/jobs` or `~/.claude-worker/jobs`. Job records contain IDs, paths, process/session metadata, status, logs, and the final result. Do not put credentials or secrets in task text, environment variables, or checked-in files.

## Configuring a leader workflow (opt-in only)

Read `references/leader-workflow.md` only when the user explicitly asks to set up or update AGENTS instructions or a leader orchestration workflow for this bridge. Skip it during normal implementation work.

When that is asked for:

- Keep every rule already in the user's AGENTS file. The template is additive, and the user's rules win on conflict.
- Never overwrite an AGENTS file, and never create or edit one unprompted.
- Show the proposed additions and get confirmation before writing.
- Adapt role names, routing, and paths to the user's setup; the template is deliberately generic.
