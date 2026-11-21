---
name: sdd-multi-agent-relay
description: >-
  Use this skill when the user wants Antigravity to orchestrate VS Code Codex and Antigravity
  specialized sessions through a Spec-Driven Multi-Agent Gated Workflow (2+3 roles: Hub, Codex-Hub,
  AB, C, R0) for long-running projects, initialize a project for multi-session relay, organize a
  new requirement into standardized Spec/Plan/Task documents (整理方案、制定任务计划、规范文档、SDD 流程),
  supervise Codex anti-stall execution, handle cross-agent R0 audits, or resume an interrupted relay patrol.
---

# 规范驱动的跨端多 Agent 分权门禁工作流 (`sdd-multi-agent-relay`)

当用户希望让 Antigravity 代替人工盯盘，引导 VS Code Codex 与 Antigravity 多会话协同完成**从方案制定、任务拆解到分阶段实施与独立审核**的长任务时，启用本技能。

详细标准与模板按需查阅：
- 完整流程标准：[WORKFLOW_SPEC_V1.0.md](./references/WORKFLOW_SPEC_V1.0.md)
- 方案/计划/任务文档整理标准与配模指南：[DOC_STANDARDS.md](./references/DOC_STANDARDS.md)
- 角色提示词与接龙报文模板：[ROLE_PROMPTS.md](./references/ROLE_PROMPTS.md)
- 配置 Schema 与 CLI 手册：[PROJECT_CONFIG_SCHEMA.md](./references/PROJECT_CONFIG_SCHEMA.md)
- 统一中继与状态脚本：[relay.mjs](./scripts/relay.mjs)
- 项目脚手架模板：[resources/](./resources/)（含 [SPEC.md.template](./resources/SPEC.md.template)、[CR_DELTA.md.template](./resources/CR_DELTA.md.template) 与 [AGENTS.md.template](./resources/AGENTS.md.template)）
- 极简端到端范本：[examples/sample-pkg/](./examples/sample-pkg/)（`Spec` / `Board` / `Task` / `R0` 实样对照）

---

## 一、任务轻重分级决策（先定级再建单）

| 级别 | 适用场景 | 启用角色 | 人工拍板节点 | 门禁要求 |
| --- | :--- | :--- | :--- | :--- |
| **L1 轻量** | 单点 Bug 修复、局部样式或文案调整 | `AB` | 无需预审，需求确认后直派 | 编译/单测自证 + 一次轻量检查 |
| **L2 标准** | 独立完整功能模块（半天～1 天） | `Codex-Hub` + `AB` + `R0` | 简版方案确认 1 次 | 冻结 SHA + 单次 `R0` 独立审核 |
| **L3 重型** | 跨天长任务、架构重构、迁移/计费/多端闭环 | 完整 `0 + (2+3)`（含 `Hub`/`C`） | **方案定稿＋预审后拍板 1 次**，后续全自动续推 | 逐阶段离线门禁 + 里程碑 `C` 真机门禁 + `R0` 逐阶段放行 |

---

## 二、新项目接入清单（零固定目录、零固定会话）

所有命令均无需写死配置路径：进入任意项目根目录（或子目录）执行 `relay.mjs` 会自动向上发现 `.agents/relay.json`（也可通过 `--project <目录>` 或 `--config <文件>` 指定）。

1. **初始化协作与中继目录**（路径支持 Plugin 安装目录 `~/.gemini/config/plugins/sdd-multi-agent-relay/skills/sdd-multi-agent-relay/scripts/relay.mjs` 或独立 Skill 目录 `~/.gemini/config/skills/sdd-multi-agent-relay/scripts/relay.mjs`）：
   ```powershell
   # Windows PowerShell (macOS/Linux/WSL 请改用 ~/.gemini/config/...，--runtime 用 posix 或 wsl)
   node "$env:USERPROFILE\.gemini\config\skills\sdd-multi-agent-relay\scripts\relay.mjs" init `
     --project "<任意项目目录>" `
     --runtime <wsl|windows|posix> [--distro <name>] --name "<项目名>" --batch "<BATCH-ID>" --tier L3
   ```
   确保将 `.agents/relay/` 加入 `.gitignore`（或确认不混入业务提交），建议拉出独立特性分支 `git checkout -b feat/<BATCH-ID>`。
   > **WSL2 稳态环境建议**：① 将仓库代码与高频构建缓存（Rust `target/`、`node_modules`、SQLite、测试临时库）放在 WSL Linux ext4 分区（如 `~/work/...`）而非 `/mnt/c/...`（避免跨 9P/DrvFS 高频 I/O 拖死通道）；② Windows 宿主机高并发跑测试时可用 `doctor` 检查动态短端口池是否偏小（建议 `>= 30000`，管理员 PowerShell 执行 `netsh int ipv4 set dynamicport tcp start=20000 num=45535`）并优先使用稳定 `nat` 网络而非冲突的 `mirrored`+TUN 组合；③ 开工前运行 `relay.mjs analyze --json` 自动体检跨盘路径风险。

