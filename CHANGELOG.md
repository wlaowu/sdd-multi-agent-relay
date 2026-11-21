# 更新日志（CHANGELOG）

## [1.3.2] - 2026-11-21

### WSL2 与 Windows 宿主稳态体检护栏
- **`analyze` 新增 WSL 跨盘 9P/DrvFS I/O 风险检测（`WSL_DRVFS_IO_RISK`）**：当 `runtime="wsl"` 时自动检查 `projectPath` 与 `roleWorktrees` 是否误放在 `/mnt/<drive>/` 下，提醒将业务代码与高频构建/测试缓存（`target/`、`node_modules`、SQLite）保持在 WSL Linux ext4 分区（`/home/...`），避免跨盘高频 I/O 拖死 WSL。
- **`doctor` 新增 Windows 宿主机网络稳态体检（`hostHealth`）**：只读检查 `netsh int ipv4 show dynamicport tcp` 动态短端口容量（`< 30000` 时预警并提供 `netsh int ipv4 set dynamicport tcp start=20000 num=45535` 扩容指令，防范 `Tcpip 4231` 耗尽）以及 `.wslconfig` 是否开启易与代理 TUN 冲突的 `networkingMode=mirrored`。
- **文档与指南同步**：在 `SKILL.md`、`WORKFLOW_SPEC_V1.0.md` 与 `PROJECT_CONFIG_SCHEMA.md` 固化 WSL2 分区与短端口池稳态约定。

## [1.3.1] - 2026-11-21

### 线上盲区与排版修复
- **孤儿进程 `ppid` 血缘甄别（防误判 `AB`/`C` 仍在线）**：
  - 新增 `relay.mjs procs` 子命令与 `relay.mjs status --check-procs` 参数（同步接入 `bin/cli.mjs` 透传），在核查后台测试/构建进程时沿 `ppid` 祖先链追溯宿主：严格区分挂在存活 `codex` 宿主进程下的真正在跑任务（`attachedWorkers`）与父 `codex` 已退出、祖先链挂至 `PID 1`/断链的孤儿进程（`orphanWorkers`），避免 WSL 抖动或会话中断后误报「仍在后台实跑测试」。
- **人话驾驶舱引用块空行防粘连**：
  - 统一更新 `buildTelemetryLine()`、`render <heartbeat|nudge|milestone|breaker|complete>` 及 `SKILL.md` / `ROLE_PROMPTS.md` 模板，在卡片标题行与正文行之间加入空引用行 `>`（`\n>\n`），彻底解决部分 Markdown 渲染器将两行 `>` 合并成一段导致排版粘连的问题。

## [1.3.0] - 2026-11-21

### 黄金三角升级（防返修 · 抗腐化 · 事件驱动）
- **Red → Green TDD 与两段式 `R0` 独立审计**：
  - 升级 `AGENTS.md.template`、`TASK_CARD.md.template` 与 `ROLE_PROMPTS.md`，要求 `AB` 实施与返修先编写必失败边界/反例测试并附 Red→Green 实测证明；
  - 要求 `R0` 执行两段式独立审计（第一段逐条核对 Spec 与 `V-xx` 验收零遗漏，第二段再开展代码质量与隔离对抗测试）。
- **Wave 波次并行与上下文预算归档（`compact`）**：
  - `DISPATCH_BOARD.md.template` 新增 `波次/依赖` 列（`W0`/`W1`），`relay.mjs status` 新增 `parseWaveSummary()` 解析 `currentWave` 与 `parallelReady`；
  - `relay.json.template` 新增 `waves` 与 `contextBudgets`（默认 `120` / `160` / `250` 行），新增 `relay.mjs compact [--dry-run|--apply] [--keep-logs 15]` 自动将超长调度日志归档至 `.agents/development/archive/` 并留 1 行索引。
- **零依赖事件信号总线（`event`）与阶段耗时追踪（`stageTimers`）**：
  - 新增 `relay.mjs event <emit|list|ack|clear>`，结构化写入 `.agents/relay/events.jsonl`；`status` 与 `telemetryLine` 最高优先置顶展示 `◆ **收到事件信号**`；
  - `relay-state.json` 在 `start-review` / `finish-review` / `event emit` 中累计 `stageTimers`，人话状态卡同步显示 `已耗时 X 分`。
- **开工前防漂移体检（`analyze`）、增量变更模板（`CR_DELTA`）与离线 HTML 驾驶舱（`ui`）**：
  - 新增 `relay.mjs analyze [--json]` 只读体检 Spec（`V-xx`/未决 `PD-xx`）、看板重复任务号/缺失 `[T-xx]`/断链、预算超标、未确认事件与熔断标记；
  - 新增 `resources/CR_DELTA.md.template` 支持中途增量规范变更（`ADDED`/`MODIFIED`/`REMOVED` Diff）；
  - 新增 `relay.mjs ui [--export <file.html>] [--port 4317]`，生成零外链全中文响应式驾驶舱网页（支持静态导出与 5 秒 `/api/status` 轮询）。

