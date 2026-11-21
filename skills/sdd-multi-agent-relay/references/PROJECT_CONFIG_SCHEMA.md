# 项目配置文件 Schema 与 `relay.mjs` CLI 参考

## 一、`.agents/relay.json` 字段说明

每个接入本流程的项目，在根目录 `.agents/relay.json` 中维护声明式配置（由 `relay.mjs init` 自动生成）。所有涉及配置路径的子命令（`status`、`send`、`bind`、`spawn`、`state`、`notify`）均支持 `--config <path>`、`--project <dir>`，或**省略路径参数时从当前工作目录自动向上查找 `.agents/relay.json`**。支持 `wsl` 与 `windows` 两种 Codex 运行模式。

### 完整 Schema 与关键字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `version` | string | 配置版本，固定 `"1.0"` |
| `projectName` | string | 项目名称，用于简报与告警标题 |
| `batchId` | string | 当前活跃工作批次 ID（如 `PKG-FEAT-01`） |
| `tier` | `"L1"\|"L2"\|"L3"` | 任务分级 |
| `runtime` | `"wsl"\|"windows"\|"posix"` | VS Code Codex 所运行环境：WSL 内的 Codex 选 `"wsl"`；Windows 原生 Codex 选 `"windows"`；macOS / Linux 原生选 `"posix"`（亦接受别名 `macos`/`linux`） |
| `wslDistro` | string | 当 `runtime="wsl"` 时指定 WSL 发行版名（如 `"Debian"`；留空则使用默认发行版） |
| `projectPath` | string | 供 `codex queue -C` 使用的仓库根路径：`wsl`/`posix` 模式填 POSIX 路径（如 `"/path/to/my-project"`），`windows` 模式填 Windows 路径（如 `"D:\\repo\\my-app"`） |
| `devDir` | string | 协作文档目录相对路径，默认 `".agents/development"` |
| `relayDir` | string | 中继运行数据目录相对路径（应加入 `.gitignore`），默认 `".agents/relay"` |
| `codexBin` | string | `windows` 模式下可显式指定 `codex.exe` 路径；留空时自动探测 PATH 与 VS Code 扩展内置 `codex.exe` |
| `gitBranch` | string | 当前任务特性分支（建议 `feat/<batchId>`） |
| `automationMode` | `"full-auto"\|"semi-auto"` | 值守自动化级别：`full-auto`（全自动中继、自动拉起 `R0` 并可按授权收官）；`semi-auto`（半自动巡检并等待人工确认关键节点） |
| `worktrees` | object | 多 Worktree 监控配置：`{ "autoDiscover": true, "roleWorktrees": { "a": "../wt-a", "b": "../wt-b" } }`；`send`/`spawn` 会自动在对应角色 worktree 中执行，并纳入遥测 `DIRTY` 监控（同时兼容顶层 `roleWorktrees`） |
| `threads` | object | 显式固定的各角色 UUID：`{ "hub": "...", "ab": "...", "c": "..." }`（亦支持自定义角色名如 `a`、`b`）；**可留空 `""` 交由 `threadMatchers` 动态解析** |
| `threadMatchers` | object | 按 `~/.codex/session_index.jsonl` 会话标题动态匹配关键字（大小写不敏感子串），如 `{ "hub": "Demo-Codex-Hub", "ab": "Demo-AB", "c": "Demo-C" }`；当对应 `threads[role]` 为空时自动匹配最新活跃会话 |
| `thresholds` | object | 防停与熔断阈值：`pollIntervalSec`（`180`）、`idleThresholdSec`（`180`）、`maxNoProgressPushes`（`3`）、`maxFixRounds`（`2`） |
| `webhook` | object | 告警钩子：`enabled`（bool）、`type`（`"feishu"\|"wecom"\|"dingtalk"\|"generic"`）、`url`（不推荐明文写进已跟踪文件）、`envUrl`（环境变量名，优先读取，默认 `"RELAY_WEBHOOK_URL"`） |
| `shutdownOnComplete` | object | 终局关机策略：`enabled`（bool，默认 `false`）、`delaySec`（默认 `120` 秒缓冲） |

---

## 二、`.agents/relay/relay-state.json` 运行时状态结构

完全由 `scripts/relay.mjs` 自动维护，禁止手工伪造；用于在服务重启或切换 Antigravity 模型后实现秒级断点续传：