2. **三种动态会话绑定方式（不写死会话，随时可换）**：
   - **方式 A（按标题自动动态匹配，推荐）**：`init` 默认会在 `.agents/relay.json` 生成 `threadMatchers`（如 `"<项目名>-Codex-Hub"` / `"<项目名>-AB"` / `"<项目名>-C"`）。只要在 VS Code Codex 把会话命名为对应标题，`threads` 可留空 `""`，`status`/`send` 会通过 `~/.codex/session_index.jsonl` 自动匹配最新活跃同名会话。
   - **方式 B（关键词检索 + 随时改绑）**：运行 `threads --filter <关键字>` 查找，再用 `bind` 动态切换：
     ```powershell
     node "...\scripts\relay.mjs" threads --runtime <wsl|windows|posix> --filter "<关键字>"
     node "...\scripts\relay.mjs" bind --role ab --match "<会话标题关键字>"   # 绑定匹配到的最新会话
     node "...\scripts\relay.mjs" bind --role ab --auto                      # 切回全自动按标题跟踪模式
     ```
   - **方式 C（自动拉起全新会话并回写绑定）**：开新项目或长任务需要“无损换班”时，直接由中继创建全新 Codex 会话：
     ```powershell
     node "...\scripts\relay.mjs" spawn --role hub --dry-run
     node "...\scripts\relay.mjs" spawn --role hub
     ```

3. **进入 Phase 1–2（方案 + 预审 + 统一编号拆单 + 防漂移体检与拍板）**：
   - 严格按 [DOC_STANDARDS.md](./references/DOC_STANDARDS.md) 与 [SPEC.md.template](./resources/SPEC.md.template) 引导 `Hub`（建议 `Model: "pro"`）写出 8 板块规范方案 `specs/<THEME>_SPEC_V0.1.md`（带 `V-xx` 验收矩阵与 `PD-xx` 决策清单）；中途增量变更使用 [CR_DELTA.md.template](./resources/CR_DELTA.md.template)；
   - 如为 L3 任务，拉起独立 `R0` 子会话（`Model: "pro"`，跨模型家族审计）做实施前预审（固定单号 `T-00`），补齐反例后冻结版本；
   - 请求用户一次性拍板 `PD-xx` 决策与**全程自动续推授权**（同时确认完工后是否自动关机与 Webhook 告警），交由 `Codex-Hub` 按**强制顺序编号规则（每个任务末尾带 `[T-xx]`，如 `T-01`、`T-02`…，派生 `T-01-R0` / `T-01-FIX1` / `T-02-C`）**与 **Wave 波次依赖（`W0`/`W1`…，支持无依赖任务分派至多 Worktree 并行实施）**拆单；
   - 正式派发 `AB` 实施前执行一次 `relay.mjs analyze --json` 开工前防漂移体检（确认 `V-xx` 齐备、无未决 `PD-xx`、看板无重号/缺标签/断链），`AB` 实施与返修强制执行 **Red → Green TDD**，`R0` 执行 **两段式独立审计**（先逐条核对 Spec/`V-xx` 零遗漏，再审代码质量与对抗边界）。

---

## 三、Antigravity 按角色模型分层约定

- **总控中继主会话（3 分钟定时巡检）**：使用规划+执行双模或配额宽裕的均衡模型，避免高频定时唤醒耗尽紧俏顶配额度。
- **`Hub` 与 `R0` 独立子会话**：调用 `invoke_subagent` 时优先使用 `Model: "pro"`（或在父模型本身已是 `pro`/高配且用户偏好一致时用 `"inherit"`），若旧子会话遇到 `429`/配额不足，立即切换新建独立子会话并指向历史报告目录。
- **轻量调研 / 浏览器验证等辅助子会话**：使用 `Model: "flash"`。