## [1.2.0] - 2026-11-21

### 人话驾驶舱输出全面优化（告别机械暗语）
- **自然中文 2 行状态卡**：重写 `relay.mjs status --compact` 与 `buildTelemetryLine()`，去掉用户难懂的 `R0#hex`、`HEAD`、`Δ`、`Hold`、`Wait`、`idle_seconds` 等机器代码；改用直观中文标题 + `→` 阶段箭头 + 自然语言说明（如谁在活跃、几分几秒前有输出、改动几个文件、是否需要人管）。
- **`render` 子命令人话升级**：
  - `render heartbeat` 新增 `--activity <text>`，支持注入具体进度说明；
  - `render nudge` 自动将静默秒数转成 `X 分 Y 秒` 并中文汇报投递结果；
  - `render milestone` 自动将 `0 / 0 / 0 / 1 / 2` 展开为 `阻断 0 · 高危 0 · 中危 0 · 低危 1 · 建议 2`，并用人话列名展示下一步自动动作；
  - `render breaker` / `render complete` 同步转为自然中文决策提示与验收表。
- **规范同步**：同步更新 `SKILL.md`、`ROLE_PROMPTS.md` 与 `PROJECT_CONFIG_SCHEMA.md`，禁止对用户输出未经翻译的机械遥测暗语。

## [1.1.0] - 2026-11-21

### Ops-Cockpit 标准化输出与多 Worktree / 自定义角色支持
- **工程驾驶舱（Ops-Cockpit）标准化输出引擎**：
  - `relay.mjs status` 新增 `--compact` 参数，并在 JSON 中新增 `pipeline` 与 `telemetryLine`，原生拼出单行遥测条（几何徽章 `● RELAY` / `◐ AUDIT` / `◆ HANDOFF` / `▲ IDLE` / `■ BREAKER` + 流水线进度面包屑 + 活跃秒数 + 主仓/Worktree `HEAD` 与 `Δ` 计数），彻底消除多设备多会话输出漂移。
  - 新增 `relay.mjs render <heartbeat|nudge|milestone|breaker|complete>` 子命令（同步接入 `bin/cli.mjs` 透传），直接输出停滞唤醒单行、4 列阶段里程碑表、熔断 `CAUTION` 与收官 `TIP` 汇总表。
- **多 `git worktree` 与自定义角色监控**：
  - 在 `.agents/relay.json` 新增 `worktrees: { autoDiscover: true, roleWorktrees: {} }`（同时兼容顶层 `roleWorktrees`），`status` 自动采集显式配置与 `git worktree list --porcelain` 发现的次级 worktree 的 `branch` / `HEAD` / `dirtyCount`，并在 `send` / `spawn` 时自动切到对应角色 worktree 执行。
  - 解除 `['hub', 'ab', 'c']` 硬编码限制，支持在 `threads` / `threadMatchers` / `roleWorktrees` 中绑定任意自定义小写角色名（如 `a`、`b`）。
- **显式值守模式与纯净值守切换**：
  - 配置模板新增 `automationMode`（`"full-auto"` / `"semi-auto"`）；`SKILL.md` 与 `ROLE_PROMPTS.md` 固化了 `§4.1 Ops-Cockpit 输出规范` 与 `§5 纯净值守窗口切换协议`。

## [1.0.0] - 2026-11-21

### 初始发布（Initial Team Release）
- **规范与流程标准**：确立 `0 + (2+3)` 分权闭环架构、7 大高可用风控（返修上限熔断、长会话无损换班、CR 变更、断点外置+Webhook 告警、里程碑真机门禁、分支隔离与红线、终局简报与安全关机）。
- **文档整理与任务编号标准**：配套 8 板块 `SPEC`、5 条 `Plan`、三段式任务卡、强制顺序编号（`T-00`、`[T-01]`、`T-01-R0`、`T-01-FIX1`、`T-02-C`、`R0-T01-01`）及 `AGENTS.md` 自动生成；内置 `examples/sample-pkg/` 四联端到端范本。
- **全角色派发模板**：内置覆盖 `Codex-Hub`、`AB`（实施与返修）、`C`（真机验证）、`R0`（独立审计）、`Hub`（方案复盘）及防停/换班的完整 8 字段首部模板。
- **零固定目录与全动态会话**：支持子目录向上自动发现 `.agents/relay.json`，兼容 Windows / WSL / macOS / Linux（`posix`），支持 `threadMatchers` 标题匹配、`bind` 动态重绑与 `spawn` 一键拉起新会话；`init` 自动维护 `.gitignore`（隔离多人本机 `relay.json` 与 `.agents/relay/`）并生成团队共享 `.agents/relay.example.json`。
- **全自动安装与质量护栏**：提供 `bin/cli.mjs`（支持 `npx`、`agy plugin install`、`install`/`update`/`uninstall`/`doctor`、`.agents/plugins.json` 子模块及 `postinstall`）、Plugin `assets/logo.svg`，并配备零依赖 `npm test` 冒烟测试与 GitHub Actions CI。
