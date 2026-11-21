import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'cli.mjs');
const RELAY_PATH = path.join(REPO_ROOT, 'skills', 'sdd-multi-agent-relay', 'scripts', 'relay.mjs');

function runNode(args, cwd = REPO_ROOT) {
  return spawnSync(process.execPath, args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
}

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

test('manifests, templates, and scripts syntax are valid', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.name, 'sdd-multi-agent-relay');
  assert.equal(pkg.type, 'module');

  const plugin = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'plugin.json'), 'utf8'));
  const allowedKeys = new Set([
    'name', 'description', 'logo', 'suggestedPrompts',
    'displayName', 'version', 'author', 'homepage', 'repository', 'disabled',
  ]);
  for (const k of Object.keys(plugin)) {
    assert.ok(allowedKeys.has(k), `Unexpected plugin.json field: ${k}`);
  }
  assert.ok(plugin.logo && fs.existsSync(path.join(REPO_ROOT, plugin.logo)), 'plugin.json logo must exist');
  assert.ok(Array.isArray(plugin.suggestedPrompts) && plugin.suggestedPrompts.length <= 3);

  const tpl = JSON.parse(fs.readFileSync(
    path.join(REPO_ROOT, 'skills', 'sdd-multi-agent-relay', 'resources', 'relay.json.template'),
    'utf8',
  ));
  assert.equal(tpl.version, '1.0');

  for (const script of [CLI_PATH, RELAY_PATH]) {
    const chk = runNode(['--check', script]);
    assert.equal(chk.status, 0, `Syntax check failed for ${script}: ${chk.stderr}`);
  }
});

test('repository contains no secrets or hardcoded personal/project paths', () => {
  const secretRe = new RegExp(['gh' + 'p_', 'sk' + '-[A-Za-z0-9]{16,}', 'AKI' + 'A[0-9A-Z]{16}'].join('|'));
  const hardcodedRe = new RegExp(['Hy' + 'pit', 'hy' + 'pit', 'Le' + 'novo', '01a1' + 'f', '/o' + 'pt/'].join('|'));

  for (const file of listFilesRecursive(REPO_ROOT)) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(secretRe.test(content), false, `Potential secret leaked in ${file}`);
    assert.equal(hardcodedRe.test(content), false, `Hardcoded environment string in ${file}`);
  }
});