---

## 四、值守巡检主循环（每 3 分钟 `schedule` Cron）

使用 `schedule`（`CronExpression: "*/3 * * * *"`，`IsDaemon: true`）启动巡检。**无动作时严禁冗余刷屏，绝不越权写业务代码、改看板/任务卡、代填回执或偷窥 `~/.codex/sessions/*.jsonl` 正文。**

每次唤醒严格按以下优先级顺序检查并处置：

1. **采集双端元数据、事件总线与波次状态**：
   - 在目标项目目录下直接运行 `node "...\scripts\relay.mjs" status --json`（或显式传 `--project` / `--config`）；自动解析波次进度 `waves`（`currentWave` / `parallelReady`）、未确认事件 `pendingEvents`、阶段耗时 `stageTimers` / `activeStageTimer`、文档行数预算 `contextBudgets`、多 `git worktree` 及自定义角色名；
   - 若存在待处理结构化事件（`pendingEvents` 非空），`telemetryLine` 会最高优先显示 `◆ **收到事件信号**`：先逐条核实事件（如 `review_ready`/`done`/`blocked`/`decision_needed`）并按相应流程处置后，再执行 `relay.mjs event ack --id <id>`（或 `--all`）确认消警；
   - 若 `contextBudgets.overBudgetCount > 0` 或 `DISPATCH_BOARD.md` 调度日志冗长，执行 `relay.mjs compact --apply` 自动将历史日志归档至 `.agents/development/archive/` 并保留 1 行索引（绝不修改 `specs/`、`audits/` 或源码）；
   - 需要向用户提供可视化全景看板时，可运行 `relay.mjs ui --export <file.html>` 导出零外链离线中文驾驶舱网页，或运行 `relay.mjs ui --port 4317` 启动本地实时服务；
   - 若存在活跃子会话，调用 `manage_subagents{Action:"list"}` 检查子会话是否正常运行（防 `429`/崩溃静默空等）。

2. **检查熔断与用户阻塞（最高优先暂停）**：
   - 若 `noProgressBreaker`（连续 3 次推动零变化）、`fixCapBreaker`（单阶段返修已达 `maxFixRounds=2`）、或看板写明需用户拍板/缺外部密钥权限：
   - **立即停止自动推动**，运行 `relay.mjs notify --event circuit_breaker|blocker ...` 发送告警，并立即用 `render breaker` 向用户报告明确卡点。

3. **检查终局退出条件**：
   - 仅当所有计划阶段均已冻结 SHA、对应 `R0` 报告 verdict 为 `通过`、且 `Codex-Hub` 在 `DISPATCH_BOARD.md` 登记全部完成闭环后：
   - 核实 `FINAL_SUMMARY.md` 已落盘（如未写则请 `Codex-Hub` / `Hub` 补齐或由中继索引核对）；
   - 运行 `manage_task` 取消定时巡检，调用 `relay.mjs notify --event complete ...`；
   - 运行 `relay.mjs render complete ...` 向用户汇报全部 SHA 与审计报告总览表；若用户预先授权且 `automationMode="full-auto"`、`shutdownOnComplete.enabled=true`，执行 `shutdown.exe /s /t <delaySec> /c "..."`。

4. **优先处理跨 Agent 待转交（Codex ↔ Antigravity）**：
   - 当 `pendingCrossAgent` 出现未在 `relay-state.json` 记录的「发送到：Antigravity / 待转交」事项时（且在 `automationMode="full-auto"` 下自动代行；若 `semi-auto` 则按约定转交或提示）：
   - 按 [ROLE_PROMPTS.md](./references/ROLE_PROMPTS.md) 拉起（或 `send_message` 复用）独立 `self` 子会话（`Model: "pro"`，或随父高配 `"inherit"`），立即执行 `relay.mjs state start-review ...` 记录进行中状态；
   - 子会话落盘报告后，在磁盘逐项校验目标报告 `sha256` 与历史报告未篡改，执行 `relay.mjs state finish-review ...`，写报文并用 `relay.mjs send --role hub ...` 回传 `Codex-Hub` 核收。

