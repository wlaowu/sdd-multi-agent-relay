# sdd-multi-agent-relay

**规范驱动的跨端多 Agent 分权门禁工作流（`0 + (2+3)` 角色拓扑）** —— 支持 Antigravity Plugin 与独立 Skill 双模式运行，零第三方依赖兼容 **Windows 原生 / WSL / macOS / Linux**，帮助团队让 Antigravity 代替人工盯盘，带领 VS Code Codex 与独立审计会话持续、防偏、不偷懒地交付长周期研发任务。

---

## 核心特性

- **规范文档先行（`Spec → Plan → Task`）**：内置 8 板块 Spec 模板、5 条阶段门禁计划标准、3 段式任务卡、以及同步生成到目标仓库的 `AGENTS.md`（让 VS Code Codex 开局即懂团队协作铁律）。
- **强制全链路任务编号**：每个阶段与任务名称末尾均须附带唯一顺序编号（预审 `T-00`，实施 `<任务名> [T-01]`、`[T-02]`…），同源派生 `T-01-R0`（审计）、`T-01-FIX1`（返修）、`T-02-C`（真机验收）、`R0-T01-01`（问题号）与 `feat(T-01):` 提交前缀，做到问题、代码与报告一一可追溯。
- **`0 + (2+3)` 分权闭环**：总控中继（防停推动/跨端转发）+ `Hub`（方案定稿）+ `Codex-Hub`（拆单管看板，禁改源码）+ `AB`（单点写锁编码冻结 40 位 SHA）+ `C`（真机里程碑验证）+ `R0`（隔离目录只读独立审计）。
- **七大高可用风控**：
  1. 单阶段返修上限熔断（默认最多 `2` 轮防死循环）；
  2. 长会话无损换班（`rotate-thread` / `spawn`）；
  3. 中途变更规范流程（Spec Patch / CR）；
  4. 断点状态外置（`relay-state.json`）+ 飞书/企微/钉钉/通用 Webhook 告警；
  5. 阶段离线门禁 vs 里程碑真机门禁分离；
  6. 特性分支 + 门禁 Tag + 高危红线约束；
  7. 终局 `FINAL_SUMMARY.md`（含效能复盘统计）与可选安全关机协议。
- **零固定目录、零固定会话**：在任意项目任意子目录自动向上发现 `.agents/relay.json`；Codex 会话支持 **标题动态匹配（`threadMatchers`）**、**随时关键词改绑（`bind --match`）** 与 **一键自动新建会话（`spawn`）**。

---

## 团队安装与一键升级

> 依赖环境：**Node.js >= 18**（用于执行零依赖 `relay.mjs`）。

### 方式一：直接克隆进 Antigravity 插件目录（推荐，`git pull` 一键升级）

克隆至 `~/.gemini/config/plugins/sdd-multi-agent-relay` 后立即作为 Antigravity Plugin 生效：

- **Windows (PowerShell)**：
  ```powershell
  mkdir "$env:USERPROFILE\.gemini\config\plugins" -Force | Out-Null
  git clone <团队私有仓库_URL> "$env:USERPROFILE\.gemini\config\plugins\sdd-multi-agent-relay"
  # 后续升级：
  git -C "$env:USERPROFILE\.gemini\config\plugins\sdd-multi-agent-relay" pull
  ```
- **macOS / Linux / WSL**：
  ```bash
  mkdir -p ~/.gemini/config/plugins
  git clone <团队私有仓库_URL> ~/.gemini/config/plugins/sdd-multi-agent-relay
  # 后续升级：
  git -C ~/.gemini/config/plugins/sdd-multi-agent-relay pull
  ```

### 方式二：先克隆到任意目录，再用安装脚本安装为 Plugin 或独立 Skill

```powershell
# Windows PowerShell
git clone <团队私有仓库_URL> sdd-multi-agent-relay
cd sdd-multi-agent-relay
.\install.ps1                  # 安装为 Plugin（默认）
# .\install.ps1 -Mode skill    # 或安装为独立 Skill
```