test('relay.mjs init enforces multi-dev gitignore isolation, preserves existing AGENTS.md, and discovers config upward', () => {
  const tmp = makeTempDir('sdd-relay-init-');
  try {
    const projA = path.join(tmp, 'proj-a');
    fs.mkdirSync(path.join(projA, 'packages', 'web'), { recursive: true });

    const initA = runNode([CLI_PATH, 'init', '--project', projA, '--runtime', 'macos', '--name', 'OrderApp', '--batch', 'PKG-ORD-01']);
    assert.equal(initA.status, 0, initA.stderr);

    const cfg = JSON.parse(fs.readFileSync(path.join(projA, '.agents', 'relay.json'), 'utf8'));
    assert.equal(cfg.runtime, 'posix');
    assert.equal(cfg.threadMatchers.ab, 'OrderApp-AB');

    const exampleCfg = JSON.parse(fs.readFileSync(path.join(projA, '.agents', 'relay.example.json'), 'utf8'));
    assert.equal(exampleCfg.projectPath, '<LOCAL_REPO_PATH>');

    const gi = fs.readFileSync(path.join(projA, '.gitignore'), 'utf8');
    assert.match(gi, /\.agents\/relay\//);
    assert.match(gi, /\.agents\/relay\.json/);
    assert.ok(fs.existsSync(path.join(projA, 'AGENTS.md')));

    // Upward config discovery from nested directory without --config or --project
    const statusRes = runNode([CLI_PATH, 'status', '--json'], path.join(projA, 'packages', 'web'));
    assert.equal(statusRes.status, 0, statusRes.stderr);
    const statusObj = JSON.parse(statusRes.stdout);
    assert.equal(statusObj.projectName, 'OrderApp');
    assert.equal(statusObj.pendingCrossAgent.length, 0);

    // Existing AGENTS.md must not be overwritten
    const projB = path.join(tmp, 'proj-b');
    fs.mkdirSync(projB, { recursive: true });
    fs.writeFileSync(path.join(projB, 'AGENTS.md'), '# Existing Custom Rules\nDO_NOT_TOUCH\n', 'utf8');
    const initB = runNode([CLI_PATH, 'init', '--project', projB, '--runtime', 'windows', '--name', 'ExistingApp', '--batch', 'PKG-EX-01']);
    assert.equal(initB.status, 0, initB.stderr);
    assert.match(fs.readFileSync(path.join(projB, 'AGENTS.md'), 'utf8'), /DO_NOT_TOUCH/);
    assert.ok(fs.existsSync(path.join(projB, '.agents', 'development', 'AGENTS_WORKFLOW_SNIPPET.md')));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('relay.mjs detects 8-field Antigravity dispatches and enforces fix-cap & notify dry-run', () => {
  const tmp = makeTempDir('sdd-relay-state-');
  try {
    const initRes = runNode([CLI_PATH, 'init', '--project', tmp, '--runtime', 'windows', '--name', 'NumApp', '--batch', 'PKG-NUM-01']);
    assert.equal(initRes.status, 0, initRes.stderr);

    const r0Card = path.join(tmp, '.agents', 'development', 'tasks', 'R0-review.md');
    fs.appendFileSync(r0Card, [
      '',
      '## 底座审核 [T-01-R0]',
      '发送到：Antigravity',
      '发送方：Codex-Hub',
      '接收会话：R0',
      '任务编号：T-01-R0',
      '任务名称：底座审核 [T-01-R0]',
      '所属批次：PKG-NUM-01',
      '发送时机：现在',
      '投递状态：待转交（由 Antigravity 中继转交）',
      '',
    ].join('\n'), 'utf8');

    const st = JSON.parse(runNode([CLI_PATH, 'status', '--project', tmp, '--json']).stdout);
    assert.ok(st.pendingCrossAgent.length >= 1, 'Expected 8-field Antigravity dispatch to be detected');

    const cfgPath = path.join(tmp, '.agents', 'relay.json');
    const r1 = JSON.parse(runNode([RELAY_PATH, 'state', '--config', cfgPath, 'finish-review', '--task', 'T-01-R0', '--verdict', '要求整改', '--report', 'r1.md', '--sha256', 'aaa1']).stdout);
    assert.equal(r1.stageKey, 'T-01');
    assert.equal(r1.fixCapBreaker, false);

    const r2 = JSON.parse(runNode([RELAY_PATH, 'state', '--config', cfgPath, 'finish-review', '--task', 'T-01-FIX1-R0', '--verdict', '要求整改', '--report', 'r2.md', '--sha256', 'aaa2']).stdout);
    assert.equal(r2.stageKey, 'T-01');
    assert.equal(r2.fixCount, 2);
    assert.equal(r2.fixCapBreaker, true);

    const r3 = JSON.parse(runNode([RELAY_PATH, 'state', '--config', cfgPath, 'finish-review', '--task', 'T-02-C-R0', '--verdict', '通过', '--report', 'r3.md', '--sha256', 'bbb1']).stdout);
    assert.equal(r3.stageKey, 'T-02');

    const bindRes = runNode([CLI_PATH, 'bind', '--project', tmp, '--role', 'ab', '--auto']);
    assert.equal(bindRes.status, 0, bindRes.stderr);

    const spawnRes = runNode([CLI_PATH, 'spawn', '--project', tmp, '--role', 'hub', '--dry-run']);
    assert.equal(spawnRes.status, 0, spawnRes.stderr);
    assert.equal(JSON.parse(spawnRes.stdout).sandbox, 'read-only');

    const notifyRes = runNode([CLI_PATH, 'notify', '--project', tmp, '--event', 'circuit_breaker', '--title', 'Test', '--message', 'Fix cap', '--dry-run']);
    assert.equal(notifyRes.status, 0, notifyRes.stderr);
    assert.equal(JSON.parse(notifyRes.stdout).dryRun, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('auto-installer lifecycle (install plugin+codex, doctor, project mode, update, uninstall) works in isolation', () => {
  const tmp = makeTempDir('sdd-cli-e2e-');
  const tmpHome = path.join(tmp, 'home');
  const tmpProj = path.join(tmp, 'proj');
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.mkdirSync(tmpProj, { recursive: true });

  try {
    const inst = runNode([CLI_PATH, 'install', '--mode', 'plugin', '--home', tmpHome, '--with-codex']);
    assert.equal(inst.status, 0, inst.stderr);
    assert.ok(fs.existsSync(path.join(tmpHome, '.gemini', 'config', 'plugins', 'sdd-multi-agent-relay', 'plugin.json')));
    assert.ok(fs.existsSync(path.join(tmpHome, '.gemini', 'config', 'plugins', 'sdd-multi-agent-relay', 'assets', 'logo.svg')));
    assert.ok(fs.existsSync(path.join(tmpHome, '.gemini', 'config', 'plugins', 'sdd-multi-agent-relay', 'skills', 'sdd-multi-agent-relay', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(tmpHome, '.codex', 'skills', 'sdd-multi-agent-relay', 'SKILL.md')));

    const doc = JSON.parse(runNode([CLI_PATH, 'doctor', '--home', tmpHome]).stdout);
    assert.equal(doc.ok, true);
    assert.equal(doc.pluginInstalled, true);
    assert.equal(doc.pluginManifestValid, true);
    assert.equal(doc.pluginLogoOk, true);
    assert.equal(doc.codexSkillInstalled, true);
    assert.equal(doc.relaySyntaxOk, true);

    const projInst = runNode([CLI_PATH, 'install', '--mode', 'project', '--project', tmpProj]);
    assert.equal(projInst.status, 0, projInst.stderr);
    assert.ok(fs.existsSync(path.join(tmpProj, '.agents', 'skills', 'sdd-multi-agent-relay', 'SKILL.md')));

    const upd = runNode([CLI_PATH, 'update', '--mode', 'plugin', '--home', tmpHome, '--with-codex']);
    assert.equal(upd.status, 0, upd.stderr);

    const uninst = runNode([CLI_PATH, 'uninstall', '--mode', 'plugin', '--home', tmpHome, '--with-codex']);
    assert.equal(uninst.status, 0, uninst.stderr);
    assert.equal(fs.existsSync(path.join(tmpHome, '.gemini', 'config', 'plugins', 'sdd-multi-agent-relay')), false);
    assert.equal(fs.existsSync(path.join(tmpHome, '.codex', 'skills', 'sdd-multi-agent-relay')), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

function runGitCmd(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
}

test('v1.2.0 human-readable Chinese cockpit output, render subcommands, custom roles, and multi-worktree telemetry work', () => {
  const tmp = makeTempDir('sdd-wt-test-');
  const mainRepo = path.join(tmp, 'main-repo');
  const wtA = path.join(tmp, 'wt-a');
  fs.mkdirSync(mainRepo, { recursive: true });

  try {
    assert.equal(runGitCmd(mainRepo, ['init']).status, 0);
    assert.equal(runGitCmd(mainRepo, ['config', 'user.name', 'Test User']).status, 0);
    assert.equal(runGitCmd(mainRepo, ['config', 'user.email', 'test@example.com']).status, 0);
    fs.writeFileSync(path.join(mainRepo, 'README.md'), '# Demo Repo\n', 'utf8');
    assert.equal(runGitCmd(mainRepo, ['add', 'README.md']).status, 0);
    assert.equal(runGitCmd(mainRepo, ['commit', '-m', 'chore: init']).status, 0);

    const wtRes = runGitCmd(mainRepo, ['worktree', 'add', '-b', 'feat/worker-a', wtA]);
    assert.equal(wtRes.status, 0, wtRes.stderr);
    fs.writeFileSync(path.join(wtA, 'dirty.txt'), 'uncommitted change\n', 'utf8');

    const initRes = runNode([CLI_PATH, 'init', '--project', mainRepo, '--runtime', 'windows', '--name', 'WtApp', '--batch', 'PKG-WT-01', '--automation-mode', 'semi-auto']);
    assert.equal(initRes.status, 0, initRes.stderr);

    // Bind custom role 'a' and configure explicit roleWorktrees
    const cfgPath = path.join(mainRepo, '.agents', 'relay.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.worktrees = { autoDiscover: true, roleWorktrees: { a: '../wt-a' } };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const bindCustom = runNode([CLI_PATH, 'bind', '--project', mainRepo, '--role', 'a', '--auto', '--match', 'WtApp-Worker-A']);
    assert.equal(bindCustom.status, 0, bindCustom.stderr);
    assert.equal(JSON.parse(bindCustom.stdout).role, 'a');

    const stRes = runNode([CLI_PATH, 'status', '--project', mainRepo, '--json']);
    assert.equal(stRes.status, 0, stRes.stderr);
    const st = JSON.parse(stRes.stdout);
    assert.equal(st.automationMode, 'semi-auto');
    assert.ok(st.roles.a, 'Expected custom role "a" in status.roles');
    assert.ok(Array.isArray(st.worktrees) && st.worktrees.length >= 1, 'Expected configured/discovered worktrees');
    const wtEntry = st.worktrees.find((w) => w.role === 'a');
    assert.ok(wtEntry && wtEntry.exists && wtEntry.dirtyCount === 1, `Expected wt-a dirtyCount=1, got ${JSON.stringify(wtEntry)}`);
    assert.match(st.telemetryLine, /PKG-WT-01/);
    assert.match(st.telemetryLine, /改动 1 个文件/);
    assert.equal(/(?:\bHold\b|\bWait\b|Δ)/.test(st.telemetryLine), false, 'Human telemetry must not contain Hold/Wait/Delta jargon');

    const compactRes = runNode([CLI_PATH, 'status', '--project', mainRepo, '--compact']);
    assert.equal(compactRes.status, 0, compactRes.stderr);
    assert.match(compactRes.stdout, /改动 1 个文件/);

    const hbActRes = runNode([CLI_PATH, 'render', 'heartbeat', '--project', mainRepo, '--activity', '正在运行构建与验证']);
    assert.equal(hbActRes.status, 0, hbActRes.stderr);
    assert.match(hbActRes.stdout, /正在运行构建与验证/);

    const nudgeRes = runNode([CLI_PATH, 'render', 'nudge', '--project', mainRepo, '--role', 'a', '--task', 'T-01', '--idle', '210', '--file', 'msg-a-001.txt', '--exit', '0']);
    assert.equal(nudgeRes.status, 0, nudgeRes.stderr);
    assert.match(nudgeRes.stdout, /▲ \*\*已自动唤醒推进\*\*/);
    assert.match(nudgeRes.stdout, /3 分 30 秒/);
    assert.match(nudgeRes.stdout, /投递成功/);

    const msRes = runNode([CLI_PATH, 'render', 'milestone', '--project', mainRepo, '--task', 'T-01-R0', '--verdict', '通过', '--gate', 'T-02 已解锁', '--sha', '1234567890abcdef', '--parent', '0000000011111111', '--report', 'T-01-R0-review.md', '--sha256', 'deadbeefcafebabe', '--counts', '0 / 0 / 0 / 1 / 2']);
    assert.equal(msRes.status, 0, msRes.stderr);
    assert.match(msRes.stdout, /◆ \*\*阶段里程碑/);
    assert.match(msRes.stdout, /审核通过/);
    assert.match(msRes.stdout, /阻断 0 · 高危 0 · 中危 0 · 低危 1 · 建议 2/);

    const brRes = runNode([CLI_PATH, 'render', 'breaker', '--project', mainRepo, '--task', 'T-01-FIX2-R0', '--reason', 'maxFixRounds reached']);
    assert.equal(brRes.status, 0, brRes.stderr);
    assert.match(brRes.stdout, /■ 自动推进已暂停/);

    const compRes = runNode([CLI_PATH, 'render', 'complete', '--project', mainRepo, '--stages', 'T-01:12345678:1:T-01-FIX1-R0-review.md:abcd1234:PASS', '--countdown', '120']);
    assert.equal(compRes.status, 0, compRes.stderr);
    assert.match(compRes.stdout, /✓ 全部阶段已完成/);
    assert.match(compRes.stdout, /T-01-FIX1-R0-review\.md/);
    assert.match(compRes.stdout, /120 秒后自动关机/);
  } finally {
    try {
      runGitCmd(mainRepo, ['worktree', 'remove', '--force', wtA]);
    } catch {
      // ignore cleanup error
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('v1.3.0 Golden Triangle: waves, analyze, event bus, stageTimers, compact archive, and offline HTML UI work', () => {
  const tmp = makeTempDir('sdd-v13-test-');
  try {
    const cliHelp = runNode([CLI_PATH, '--help']);
    assert.equal(cliHelp.status, 0, cliHelp.stderr);
    for (const cmdName of ['analyze', 'event', 'compact', 'ui']) {
      assert.ok(cliHelp.stdout.includes(cmdName), `cli --help should list ${cmdName}`);
    }
    const relayHelp = runNode([RELAY_PATH, '--help']);
    assert.equal(relayHelp.status, 0, relayHelp.stderr);
    for (const cmdName of ['analyze', 'event', 'compact', 'ui']) {
      assert.ok(relayHelp.stdout.includes(cmdName), `relay --help should list ${cmdName}`);
    }

    const initRes = runNode([CLI_PATH, 'init', '--project', tmp, '--runtime', 'windows', '--name', 'TriApp', '--batch', 'PKG-TRI-01']);
    assert.equal(initRes.status, 0, initRes.stderr);

    const cfg = JSON.parse(fs.readFileSync(path.join(tmp, '.agents', 'relay.json'), 'utf8'));
    assert.equal(cfg.version, '1.0');
    assert.deepEqual(cfg.waves, []);
    assert.deepEqual(cfg.contextBudgets, { stateMaxLines: 120, boardMaxLines: 160, taskCardMaxLines: 250 });

    const agentsMd = fs.readFileSync(path.join(tmp, 'AGENTS.md'), 'utf8');
    assert.match(agentsMd, /Red → Green TDD/);
    assert.match(agentsMd, /两段式独立审计/);
    assert.match(agentsMd, /event emit/);

    const abCard = fs.readFileSync(path.join(tmp, '.agents', 'development', 'tasks', 'AB-codex.md'), 'utf8');
    assert.match(abCard, /所属波次/);
    assert.match(abCard, /Red → Green TDD/);

    // Write valid approved Spec with V-01/V-02 and decided PD-01
    const specPath = path.join(tmp, '.agents', 'development', 'specs', 'CORE_SPEC_V0.1.md');
    fs.writeFileSync(specPath, [
      '# CORE 实施方案（V0.1）',
      '',
      '- **文档版本与效力**：`V0.1` · `[已批准方案·本次执行依据]`',
      '',
      '## 5. 分层验收矩阵',
      '| 编号 | 验收项 | 验证层级 | 量化通过标准 |',
      '| --- | :--- | :--- | :--- |',
      '| `V-01` | 底座波次就绪 | `离线单测` | `退出码 0` |',
      '| `V-02` | 并行模块交付 | `离线单测` | `退出码 0` |',
      '',
      '## 8. 待拍板决策清单',
      '| 决策 ID | 问题描述 | 备选方案 | 推荐建议 | 用户最终拍板 |',
      '| --- | :--- | :--- | :--- | :--- |',
      '| `PD-01` | 并行波次策略 | `A: 按波次 / B: 单线` | `推荐 A` | `已拍板：按 A 执行` |',
      '',
    ].join('\n'), 'utf8');

    // Write clean multi-wave board (W0 done, W1 done, W2 parallel ready T-02 & T-03)
    const boardPath = path.join(tmp, '.agents', 'development', 'DISPATCH_BOARD.md');
    const cleanBoardContent = [
      '# TriApp 任务调度看板（DISPATCH_BOARD）',
      '',
      '- **活跃批次**：`PKG-TRI-01`（分级：`L3`）',
      '',
      '## 1. 阶段任务总表（每个任务标题末尾均须带 `[T-xx]` 编号）',
      '',
      '| 任务编号 | 波次/依赖 | 任务名称、目标与门禁（末尾带编号） | 执行／审计角色 | 固定对象（40 位 SHA / 基线） | 状态 | 返修轮次 | 报告／证据索引 |',
      '| --- | :---: | --- | --- | --- | --- | --- | --- |',
      '| `T-00` | `W0` | 方案定稿与实施前独立预审 `[T-00]` | `Hub` / `R0` | `基线` | 通过 | `0` | — |',
      '| `T-01` | `W1` | 底座初始化 `[T-01]` | `AB` | `1111111111111111111111111111111111111111` | 通过 | `0` | — |',
      '| `T-02` | `W2（依赖 T-01）` | 模块 A 实施 `[T-02]` | `AB` | `待实施` | 待派发 | `0` | — |',
      '| `T-03` | `W2（依赖 T-01）` | 模块 B 实施 `[T-03]` | `AB` | `待实施` | 待派发 | `0` | — |',
      '',
      '## 2. 时序署名调度日志',
      '',
      '| 时间 | 任务编号 | 动作摘要 | 来源 → 去向 | 关联 SHA / 版本 | 备注与核收凭据 |',
      '| --- | --- | --- | --- | --- | --- |',
      '| `2026-11-21T10:00:00+08:00` | `PKG-TRI-01` | 初始化协作看板 | 初始化脚手架 | `—` | 使用 `sdd-multi-agent-relay` v1.3 创建 |',
      '',
    ].join('\n');
    fs.writeFileSync(boardPath, cleanBoardContent, 'utf8');

    // Wave parsing verification via status --json
    const waveStatus = JSON.parse(runNode([CLI_PATH, 'status', '--project', tmp, '--json']).stdout);
    assert.equal(waveStatus.waves.hasWaves, true);
    assert.equal(waveStatus.waves.currentWave, 'W2');
    assert.deepEqual(waveStatus.waves.parallelReady, ['T-02', 'T-03']);
    assert.equal(waveStatus.waves.canParallelize, true);

    // Pre-flight analyze --json passes cleanly
    const analyzeOk = runNode([CLI_PATH, 'analyze', '--project', tmp, '--json']);
    assert.equal(analyzeOk.status, 0, analyzeOk.stderr || analyzeOk.stdout);
    const analyzeOkJson = JSON.parse(analyzeOk.stdout);
    assert.equal(analyzeOkJson.ok, true);
    assert.equal(analyzeOkJson.errorCount, 0);

    // Inject duplicate task ID, missing [T-xx] tag, and broken link -> analyze must exit 1
    const brokenBoardContent = cleanBoardContent.replace(
      '| `T-03` | `W2（依赖 T-01）` | 模块 B 实施 `[T-03]` | `AB` | `待实施` | 待派发 | `0` | — |',
      [
        '| `T-02` | `W2（依赖 T-01）` | 重复编号任务 `[T-02]` | `AB` | `待实施` | 待派发 | `0` | — |',
        '| `T-03` | `W2（依赖 T-01）` | 缺失编号后缀的任务 | `AB` | `待实施` | 待派发 | `0` | [broken](./missing-report.md) |',
      ].join('\n'),
    );
    fs.writeFileSync(boardPath, brokenBoardContent, 'utf8');
    const analyzeBad = runNode([CLI_PATH, 'analyze', '--project', tmp, '--json']);
    assert.equal(analyzeBad.status, 1, 'analyze must exit non-zero on duplicate task ID / missing tag / broken link');
    const analyzeBadJson = JSON.parse(analyzeBad.stdout);
    assert.equal(analyzeBadJson.ok, false);
    const errCodes = new Set(analyzeBadJson.errors.map((e) => e.code));
    assert.ok(errCodes.has('BOARD_DUPLICATE_TASK_ID'));
    assert.ok(errCodes.has('BOARD_MISSING_TASK_TAG'));
    assert.ok(errCodes.has('BOARD_BROKEN_LINK'));

    // Restore clean board
    fs.writeFileSync(boardPath, cleanBoardContent, 'utf8');

    // Event bus emit -> status --json detects pendingEvents & human telemetry -> start/finish-review timers -> ack -> clear
    const emitRes = runNode([
      CLI_PATH, 'event', 'emit', '--project', tmp,
      '--role', 'ab', '--type', 'review_ready', '--task', 'T-02',
      '--sha', '2222222222222222222222222222222222222222',
      '--message', 'T-02 已冻结 SHA 并完成 Red→Green 实测',
    ]);
    assert.equal(emitRes.status, 0, emitRes.stderr);
    const emitJson = JSON.parse(emitRes.stdout);
    assert.equal(emitJson.ok, true);
    assert.equal(emitJson.pendingCount, 1);

    const listRes = runNode([CLI_PATH, 'event', 'list', '--project', tmp, '--json']);
    assert.equal(listRes.status, 0, listRes.stderr);
    assert.equal(JSON.parse(listRes.stdout).pendingCount, 1);

    const evStatus = JSON.parse(runNode([CLI_PATH, 'status', '--project', tmp, '--json']).stdout);
    assert.equal(evStatus.pendingEvents.length, 1);
    assert.match(evStatus.telemetryLine, /◆ \*\*收到事件信号\*\*/);
    assert.match(evStatus.telemetryLine, /已耗时/);
    assert.equal(/(?:\bHold\b|\bWait\b|\bHEAD\b|Δ|R0#)/.test(evStatus.telemetryLine), false);
    assert.ok(evStatus.stageTimers['T-02'], 'Expected stageTimers entry for T-02');

    const startRev = runNode([
      CLI_PATH, 'state', 'start-review', '--project', tmp,
      '--task', 'T-02-R0', '--role', 'R0',
      '--subagent', '11111111-1111-1111-1111-111111111111',
      '--output', 'audits/PKG-TRI-01/T-02-R0-review.md',
    ]);
    assert.equal(startRev.status, 0, startRev.stderr);
    const finishRev = runNode([
      CLI_PATH, 'state', 'finish-review', '--project', tmp,
      '--task', 'T-02-R0', '--verdict', '通过',
      '--report', 'audits/PKG-TRI-01/T-02-R0-review.md',
      '--sha256', 'deadbeef',
    ]);
    assert.equal(finishRev.status, 0, finishRev.stderr);
    const finishJson = JSON.parse(finishRev.stdout);
    assert.equal(typeof finishJson.reviewDurationSec, 'number');
    assert.equal(typeof finishJson.stageElapsedSec, 'number');

    const ackRes = runNode([CLI_PATH, 'event', 'ack', '--project', tmp, '--all']);
    assert.equal(ackRes.status, 0, ackRes.stderr);
    assert.equal(JSON.parse(ackRes.stdout).remainingPending, 0);

    const afterAckStatus = JSON.parse(runNode([CLI_PATH, 'status', '--project', tmp, '--json']).stdout);
    assert.equal(afterAckStatus.pendingEvents.length, 0);

    const clearRes = runNode([CLI_PATH, 'event', 'clear', '--project', tmp]);
    assert.equal(clearRes.status, 0, clearRes.stderr);
    assert.equal(JSON.parse(clearRes.stdout).remainingCount, 0);

    // Append 25 scheduling log rows -> compact --dry-run -> compact --apply --keep-logs 5
    const extraLogs = [];
    for (let i = 1; i <= 25; i++) {
      const hh = String(i % 24).padStart(2, '0');
      extraLogs.push(`| \`2026-11-21T12:${hh}:00+08:00\` | \`T-01\` | 巡检调度记录 #${i} | \`AB\` → \`Codex-Hub\` | \`—\` | 正常推进 |`);
    }
    fs.writeFileSync(boardPath, cleanBoardContent + extraLogs.join('\n') + '\n', 'utf8');

    const dryCompact = runNode([CLI_PATH, 'compact', '--project', tmp, '--dry-run', '--keep-logs', '5', '--json']);
    assert.equal(dryCompact.status, 0, dryCompact.stderr);
    const dryJson = JSON.parse(dryCompact.stdout);
    assert.equal(dryJson.mode, 'dry-run');
    assert.equal(dryJson.board.totalLogRows, 26);
    assert.equal(dryJson.board.archivableLogRows, 21);
    assert.equal(dryJson.board.archivedCount, 0);

    const applyCompact = runNode([CLI_PATH, 'compact', '--project', tmp, '--apply', '--keep-logs', '5', '--json']);
    assert.equal(applyCompact.status, 0, applyCompact.stderr);
    const applyJson = JSON.parse(applyCompact.stdout);
    assert.equal(applyJson.mode, 'apply');
    assert.equal(applyJson.board.archivedCount, 21);
    assert.equal(applyJson.board.keptLogRows, 5);
    assert.ok(applyJson.board.archiveFile && fs.existsSync(applyJson.board.archiveFile), 'Archive file must exist');
    assert.match(fs.readFileSync(applyJson.board.archiveFile, 'utf8'), /巡检调度记录 #1/);

    const compactedBoard = fs.readFileSync(boardPath, 'utf8');
    assert.match(compactedBoard, /历史调度日志已归档（21 条）/);
    assert.match(compactedBoard, /巡检调度记录 #25/);
    assert.equal(/巡检调度记录 #1 \|/.test(compactedBoard), false);
    assert.match(compactedBoard, /\| `T-00` \| `W0` \|/);

    // Ensure compacted board archive reference passes analyze cleanly
    const postCompactAnalyze = runNode([CLI_PATH, 'analyze', '--project', tmp, '--json']);
    assert.equal(postCompactAnalyze.status, 0, postCompactAnalyze.stdout);

    // Export offline zero-external-link Chinese HTML cockpit
    const htmlOut = path.join(tmp, 'cockpit.html');
    const uiRes = runNode([CLI_PATH, 'ui', '--project', tmp, '--export', htmlOut]);
    assert.equal(uiRes.status, 0, uiRes.stderr);
    const uiJson = JSON.parse(uiRes.stdout);
    assert.equal(uiJson.ok, true);
    assert.ok(fs.existsSync(htmlOut));
    const html = fs.readFileSync(htmlOut, 'utf8');
    assert.match(html, /<!DOCTYPE html>/i);
    assert.match(html, /TriApp/);
    assert.match(html, /中文协同驾驶舱/);
    assert.match(html, /波次并行推进/);
    assert.match(html, /待处理事件信号/);
    assert.equal(/https?:\/\//i.test(html), false, 'Exported HTML cockpit must contain zero external http/https URLs');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('v1.3.1 bugfixes: blockquote blank-line spacing and ppid orphan process detection work', () => {
  const tmp = makeTempDir('sdd-v131-test-');
  try {
    const cliHelp = runNode([CLI_PATH, '--help']);
    assert.equal(cliHelp.status, 0, cliHelp.stderr);
    assert.ok(cliHelp.stdout.includes('procs'), 'cli --help should list procs');

    const relayHelp = runNode([RELAY_PATH, '--help']);
    assert.equal(relayHelp.status, 0, relayHelp.stderr);
    assert.ok(relayHelp.stdout.includes('procs'), 'relay --help should list procs');
    assert.ok(relayHelp.stdout.includes('--check-procs'), 'relay --help should list --check-procs');

    const initRes = runNode([CLI_PATH, 'init', '--project', tmp, '--runtime', 'windows', '--name', 'ProcApp', '--batch', 'PKG-PROC-01']);
    assert.equal(initRes.status, 0, initRes.stderr);

    // 1. Verify blockquote cards always separate header and detail lines with an empty '>' line
    const compactRes = runNode([CLI_PATH, 'status', '--project', tmp, '--compact']);
    assert.equal(compactRes.status, 0, compactRes.stderr);
    assert.match(compactRes.stdout, /\r?\n>\r?\n>/, 'status --compact must include empty blockquote separator line');

    const hbDefault = runNode([CLI_PATH, 'render', 'heartbeat', '--project', tmp, '--activity', '正在检查血缘']);
    assert.equal(hbDefault.status, 0, hbDefault.stderr);
    assert.match(hbDefault.stdout, /\r?\n>\r?\n>/);

    const hbStandalone = runNode([CLI_PATH, 'render', 'heartbeat', '--role', 'ab', '--idle', '12', '--dirty', '2']);
    assert.equal(hbStandalone.status, 0, hbStandalone.stderr);
    assert.match(hbStandalone.stdout, /\r?\n>\r?\n>/);

    const nudgeRes = runNode([CLI_PATH, 'render', 'nudge', '--project', tmp, '--task', 'T-01', '--idle', '190']);
    assert.equal(nudgeRes.status, 0, nudgeRes.stderr);
    assert.match(nudgeRes.stdout, /\r?\n>\r?\n>/);

    const msRes = runNode([CLI_PATH, 'render', 'milestone', '--project', tmp, '--task', 'T-01-R0', '--verdict', '通过']);
    assert.equal(msRes.status, 0, msRes.stderr);
    assert.match(msRes.stdout, /\r?\n>\r?\n>/);

    const brRes = runNode([CLI_PATH, 'render', 'breaker', '--project', tmp, '--task', 'T-01-FIX2-R0']);
    assert.equal(brRes.status, 0, brRes.stderr);
    assert.match(brRes.stdout, /\r?\n>\r?\n> - \*\*暂停原因\*\*/);

    const compRes = runNode([CLI_PATH, 'render', 'complete', '--project', tmp]);
    assert.equal(compRes.status, 0, compRes.stderr);
    assert.match(compRes.stdout, /\r?\n>\r?\n> 完成进度：/);

    // 2. Orphan worker snapshot: codex host is dead; cargo test ppid=1 and spawned capture-worker.js ppid=2001
    const orphanSnap = path.join(tmp, 'ps-orphan.txt');
    fs.writeFileSync(orphanSnap, [
      '   1    0 systemd /sbin/init',
      '2001    1 cargo cargo test --test e2e c_v',
      '2002 2001 node node scripts/capture-worker.js',
    ].join('\n') + '\n', 'utf8');

    const orphanRes = runNode([CLI_PATH, 'procs', '--input', orphanSnap, '--json']);
    assert.equal(orphanRes.status, 0, orphanRes.stderr);
    const orphanJson = JSON.parse(orphanRes.stdout);
    assert.equal(orphanJson.ok, true);
    assert.equal(orphanJson.codexHostCount, 0);
    assert.equal(orphanJson.hasActiveCodexWorker, false);
    assert.equal(orphanJson.attachedWorkers.length, 0);
    assert.equal(orphanJson.hasOrphanWorkers, true);
    assert.equal(orphanJson.orphanWorkers.length, 2);
    assert.match(orphanJson.warning || '', /孤儿/);

    // 3. Attached worker snapshot: live codex host pid=1000 -> bash -> cargo test -> capture-worker.js
    const attachedSnap = path.join(tmp, 'ps-attached.txt');
    fs.writeFileSync(attachedSnap, [
      '   1    0 systemd /sbin/init',
      '1000    1 codex /home/user/.local/bin/codex',
      '2000 1000 bash /bin/bash -lc cargo test',
      '2001 2000 cargo cargo test --test e2e c_v',
      '2002 2001 node node scripts/capture-worker.js',
    ].join('\n') + '\n', 'utf8');

    const attachedRes = runNode([CLI_PATH, 'procs', '--input', attachedSnap, '--json']);
    assert.equal(attachedRes.status, 0, attachedRes.stderr);
    const attachedJson = JSON.parse(attachedRes.stdout);
    assert.equal(attachedJson.ok, true);
    assert.equal(attachedJson.codexHostCount, 1);
    assert.equal(attachedJson.hasActiveCodexWorker, true);
    assert.ok(attachedJson.attachedWorkers.length >= 2);
    assert.equal(attachedJson.hasOrphanWorkers, false);
    assert.equal(attachedJson.orphanWorkers.length, 0);
    assert.equal(attachedJson.attachedWorkers[0].codexAncestorPid, 1000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
