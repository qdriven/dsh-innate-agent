# dsh-innate-agent 本地实验手册

> 基于 [deepseek-ai/dsh-superagent-prototype](https://github.com/deepseek-ai/dsh-superagent-prototype) 的实验分支。
> 目标：**不依赖 GitHub**，用本地看板服务走通 superagent 的完整回路（请求 → Ticket → 执行 → 回复）。

## 这个仓库改了什么

| 部分 | 说明 |
| --- | --- |
| GitHub 可选化补丁 | `resolveDeployment` 在 GitHub Source 未配置仓库和 CLI 时返回无 GitHub 的 deployment；`writeEnvironment` 不写 `gh` shim 和 github.com 凭据；`Commands.gh/api` 在无 GitHub 时明确报错 |
| `src/sources/localboard.ts` | 新 Source kind（按 docs/008-cookbook.md 配方），轮询本地看板 |
| `cli/hookq.mjs` | 单文件本地看板 CLI（JSON 存储），即 cookbook 里的 `hookq` |
| `scripts/dsh-superagent-local` | 无 tmux 服务管理：`nohup` 后台启动，`status/stop/restart` 复用上游脚本的 control 目录与退出码约定 |
| `src/app/trace.ts` + `cli/trace.mjs` | 事件 trace：Engine 每个领域事件（含新增的 `inputs.delivered` / `inputs.read` / `worker.reported`）记入 KV 有界日志（2000 条），CLI 直接读 SQLite 查看 |
| `KV.localboard` | 轮询游标 |
| `tests/localboard.spec.ts` | 7 个用例：翻译/游标/Channel/Thread 上下文/插件入口/策略 |

上游测试全部保持通过（1204 passed），GitHub 路径行为不变。

## 快速开始

### 0. 前置

- Node 22.19+/24+、pnpm、git 2.32+、DSH `^0.2.1-alpha.2` + 模型 provider
- **不需要 tmux**（本仓库用 `scripts/dsh-superagent-local` 的 nohup 模式；装了 tmux 用上游 `scripts/dsh-superagent` 也行）

### 1. 构建本地看板

```sh
mkdir -p ~/.local/bin
cat > ~/.local/bin/hookq <<'EOF'
#!/bin/sh
exec node /path/to/dsh-innate-agent/cli/hookq.mjs "$@"
EOF
chmod +x ~/.local/bin/hookq

# 建看板并模拟一个请求（@ 智能体）
hookq post --conversation ops --sender patrick --mention --text "@agent 修复 README 里的错别字"
hookq list
```

存储位置：`$LOCALBOARD_HOME`（默认 `~/.localboard`），每个对话一个 JSON 文件。

### 2. 安装 bundle（无 GitHub 配置）

```sh
cd dsh-innate-agent
pnpm install && pnpm build
dsh superagent --from-default-profile web --dump-config > /dev/null   # 建 superagent profile（已存在则跳过）
dsh plugin --profile superagent add "link:$PWD"
```

机器配置 `~/.dsh/profiles/superagent/cordis.patch.yml`：

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: <绝对路径，如 /Users/me/.dsh/state/superagent>
- id: dsh-innate-localboard
  disabled: false
```

### 3. 启动并配置（无 tmux）

```sh
scripts/dsh-superagent-local start    # nohup 后台运行，日志在 .artifacts/dsh-local-*.log
scripts/dsh-superagent-local status   # 0 正常 / 1 未运行 / 2 组件错 / 3 待配置
```

面板（http://127.0.0.1:3082 → Superagent）里：

1. **Sources**：GitHub 卡片保持**空**（repository 和 CLI 都不填，即"无 GitHub"模式）；localboard 卡片填 `hookq` CLI 路径，加一个对话 `ops`（选"仅 @"）
2. **Policy**：localboard 的 allowed 名单加 `patrick`
3. **Execution**：prepare command 用本地 git 仓库（无 GitHub remote 也可以）：
   ```sh
   git -C /path/to/local/repo worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" HEAD
   ```
4. **Prompts**：Delivery requirements 里删掉 auto-merge 段（无 GitHub 就没有 PR）

或用 Management API：

```sh
api=http://127.0.0.1:3082/orchestrator/api
rev=$(curl -s -H 'x-orchestrator-request: 1' $api/settings | jq '.sources[] | select(.id == "localboard") | .revision')
curl -s -X PUT -H 'x-orchestrator-request: 1' -H 'content-type: application/json' $api/settings/source:localboard \
  -d "{\"value\": {\"enabled\": true, \"config\": {\"cli\": \"$HOME/.local/bin/hookq\", \"conversations\": [{\"id\": \"ops\", \"listen\": \"mentions\"}]}}, \"revision\": $rev}"
# policy 名单与 eval/executor 同理（PUT settings/policy 等）
```

### 4. 走一遍回路

```sh
# 请求（allowed 用户 @ 智能体）
hookq post --conversation ops --sender patrick --mention --text "@agent 修复 README 里的错别字"

# 看面板出现 Ticket；worker 在自己的 Session/目录里处理，回复出现在看板上
hookq list

# 追问（同一线程，无需再 @）
hookq comment --on m0001 --sender patrick --text "顺便把标题也改了"
```

worker 的交付物是本地 git worktree 里的 commit（无 PR 绑定；那是 GitHub Source 的能力）。

### 5. 看事件 trace

Agent 每一步（Trigger 到达 → Eval → 接单 → 派工 → 输入送达/读取 → worker 各次 report → 结束）都记入有界 trace：

```sh
# 最近 50 条
node cli/trace.mjs

# 跟踪某个 ticket（含 ready/blocked/report 摘要）
node cli/trace.mjs --ticket <ticketId> --limit 200

# 实时跟随（每 2s 刷新）
node cli/trace.mjs --follow

# 指定数据库（默认 ~/.dsh/state/superagent/orchestrator.sqlite）
node cli/trace.mjs --state /path/to/orchestrator.sqlite
```

输出示例：

```
    7  14:32:01  ticket.created        ticket=9f2a1b3c4d5e
    8  14:32:01  thread.subscribed     ticket=9f2a1b3c4d5e
    9  14:32:02  assignment.started    ticket=9f2a1b3c4d5e assignment=01JX…
   10  14:32:03  inputs.delivered      ticket=9f2a1b3c4d5e assignment=01JX…
   12  14:35:47  worker.reported       ticket=9f2a1b3c4d5e state=ready PR ready: fixed the typo…
   13  14:35:47  ticket.ended          ticket=9f2a1b3c4d5e
```

trace 保留最近 2000 条（`TRACE_LIMIT`），存于 `orchestrator.sqlite` 的 kv 表（`trace:events` / `trace:seq`），重启后序号继续。

## 已知边界

- **PR 生命周期**：localboard 无 PR 概念，Ticket 以 `ready` Report 结束（"completed"），不跟随分支关闭
- **gh 相关提示词**：`skill/github` 仍会注入 worker 提示词（无害，worker 调 gh 会得到明确报错）；如需彻底清理可覆盖 `skill/github` prompt 段
- **面板 Deployment 页**：无 GitHub 时 Repository/Agent 显示 `—`
- **上游同步**：本仓库是实验分支，追 upstream 时补丁集中在 deployment.ts / environment.ts / commands.ts / http.ts 一行，冲突面小

## 命令速查（hookq）

| 命令 | 作用 |
| --- | --- |
| `hookq post --conversation <id> --sender <user> [--mention] --text <t>` | 发新消息（模拟人在看板发帖） |
| `hookq comment --on <mID> --sender <user> [--mention] --text <t>` | 在某消息线程里回复 |
| `hookq list [--conversation <id>]` | 查看所有消息 |
| `pull/reply/thread` | Source 内部使用（游标/幂等回复/线程读取） |

## 服务管理（scripts/dsh-superagent-local）

| 命令 | 退出码 |
| --- | --- |
| `start` | nohup 启动（拒绝重复实例；复用上游 control 目录，`scripts/dsh-superagent status/stop` 也能管理它） |
| `status` | 0 正常 / 1 未运行或重复 / 2 组件错 / 3 等待配置 |
| `stop` / `restart` | SIGINT 优雅停止（默认等 300s），stop 记录 manual 标记 |

服务不依赖任何终端窗口（nohup 脱离）；日志统一在 `.artifacts/dsh-local-<profile>-*.log`，保留最近 20 份。