```json
{
  "version": "1.0",
  "updatedAt": "2026-11-21T12:30:00.000Z",
  "lastObservedSnapshot": {
    "headFull": "...",
    "dirtyCount": 0,
    "boardMtimeSec": 1795140000,
    "abCardMtimeSec": 1795140000
  },
  "roles": {
    "hub": { "lastPushAt": null, "lastPushThreadWrite": null, "consecutivePushesWithoutProgress": 0, "totalPushes": 0 },
    "ab":  { "lastPushAt": null, "lastPushThreadWrite": null, "consecutivePushesWithoutProgress": 0, "totalPushes": 0 },
    "c":   { "lastPushAt": null, "lastPushThreadWrite": null, "consecutivePushesWithoutProgress": 0, "totalPushes": 0 }
  },
  "stageFixes": {},
  "processedHandoffs": [],
  "activeCrossAgent": null,
  "rotations": []
}
```

- **`stageFixes`**：记录每个阶段累计收到 `要求整改` 的次数（如 `{"STAGE-B": 1}`）。达到 `thresholds.maxFixRounds`（默认 2）时，`status` 命令将返回 `fixCapBreaker: true`。
- **`processedHandoffs`**：记录已完成转交并回传中枢的跨端报文标识（如 `tasks/R0-review.md:183` 或任务 ID），避免重复派单。
- **`activeCrossAgent`**：记录当前正在进行的 Antigravity 子会话 ID、目标输出路径与开始时间；若服务中断，恢复时先查磁盘文件与 `manage_subagents`。

---

## 三、`scripts/relay.mjs` 子命令手册

所有命令在 Windows 宿主机直接用 Node.js 执行（零第三方依赖），自动适配 `wsl` 与 `windows` 双模式：

### 1. `init` — 初始化项目协作骨架与中继配置
```powershell
node relay.mjs init --project <path> [--runtime <wsl|windows|posix>] [--distro <name>] [--name <projectName>] [--batch <batchId>] [--tier L1|L2|L3] [--no-gitignore] [--force]
```
- **行为**：创建 `.agents/development/{specs,tasks,audits/design-reviews}` 与 `.agents/relay/messages`，渲染生成本机专属 `.agents/relay.json` 与团队共享模板 `.agents/relay.example.json`、`STATE.md`、`DISPATCH_BOARD.md`、`tasks/{AB-codex,R0-review,C-desktop}.md`、`DISCUSSIONS.md`、`ISSUE_LEDGER.md`、`AUDIT_QUEUE.md` 与 `AGENTS.md`（若已存在则另存片段文件不覆盖），并自动将 `.agents/relay/` 与 `.agents/relay.json` 写入 `.gitignore` 隔离多人本机路径/会话冲突。默认不覆盖已有文件（除非加 `--force`）。

### 2. `threads` — 安全枚举活跃 Codex 会话（仅元数据 + 标题索引）
```powershell
node relay.mjs threads --runtime <wsl|windows> [--distro <name>] [--filter <keyword>] [--limit 10] [--json]
```
- **行为**：只扫描 `~/.codex/sessions/**/*.jsonl` 的文件名 UUID、`mtime` 与字节大小，并关联 `~/.codex/session_index.jsonl` 的会话标题字段（`thread_name`），**绝不读取对话正文内容**。

### 3. `bind` — 动态绑定、按标题重绑或切回自动匹配模式
```powershell
node relay.mjs bind [--config <relay.json> | --project <dir>] --role <hub|ab|c> (--thread <uuid> | --match <keyword> | --auto)
```
- `--thread <uuid>`：将指定 UUID 写入 `relay.json` 的 `threads[role]`；
- `--match <keyword>`：在当前活跃会话中按 `thread_name` 匹配最新会话并写入 `threads[role]`，同时保存 `threadMatchers[role]`；
- `--auto`：清空固定 UUID，使后续 `status`/`send` 每次按 `threadMatchers[role]` 自动追踪最新会话。

### 4. `spawn` — 一键自动创建全新 Codex 会话并回写绑定
```powershell
node relay.mjs spawn [--config <relay.json> | --project <dir>] --role <hub|ab|c> [--prompt-file <file> | --prompt <text>] [--sandbox <read-only|workspace-write>] [--dry-run]
```
- **行为**：无需手动在界面新建窗口，直接通过 `codex exec -C <projectPath> -s <sandbox> -a never --json -` 发起全新会话（默认 `hub` 只读、`ab/c` 可写），解析启动事件中的 `thread_id` 自动写入 `relay.json` 并登记换班日志。使用 `--dry-run` 可先检查命令参数而不启动实例。

