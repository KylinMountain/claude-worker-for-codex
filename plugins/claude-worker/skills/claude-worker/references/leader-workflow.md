# Leader Orchestration Reference

A neutral template for teams that delegate implementation work to Claude Worker. Copy only the
parts you want into your own AGENTS file and adapt the names to your setup. Nothing here is
required by the bridge itself.

## Roles

- **Leader** — owns the plan, writes task envelopes, routes work, and integrates results. Does not
  edit the workspace while a worker holds it.
- **Claude worker** — a Claude Code job started through this bridge. Implements bounded code
  behavior changes.
- **General worker** — any other agent or subagent the leader can delegate to.
- **Reviewer** — reviews the diff independently. Never the agent that produced it.

## Routing

| Work | Route to |
| --- | --- |
| Code behavior change, new feature, bug fix, cross-file refactor | Claude worker (default) |
| Non-code or mechanical work: docs, config edits, formatting, data shuffling, log triage | General worker |
| Any work, when `claude-worker check` reports the Claude Code CLI is unavailable | General worker |

When code work falls back to a general worker, record the reason so the reviewer knows which path
produced the diff.

## Task envelope

Send one compact envelope per job:

- goal
- scope and explicit non-goals
- constraints: files or directories off limits, style, no commit/push/deploy
- acceptance criteria
- known evidence: failing test, stack trace, reproduction steps
- required verification commands
- the handoff format expected back

## Workspace rule

One writing agent per workspace at a time. Before starting a job, confirm no other agent holds the
same `cwd`. Read-only agents may run concurrently.

## Review and rework

1. The leader collects the worker handoff and the diff.
2. An independent reviewer checks the diff against the acceptance criteria.
3. If the reviewer requires changes, reopen the original job with `resume <job-id>` so the session
   keeps its context. Do not start a fresh `run` for rework.
4. Review again after each resume. The leader decides when the work is done.

## Stop conditions

A worker stops and hands back a structured report instead of guessing when:

- an ambiguity would change the result
- the same approach fails twice
- the task needs a decision outside the worker's scope

Handoff format: conclusion, key changes, modified files, verification commands and results, risks or
blockers, and what the reviewer should focus on.

## Boundaries

- Workers do not commit, push, deploy, or publish unless the task asks for it explicitly.
- Keep credentials and secrets out of task text, environment variables, and committed files.
- The bridge's safe mode and deny rules are defense in depth, not a security boundary. Read the
  task and the resulting diff.
