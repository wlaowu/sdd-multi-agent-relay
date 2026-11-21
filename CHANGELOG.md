# 更新日志（CHANGELOG）

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