```bash
# macOS / Linux / WSL
git clone <团队私有仓库_URL> sdd-multi-agent-relay
cd sdd-multi-agent-relay
bash ./install.sh              # 安装为 Plugin（默认）
# bash ./install.sh -m skill   # 或安装为独立 Skill
```

### 方式三：随业务仓库共享（Team Repo Sharing）

把本仓库作为 Git Submodule 挂载到业务项目（如 `tools/sdd-relay`），并在业务仓库 `.agents/skills.json` 注册：

```json
{
  "entries": [
    { "path": "tools/sdd-relay/skills" }
  ]
}
```

---

## 2 分钟上手：团队成员日常怎么用

### 1. 初始化业务项目（每项目只需一次）

```powershell
# Windows 原生项目：
node "$env:USERPROFILE\.gemini\config\plugins\sdd-multi-agent-relay\skills\sdd-multi-agent-relay\scripts\relay.mjs" init `
  --project "D:\path\to\my-project" --runtime windows --name MyApp --batch PKG-FEAT-01

# WSL 项目：
node "$env:USERPROFILE\.gemini\config\plugins\sdd-multi-agent-relay\skills\sdd-multi-agent-relay\scripts\relay.mjs" init `
  --project "/path/to/my-project" --runtime wsl --distro Debian --name MyApp --batch PKG-FEAT-01
```

```bash
# macOS / Linux 原生项目：
node ~/.gemini/config/plugins/sdd-multi-agent-relay/skills/sdd-multi-agent-relay/scripts/relay.mjs init \
  --project "/path/to/my-project" --runtime posix --name MyApp --batch PKG-FEAT-01
```

> 请确保在业务仓库 `.gitignore` 中包含 `.agents/relay/`，避免把运行时状态与队列日志误提交进业务代码。

### 2. 日常提需求的 4 句标准口令（不用手写长文档）

1. **新需求立项**：
   > 「用 `sdd-multi-agent-relay` 流程立项：我想做【做什么】，用在【哪里】，最怕【出什么错】，达到【什么标准】算完成。请按文档整理标准先输出 Spec（含 `V-xx` 验收矩阵与 `PD-xx` 待拍板项），暂不改代码。」
2. **复杂任务预审排雷**：
   > 「让 `R0` 对这份 Spec 做实施前设计预审，按极端反例补齐缺漏，把待我决定的项收敛到 `PD-01..`。」
3. **一次性拍板全自动推进**：
   > 「方案定稿，`PD-01=...`。按 `L3` 全程自动续推（最多返修 2 轮，遇熔断或阻塞通知我），转交 `Codex-Hub` 拆计划并开始托管。」
4. **中途改需求 / 断线续跑**：
   > 「按 `sdd-multi-agent-relay` 断点恢复协议检查当前项目进度并继续托管推进。」

---

## 仓库目录结构

```text
sdd-multi-agent-relay/
├── plugin.json                         # Antigravity Plugin 清单
├── install.ps1                         # Windows 安装与更新脚本
├── install.sh                          # macOS / Linux / WSL 安装与更新脚本
├── README.md                           # 本说明文档
└── skills/sdd-multi-agent-relay/
    ├── SKILL.md                        # Antigravity Skill 核心执行手册
    ├── references/
    │   ├── WORKFLOW_SPEC_V1.0.md       # 完整工作流标准与 7 大高可用保障
    │   ├── DOC_STANDARDS.md            # Spec/计划/任务卡整理标准与配模指南
    │   ├── ROLE_PROMPTS.md             # 跨会话报文与 R0/Hub/换班提示词模板
    │   └── PROJECT_CONFIG_SCHEMA.md    # relay.json Schema 与 relay.mjs CLI 手册
    ├── resources/                      # relay.json / SPEC / STATE / BOARD / TASK_CARD / AGENTS / FINAL_SUMMARY 模板
    └── scripts/
        └── relay.mjs                   # 跨平台零依赖中继监控 CLI
```
