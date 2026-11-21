# 更新日志（CHANGELOG）

## [1.0.0] - 2026-11-21

### 初始发布（Initial Team Release）
- **规范与流程标准**：确立 `0 + (2+3)` 分权闭环架构、7 大高可用风控（返修上限熔断、长会话无损换班、CR 变更、断点外置+Webhook 告警、里程碑真机门禁、分支隔离与红线、终局简报与安全关机）。
- **文档整理与任务编号标准**：配套 8 板块 `SPEC`、5 条 `Plan`、三段式任务卡、强制顺序编号（`T-00`、`[T-01]`、`T-01-R0`、`T-01-FIX1`、`T-02-C`、`R0-T01-01`）及 `AGENTS.md` 自动生成；内置 `examples/sample-pkg/` 四联端到端范本。
- **全角色派发模板**：内置覆盖 `Codex-Hub`、`AB`（实施与返修）、`C`（真机验证）、`R0`（独立审计）、`Hub`（方案复盘）及防停/换班的完整 8 字段首部模板。
- **零固定目录与全动态会话**：支持子目录向上自动发现 `.agents/relay.json`，兼容 Windows / WSL / macOS / Linux（`posix`），支持 `threadMatchers` 标题匹配、`bind` 动态重绑与 `spawn` 一键拉起新会话；`init` 自动维护 `.gitignore`（隔离多人本机 `relay.json` 与 `.agents/relay/`）并生成团队共享 `.agents/relay.example.json`。
- **全自动安装与质量护栏**：提供 `bin/cli.mjs`（支持 `npx`、`agy plugin install`、`install`/`update`/`uninstall`/`doctor`、`.agents/plugins.json` 子模块及 `postinstall`）、Plugin `assets/logo.svg`，并配备零依赖 `npm test` 冒烟测试与 GitHub Actions CI。
