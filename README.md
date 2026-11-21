# sdd-multi-agent-relay

**规范驱动的跨端多 Agent 分权门禁工作流（`0 + (2+3)` 角色拓扑）** —— 支持 Antigravity Plugin 与独立 Skill 双模式运行，零第三方依赖兼容 **Windows 原生 / WSL / macOS / Linux**，帮助团队让 Antigravity 代替人工盯盘，带领 VS Code Codex 与独立审计会话持续、防偏、不偷懒地交付长周期研发任务。

---

## 核心特性

- **零手动文件拷贝 · 全自动安装**：支持 `agy plugin install`、`npx` 一行全自动安装、以及挂进业务仓库实现“新人克隆即生效”。
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
- **Ops-Cockpit 驾驶舱输出与多 Worktree 监控（`v1.1.0`）**：`relay.mjs status --compact` 与 `render` 子命令原生输出统一遥测条、4 列里程碑表、熔断与收官卡片；支持 `worktrees.autoDiscover` / `roleWorktrees` 与自定义角色（如 `a`/`b`）及显式 `automationMode`（`full-auto` / `semi-auto`）。

---

## 全自动安装方式（无需手动复制文件）

> 唯一前置：**Node.js >= 18**（内置跨平台自举 CLI，无任何 npm 第三方依赖）。

### 方案 A：一行命令自动安装（个人全局生效，推荐）

1. **方式 A1：`npx` 一键远程安装（Windows / macOS / Linux / WSL 通用）**
   ```bash
   # 私有仓库 HTTPS 方式（加 --with-codex 可顺带装入 ~/.codex/skills）：
   npx -y git+https://github.com/wlaowu/sdd-multi-agent-relay.git install --with-codex

   # 若团队使用 SSH Key 访问私有仓库：
   npx -y git+ssh://git@github.com/wlaowu/sdd-multi-agent-relay.git install --with-codex
   ```
   *(可选参数：`--mode skill` 仅装为全局 Skill；`--mode project` 仅装入当前项目 `.agents/skills/`；Windows 下附加 `--wsl-distro Debian` 可同时同步到 WSL 内的 Codex。)*

2. **方式 A2：Antigravity 原生 CLI 直接安装**
   ```bash
   agy plugin install https://github.com/wlaowu/sdd-multi-agent-relay.git
   ```

3. **后续自检、一键升级与卸载**：
   ```bash
   npx -y git+https://github.com/wlaowu/sdd-multi-agent-relay.git doctor     # 自检安装与 Codex 连通状态
   npx -y git+https://github.com/wlaowu/sdd-multi-agent-relay.git update     # 一键更新到最新版
   npx -y git+https://github.com/wlaowu/sdd-multi-agent-relay.git uninstall  # 干净卸载
   ```

---

### 方案 B：业务仓库级“零命令”全自动生效（推荐给研发团队）

让团队新人**不用记任何安装命令**，只要拉取业务代码（或执行常规 `npm/pnpm install`）就自动激活：

#### 方式 B1：Git Submodule + `.agents/plugins.json`（Antigravity 开箱即载，零额外命令）
在任意业务仓库执行一次登记，提交进 Git：
```bash
git submodule add https://github.com/wlaowu/sdd-multi-agent-relay.git tools/sdd-relay
```
在业务仓库新建 `.agents/plugins.json`：
```json
{
  "entries": [
    { "path": "tools/sdd-relay" }
  ]
}
```
之后任何团队成员用 `git clone --recursive <业务仓库>` 打开项目时，Antigravity 会自动发现并加载该插件！

#### 方式 B2：业务仓库 `package.json` `postinstall` 钩子自动装入本机全局
如果是前端 / Node / 全栈项目，在业务仓库 `package.json` 增加 `devDependencies` 与静默安装钩子：
```json
{
  "devDependencies": {
    "sdd-multi-agent-relay": "git+ssh://git@github.com/wlaowu/sdd-multi-agent-relay.git"
  },
  "scripts": {
    "postinstall": "sdd-multi-agent-relay install --mode plugin --with-codex --quiet || true"
  }
}
```
团队成员像往常一样跑 `pnpm install` / `npm install`，插件与 Skill 即自动安装并保持团队同版本。

---

### 方案 C：一句话让 Antigravity 对话自己装好

不习惯敲命令的同学，直接把下面这句话发给 Antigravity：
> 「请从 Git 仓库 `https://github.com/wlaowu/sdd-multi-agent-relay.git` 自动下载并运行 `node bin/cli.mjs install --mode plugin --with-codex` 安装到本地，然后跑 `doctor` 验证通过。」