5. **Codex 防停推动（仅在无进行中 R0 且目标 `idle_seconds >= 180` 时触发）**：
   - **防孤儿进程误判铁律**：怀疑处于 `STOPPED` 状态的会话正在后台跑耗时编译/测试时，**严禁仅凭进程名判定会话仍在线**；必须先运行 `relay.mjs procs --json`（或 `status --check-procs --json`）沿 `ppid` 祖先链核对：仅当 `hasActiveCodexWorker === true`（构建/测试进程确实挂在存活的 `codex` 宿主进程下）才暂缓唤醒；若仅见 `orphanWorkers`（父 `codex` 会话已退出、进程挂至 `PID 1` 或父进程断链），严禁误报「仍在后台实跑测试」，应立即按规则 `a`–`d` 核对并唤醒。
   - `relay.mjs send` 内置同 `last_write` 去重保护与无进展计数（配置了 `worktrees.roleWorktrees[role]` 时自动以对应 worktree 作为 `-C` 目录）：
   - **规则 a**：`AB` 停且当前任务尚无冻结 SHA 完成回执 → `relay.mjs send --role ab ...`
   - **规则 b**：`AB` 停且已交完成回执，`HUB` 停且看板未核收 → `relay.mjs send --role hub ...`
   - **规则 c**：`HUB` 停且已在看板/任务卡派发新单，`AB` 停且未接棒 → `relay.mjs send --role ab ...`
   - **规则 d**：双方都停但职责边界不明 → `relay.mjs send --role hub ...`

### §4.1 人话驾驶舱标准化输出规范（全设备统一易懂视效）

为了保证不同设备与项目巡检输出**让人一眼看懂当前在干什么**，一律采用清晰几何徽章（`●`/`◐`/`◆`/`▲`/`■`/`✓`）与自然中文状态卡片（由 `relay.mjs` 原生渲染，且**标题行与正文行之间必须留空引用行 `>` 防止 Markdown 渲染粘连**）。**严禁直接对用户吐出 `R0#hex`、`HEAD`、`Δ`、`Hold`、`Wait` 或纯英文状态代码等机械黑话**：

| 场景 | 触发时机 | 必须采用的输出方式（见 [ROLE_PROMPTS.md](./references/ROLE_PROMPTS.md#九人话驾驶舱标准化输出模板中继主会话直接复用)） |
| :--- | :--- | :--- |
| **高频静默心跳** | 每 3 分钟巡检无增量或仅需静默等待时 | 直接输出 `relay.mjs status --compact` 或 `render heartbeat --activity "..."` 生成的 **2 行人话状态卡**（中文状态标题 + 阶段进度箭头 + 谁在做什么、改动几个文件、需不需要人管）。 |
| **停滞唤醒提示** | 触发规则 a–d `send` 后 | 运行 `relay.mjs render nudge ...` 输出 **2 行 `▲ 已自动唤醒推进`** 确认，写明静默时长与投递结果。 |
| **阶段里程碑卡** | `R0` 出裁定 / 解锁下一阶段 / 新阶段正式开工时 | 运行 `relay.mjs render milestone ...` 输出 **4 列人话里程碑表**（核验结论、展开后的中文问题统计、审计报告与代码快照、接下来的自动动作）。 |
| **熔断与终局卡** | 触达 `maxFixRounds` / 阻塞 或 全批通关收官 | 运行 `relay.mjs render breaker` 或 `render complete` 输出高亮 Callout 块与终局汇总表。 |

---

## 五、服务重启 / 模型切换断点恢复与纯净值守切换协议

收到系统 `[Notice] All your subagents and background tasks have been stopped`、切换模型、或在当前会话完成建仓/配置想切入纯净无杂音的值守窗时：

1. **新开空白纯净窗口（推荐用于长挂机）**：在空白窗口发送「按 `sdd-multi-agent-relay` 断点恢复并开始巡检」；首条响应标明 `automationMode`（`full-auto` / `semi-auto`）并检查是否存在旧窗残留巡检（避免双巡检抢推送）。
2. 运行 `relay.mjs status --config "<relay.json 路径>" --json` 与 `relay.mjs state show --config "<relay.json 路径>"`。
3. 若 `activeCrossAgent` 不为空：
   - 先检查其 `outputPath` 是否已生成在磁盘上；若已落盘且内容完整，直接核验 SHA-256 并走 `finish-review` + 回传 `Codex-Hub`；
   - 若尚未落盘，**新建** `self` 子会话（避免复用旧模型失败配额会话）继续执行，并更新 `relay.mjs state start-review`。
4. 重新启动 3 分钟定时巡检 `schedule`，无需向 Codex 重复投递 `last_write` 未变化的消息。
