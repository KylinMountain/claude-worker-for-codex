# Claude Worker for Codex

**用 GPT-5.6 Sol 或 GPT-6 Astra 编排。用 Claude Code 执行。**

[English](README.md)

Claude Worker for Codex 是一个非官方、无第三方运行时依赖的本地 CLI bridge。它让 Codex 工程 Leader 调用同一台机器上已安装的 Claude Code CLI，启动、查看、恢复和取消有边界的任务。它不隶属于 OpenAI 或 Anthropic，也未获其认可或支持。

## 两类模型角色

- **Codex Leader：** 在 Codex 中选择 `gpt-5.6-sol` 或 `gpt-6-astra`，负责规划、委派、审查和验收。插件不会切换 Codex 主模型。参阅 [GPT-5.6 Sol 文档](https://developers.openai.com/api/docs/models/gpt-5.6-sol) 和 [GPT-6 Astra latest-model 指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)。
- **Claude Code worker：** 执行委派任务的本地 CLI 进程。`CLAUDE_WORKER_MODEL` 或 `--model` 选择 `opus`、`sonnet` 或精确 Claude 模型 ID。这是 worker 模型设置，不是 Codex 模型设置。

该 bridge 不是原生 subagent 系统。典型流程是：

```text
Codex Leader → 本地 Claude Code worker → 独立 reviewer
             → 必要时恢复原 job → Leader 验收
```

当 Leader 需要聚焦的实施上下文、持久化 job 状态、可恢复 session 以及独立审查边界，同时不想引入 daemon、MCP server 或 Web UI 时，这种分工尤其有用。

## 功能

- 后台 `run` 与保留 session 的 `resume`。
- 持久化状态、PID/session 元数据、stdout、stderr 和结果文件。
- `check`、`status`、`result` 以及按进程组执行的 `cancel`。
- 工作区和任务文件必须使用绝对路径并经过校验。
- 无第三方运行时依赖，不自动 commit、push、merge、部署或发布。

## 要求

- 本机安装并登录 Claude Code。
- 安装并登录 Codex。
- Node.js 18 或更新版本。

## 安装

添加公开 Git marketplace，再安装插件：

```sh
codex plugin marketplace add KylinMountain/claude-worker-for-codex --ref main
codex plugin add claude-worker@claude-worker-for-codex
```

安装后请新建 Codex thread，使 skill 被加载。

## 快速开始

```sh
node plugins/claude-worker/scripts/claude-worker.js check
node plugins/claude-worker/scripts/claude-worker.js run \
  --cwd /path/to/workspace \
  --task "检查失败测试并实现最小修复"
```

命令会在 worker 启动握手完成后立即返回 job ID：

```sh
node plugins/claude-worker/scripts/claude-worker.js status JOB_ID
node plugins/claude-worker/scripts/claude-worker.js result JOB_ID
```

Reviewer 要求返工时，继续同一个 Claude session：

```sh
node plugins/claude-worker/scripts/claude-worker.js resume JOB_ID \
  --task "应用审查修复，重新运行要求的测试并报告结果"
```

## 命令

```text
check
run --cwd ABSOLUTE_DIR (--task TEXT | --task-file ABSOLUTE_FILE)
status [JOB_ID]
result JOB_ID
resume JOB_ID (--task TEXT | --task-file ABSOLUTE_FILE)
cancel JOB_ID
```

`run` 要求已有的绝对路径 `--cwd`，并且必须二选一提供任务文本或任务文件。`resume` 复用原 job 的工作区和 session。省略 ID 时，`status` 列出全部 job。`cancel` 只向经过身份核验的 job 进程组发送信号。

## 配置

配置优先级从高到低为：显式 CLI 参数、支持的环境变量、内置默认值。

| 配置项 | CLI 参数 | 环境变量 | 默认值 |
| --- | --- | --- | --- |
| Claude worker 模型 | `--model` | `CLAUDE_WORKER_MODEL` | `opus` |
| 权限模式 | `--permission-mode` | `CLAUDE_WORKER_PERMISSION_MODE` | `auto` |
| 私有 job 存储 | — | `CLAUDE_WORKER_HOME` | 用户本地 `.claude-worker` 目录 |

示例：

```sh
CLAUDE_WORKER_MODEL=sonnet \
CLAUDE_WORKER_PERMISSION_MODE=plan \
node plugins/claude-worker/scripts/claude-worker.js run \
  --cwd /path/to/workspace --task "审查这次迁移"
```

添加 `--model opus --permission-mode auto` 会覆盖上述环境变量。绕过权限检查的模式会被拒绝。

## 可选 Leader 策略

插件不会修改用户的全局指令。团队可以明确选择加入，在自己的 `AGENTS.md` 中改写并添加以下模板：

```md
对于行为变化、新功能、Bug 修复和跨文件实施，Leader 可以调用已安装的 claude-worker skill。Claude 是通过本地 bridge 执行的 worker，不是原生 collaboration agent。保持每个工作区只有一个写入 agent，使用独立 reviewer；需要返工时先恢复原 job，再由 Leader 验收。
```

如果 Claude Code 不可用，将任务降级给通用 worker。非代码或机械任务也应在适合时走通用 worker 路径。

## 安全边界

Claude 默认以 `--safe-mode` 运行，避免加载项目自定义内容，例如 `CLAUDE.md`、hooks、MCP servers 和 skills。deny rules 覆盖常见的 `git push`、`gh pr merge`、部署、发布和基础设施命令，也覆盖若干包装命令以及 `git -C`/`git -c` 形式。这些是纵深防护，不是完整安全边界：仍需审查任务、权限、日志和最终变更。bridge 不自动执行 push、merge、deploy、commit、install 或 publish。

Job 记录和日志保存在私有 job 存储中。不要把凭据或其他 secrets 放进任务文本、环境变量或提交文件。

## 许可证

MIT，详见 [LICENSE](LICENSE)。