---

## 2 分钟上手：初始化与日常使用

### 1. 初始化业务项目（每项目只需一次）

如果全局插件目录已安装，或通过 `npx` 调用，均可直接执行 `init`：

```powershell
# Windows 原生项目：
npx -y sdd-multi-agent-relay init --project "D:\path\to\my-project" --runtime windows --name MyApp --batch PKG-FEAT-01

# WSL 项目：
npx -y sdd-multi-agent-relay init --project "/path/to/my-project" --runtime wsl --distro Debian --name MyApp --batch PKG-FEAT-01
```

```bash
# macOS / Linux 原生项目：
npx -y sdd-multi-agent-relay init --project "/path/to/my-project" --runtime posix --name MyApp --batch PKG-FEAT-01
```

*(若未全局 npm install，也可用本地脚本 `node ~/.gemini/config/plugins/sdd-multi-agent-relay/skills/sdd-multi-agent-relay/scripts/relay.mjs init ...` 替代；脚本同时支持在项目任意目录省略 `--project/--config` 自动向上识别。)*

> **多人同仓防冲突**：`init` 会自动把本机专属 `.agents/relay.json`（含本机路径与本机 Codex 会话 UUID）和 `.agents/relay/` 写入业务仓库 `.gitignore`，同时生成不含私密数据的 `.agents/relay.example.json` 供团队共享参考；Windows / macOS / WSL 同事共用同一业务仓库互不打架。

### 2. 日常提需求的 4 句标准口令（不用手写长文档）

1. **新需求立项**：
   > 「用 `sdd-multi-agent-relay` 流程立项：我想做【做什么】，用在【哪里】，最怕【出什么错】，达到【什么标准】算完成。请按文档整理标准先输出 Spec（含 `V-xx` 验收矩阵与 `PD-xx` 待拍板项），暂不改代码。」
2. **复杂任务预审排雷**：
   > 「让 `R0` 对这份 Spec 做实施前设计预审，按极端反例补齐缺漏，把待我决定的项收敛到 `PD-01..`。」
3. **一次性拍板全自动推进**：
   > 「方案定稿，`PD-01=...`。按 `L3` 全程自动续推（最多返修 2 轮，遇熔断或阻塞通知我），转交 `Codex-Hub` 按任务编号 `[T-01]` 拆计划并开始托管。」
4. **中途改需求 / 断线续跑**：
   > 「按 `sdd-multi-agent-relay` 断点恢复协议检查当前项目进度并继续托管推进。」

---

## 仓库目录结构与开发自测

```text
sdd-multi-agent-relay/
├── package.json                        # npx / npm devDependencies / postinstall 自动安装入口
├── plugin.json                         # Antigravity Plugin 清单
├── CHANGELOG.md                        # 版本更新记录
├── assets/
│   └── logo.svg                        # Antigravity Plugin 图标
├── bin/
│   └── cli.mjs                         # 跨平台零依赖安装器 (install/update/uninstall/doctor + relay 透传)
├── test/
│   └── smoke.test.mjs                  # 零依赖全链路冒烟测试 (npm test)
├── .github/workflows/ci.yml            # GitHub Actions Linux + Windows 双端 CI
├── install.ps1                         # Windows 一键安装兼容脚本（调用 cli.mjs）
├── install.sh                          # macOS / Linux / WSL 一键安装兼容脚本（调用 cli.mjs）
├── README.md                           # 本说明文档
└── skills/sdd-multi-agent-relay/
    ├── SKILL.md                        # Antigravity Skill 核心执行手册
    ├── references/
    │   ├── WORKFLOW_SPEC_V1.0.md       # 完整工作流标准与 7 大高可用保障
    │   ├── DOC_STANDARDS.md            # Spec/计划/任务卡整理标准、任务编号规范与配模指南
    │   ├── ROLE_PROMPTS.md             # 跨会话报文与 R0/Hub/换班提示词模板
    │   └── PROJECT_CONFIG_SCHEMA.md    # relay.json Schema 与 relay.mjs CLI 手册
    ├── examples/sample-pkg/            # 完整脱敏四联范本 (Spec / Board / Task / R0 报告)
    ├── resources/                      # relay.json / SPEC / STATE / BOARD / TASK_CARD / AGENTS / FINAL_SUMMARY 模板
    └── scripts/
        └── relay.mjs                   # 跨平台零依赖中继监控 CLI
```

维护本仓库后运行 `npm test` 即可自动验证 JSON 清单、语法、敏感词隔离、`init`/向上发现/8 字段识别/熔断逻辑及自动安装卸载闭环。