### 5. `status` — 全量态势采集、Worktree 遥测与熔断判定
```powershell
node relay.mjs status [--config <relay.json> | --project <dir>] [--compact] [--json]
```
- **输出**：
  - `--compact`：仅输出 1 行 **Ops-Cockpit 遥测条**（`● RELAY` / `◐ AUDIT` / `▲ IDLE` / `■ BREAKER` + 流水线面包屑 + 活跃秒数 + 主仓与各 Worktree `Δ`）；
  - `hub` / `ab` / `c` 及自定义角色（如 `a` / `b`）的解析方式（`pinned` / `matcher` / `UNBOUND`）、会话标题、当前状态、`idle_seconds`、`last_write`；
  - `DISPATCH_BOARD.md` 最新状态表行与最近 5 条日志、`AB-codex.md` 最近标题、解析后的流水线阶段状态 `pipeline`；
  - 过滤掉 `processedHandoffs` 后的新增「发送到：Antigravity / 待转交」跨端列表；
  - Git `branch`、`HEAD`（完整与短 SHA）、`dirtyCount` 及 `worktrees[]`（所有显式配置或 `git worktree list` 自动发现的次级 Worktree 状态）；
  - 熔断标记：`noProgressBreaker`（哪些角色达到 `maxNoProgressPushes`）、`fixCapBreaker`（哪些阶段达到 `maxFixRounds`）、`activeCrossAgent`、`automationMode`。

### 6. `render` — 生成标准化 Ops-Cockpit 输出块
```powershell
node relay.mjs render <heartbeat|nudge|milestone|breaker|complete> [--config <path> | --project <dir>] [options]
```
- 直接生成工程驾驶舱样式的 Markdown 块（单行心跳、停滞唤醒 `▲ NUDGE`、阶段里程碑 4 列状态表、熔断 `CAUTION` 与收官 `TIP` 汇总表），消除多设备输出格式漂移。

### 7. `send` — 带防重与无进展保护的安全队列投递
```powershell
node relay.mjs send [--config <relay.json> | --project <dir>] --role <hub|ab|c> --file <msg-file> --reason <text> [--force]
```
- **安全保护**：
  1. 对比线程当前 `last_write` 与 `relay-state.json` 的 `lastPushThreadWrite`：未变化则拒绝重复投递（退出码 1）；
  2. 检查该角色 `consecutivePushesWithoutProgress`：若相比上次推送时 Git/看板/任务卡零变化且已达上限（默认 3），直接拒绝投递并提示熔断；
  3. CRLF 自动规范化为 LF 后通过 `codex queue --thread <uuid> --message <text> --resume -C <projectPath>` 投递（WSL 下通过 `stdin` 传参，零引号转义问题）；
  4. 投递成功后自动将报文存档至 `relayDir/messages/`、追加 `relay.log` 并更新 `relay-state.json`。

### 8. `state` — 维护跨端审核周期与换班记录
```powershell
node relay.mjs state [--config <relay.json> | --project <dir>] show
node relay.mjs state [--config <relay.json> | --project <dir>] start-review --task <id> --role <R0|Hub> --subagent <uuid> --output <path> [--handoff <id>]
node relay.mjs state [--config <relay.json> | --project <dir>] finish-review --task <id> --verdict <通过|要求整改|阻塞> --report <path> --sha256 <hash>
node relay.mjs state [--config <relay.json> | --project <dir>] mark-processed --handoff <id>
node relay.mjs state [--config <relay.json> | --project <dir>] rotate-thread --role <role> --thread <new-uuid> [--reason <text>]
node relay.mjs state [--config <relay.json> | --project <dir>] reset-pushes --role <role>
```

### 9. `notify` — 发送 Webhook 告警 / 完工通知
```powershell
node relay.mjs notify [--config <relay.json> | --project <dir>] --event <circuit_breaker|blocker|quota|complete|info> --title <text> --message <text> [--dry-run]
```
- **行为**：优先从 `process.env[webhook.envUrl]` 读取 Webhook URL，其次回退 `webhook.url`。支持 `feishu`、`wecom`、`dingtalk` 与 `generic` 四种格式。使用 `--dry-run` 可预览脱敏载荷而不发请求。
