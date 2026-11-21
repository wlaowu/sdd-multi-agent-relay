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
