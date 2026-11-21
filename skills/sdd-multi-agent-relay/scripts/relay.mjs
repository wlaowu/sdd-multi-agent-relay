#!/usr/bin/env node
/**
 * Cross-platform (WSL + Windows native) relay & anti-stall supervisor CLI
 * for the Spec-Driven Multi-Agent Gated Workflow (0 + 2 + 3 roles).
 *
 * Strictly reads ONLY Codex session metadata (mtime, size, filename UUID),
 * NEVER reads ~/.codex/sessions/*.jsonl file contents.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const RESOURCES_DIR = path.resolve(__dirname, '../resources');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const UUID_EXACT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_ROLES = ['hub', 'ab', 'c'];
const ROLE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;

function normalizeRoleName(raw, flagName = '--role') {
  const role = String(raw || '').trim().toLowerCase();
  if (!ROLE_NAME_RE.test(role)) {
    throw new Error(`Invalid ${flagName} "${raw || ''}". Expected lowercase identifier (e.g. hub, ab, c, a, b).`);
  }
  return role;
}

function getConfiguredRoleNames(config) {
  const set = new Set(DEFAULT_ROLES);
  for (const source of [
    config?.threads,
    config?.threadMatchers,
    config?.worktrees?.roleWorktrees,
    config?.roleWorktrees,
  ]) {
    if (!source || typeof source !== 'object') continue;
    for (const k of Object.keys(source)) {
      const norm = String(k || '').trim().toLowerCase();
      if (ROLE_NAME_RE.test(norm)) set.add(norm);
    }
  }
  return Array.from(set);
}

function resolveRoleWorktreeRaw(config, role) {
  return (
    config?.worktrees?.roleWorktrees?.[role] ||
    config?.roleWorktrees?.[role] ||
    ''
  );
}

function resolveRoleCwdForCodex(config, role, winProjectRoot) {
  const raw = resolveRoleWorktreeRaw(config, role);
  if (!raw) return config.projectPath;
  if (config.runtime === 'wsl') {
    return path.posix.isAbsolute(raw) ? raw : path.posix.resolve(config.projectPath || '/', raw);
  }
  return path.resolve(winProjectRoot, raw);
}

function resolveRoleWinCwd(config, role, winProjectRoot) {
  const raw = resolveRoleWorktreeRaw(config, role);
  if (!raw) return winProjectRoot;
  if (config.runtime === 'wsl') return winProjectRoot;
  return path.resolve(winProjectRoot, raw);
}

function printHelp() {
  console.log(`sdd-multi-agent-relay CLI (relay.mjs)

Usage:
  node relay.mjs <command> [options]

Config Discovery:
  Commands taking [--config <path> | --project <dir>] automatically walk upward
  from the current working directory to locate .agents/relay.json when omitted.

Commands:
  init      Initialize .agents/development & .agents/relay scaffolding in a project
            Options: --project <path> [--runtime <wsl|windows|posix>] [--distro <name>]
                     [--name <projectName>] [--batch <batchId>] [--tier <L1|L2|L3>]
                     [--branch <gitBranch>] [--automation-mode <full-auto|semi-auto>]
                     [--no-gitignore] [--force]

  threads   List recent Codex rollout sessions (metadata + title index only)
            Options: [--runtime <wsl|windows|posix>] [--distro <name>] [--filter <keyword>]
                     [--limit <n>] [--json]

  bind      Dynamically bind a role to a session UUID, title keyword, or auto-match mode
            Options: [--config <path> | --project <dir>] --role <role>
                     (--thread <uuid> | --match <keyword> | --auto)

  spawn     Start a fresh Codex session cleanly and record its new thread UUID
            Options: [--config <path> | --project <dir>] --role <role>
                     [--prompt-file <file> | --prompt <text>]
                     [--sandbox <read-only|workspace-write>] [--dry-run]

  status    Inspect Codex threads, worktrees, board, task cards, git state, and breakers
            Options: [--config <path> | --project <dir>] [--compact] [--json]

  render    Render standardized human-readable cockpit status blocks for Antigravity outputs
            Subcommands: heartbeat | nudge | milestone | breaker | complete
            Options: [--config <path> | --project <dir>] [--task <id>] [--role <role>]
                     [--idle <sec>] [--activity <text>] [--file <name>] [--exit <code>]
                     [--verdict <v>] [--gate <text>] [--sha <sha>] [--parent <sha>]
                     [--report <path>] [--sha256 <hash>] [--counts <0/0/0/0/0>]
                     [--next <text>] [--reason <text>] [--options <text>]
                     [--stages <spec>] [--countdown <sec>]

  send      Queue a message to a bound/matched Codex thread with progress guards
            Options: [--config <path> | --project <dir>] --role <role>
                     --file <msg-file> --reason <text> [--force]

  state     Manage .agents/relay/relay-state.json (review lifecycle, rotations, resets)
            Options: [--config <path> | --project <dir>]
            Actions:
              show
              start-review    --task <id> --role <R0|Hub> --subagent <uuid> --output <path> [--handoff <id>]
              finish-review   --task <id> --verdict <通过|要求整改|阻塞> --report <path> --sha256 <hash>
              mark-processed  --handoff <id>
              rotate-thread   --role <role> --thread <uuid> [--reason <text>]
              reset-pushes    --role <role>

  notify    Send webhook notification (Feishu / WeCom / DingTalk / Generic JSON)
            Options: [--config <path> | --project <dir>]
                     --event <circuit_breaker|blocker|quota|complete|info>
                     --title <text> --message <text> [--dry-run]
`);
}

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

function formatLocalTime(epochSec) {
  if (!epochSec) return null;
  const d = new Date(epochSec * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function formatIsoOffset(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMin);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function normalizeStageKey(taskId) {
  let key = String(taskId || '').trim();
  key = key.replace(/[-_]?(?:REVIEW|R0)$/i, '');
  key = key.replace(/(\d)[-_]C$/i, '$1');
  key = key.replace(/[-_]?FIX\d+$/i, '');
  return key || String(taskId || 'UNKNOWN');
}

function runWslBash(distro, script, args = [], inputText = undefined, timeoutMs = 60000) {
  const wslArgs = [];
  if (distro) wslArgs.push('-d', distro);
  wslArgs.push('-e', 'bash', '-lc', script, 'relay', ...args);
  const res = spawnSync('wsl.exe', wslArgs, {
    input: inputText,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  return res;
}

function runGitAt(config, targetPath, gitArgs) {
  if (config.runtime === 'wsl') {
    return runWslBash(
      config.wslDistro,
      'cwd="$1"; shift; [ -d "$cwd" ] || exit 66; git -C "$cwd" "$@"',
      [targetPath, ...gitArgs],
      undefined,
      15000,
    );
  }
  if (!targetPath || !fs.existsSync(targetPath)) {
    return { status: 66, stdout: '', stderr: `Directory not found: ${targetPath}` };
  }
  return spawnSync('git', ['-C', targetPath, ...gitArgs], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
    shell: false,
  });
}

function runGit(config, winProjectRoot, gitArgs) {
  const basePath = config.runtime === 'wsl' ? config.projectPath : winProjectRoot;
  return runGitAt(config, basePath, gitArgs);
}

function normalizeComparablePath(p, runtime) {
  if (!p) return '';
  if (runtime === 'wsl') return path.posix.normalize(p);
  const norm = path.normalize(path.resolve(p));
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

function parseGitWorktreePorcelain(stdout) {
  const items = [];
  let cur = null;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) {
      if (cur && cur.path) items.push(cur);
      cur = null;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (cur && cur.path) items.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), head: '', branch: '' };
    } else if (cur && line.startsWith('HEAD ')) {
      cur.head = line.slice('HEAD '.length).trim();
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  if (cur && cur.path) items.push(cur);
  return items;
}

function inspectGitTarget(config, resolvedPath, role = null, source = 'configured') {
  const porcelain = runGitAt(config, resolvedPath, ['status', '--porcelain']);
  if (porcelain.status === 66) {
    return {
      id: role || path.basename(resolvedPath),
      role,
      path: resolvedPath,
      source,
      exists: false,
      branch: null,
      headShort: null,
      dirtyCount: null,
    };
  }
  const headRes = runGitAt(config, resolvedPath, ['rev-parse', '--short=8', 'HEAD']);
  const branchRes = runGitAt(config, resolvedPath, ['rev-parse', '--abbrev-ref', 'HEAD']);
  return {
    id: role || path.basename(resolvedPath),
    role,
    path: resolvedPath,
    source,
    exists: true,
    branch: branchRes.status === 0 ? branchRes.stdout.trim() : null,
    headShort: headRes.status === 0 ? headRes.stdout.trim() : null,
    dirtyCount: porcelain.status === 0
      ? porcelain.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length
      : null,
  };
}

function collectWorktrees(config, winProjectRoot) {
  const runtime = config.runtime || 'windows';
  const primaryResolved = runtime === 'wsl'
    ? path.posix.resolve(config.projectPath || '/')
    : path.resolve(winProjectRoot);
  const seen = new Set([normalizeComparablePath(primaryResolved, runtime)]);
  const entries = [];

  const configuredMap = {
    ...(config.roleWorktrees || {}),
    ...(config.worktrees?.roleWorktrees || {}),
  };
  for (const [rawRole, rawPath] of Object.entries(configuredMap)) {
    if (!rawPath || typeof rawPath !== 'string' || !rawPath.trim()) continue;
    const role = rawRole.trim().toLowerCase();
    const resolved = runtime === 'wsl'
      ? (path.posix.isAbsolute(rawPath) ? rawPath : path.posix.resolve(primaryResolved, rawPath))
      : path.resolve(winProjectRoot, rawPath);
    const key = normalizeComparablePath(resolved, runtime);
    seen.add(key);
    entries.push(inspectGitTarget(config, resolved, role, 'roleWorktrees'));
  }

  if (config.worktrees?.autoDiscover !== false) {
    const wtRes = runGit(config, winProjectRoot, ['worktree', 'list', '--porcelain']);
    if (wtRes.status === 0) {
      for (const block of parseGitWorktreePorcelain(wtRes.stdout)) {
        const key = normalizeComparablePath(block.path, runtime);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const label = runtime === 'wsl' ? path.posix.basename(block.path) : path.basename(block.path);
        entries.push(inspectGitTarget(config, block.path, label, 'discovered'));
      }
    }
  }
  return entries;
}

function normalizeRuntime(raw) {
  const defaultRt = process.platform === 'win32' ? 'windows' : 'posix';
  const v = String(raw || defaultRt).toLowerCase().trim();
  if (v === 'macos' || v === 'darwin' || v === 'linux' || v === 'unix' || v === 'posix') return 'posix';
  if (v === 'windows' || v === 'win32') return 'windows';
  if (v === 'wsl') return 'wsl';
  throw new Error('--runtime must be one of: wsl, windows, posix (or macos/linux)');
}

function resolveWindowsCodexBin(config) {
  if (config?.codexBin && fs.existsSync(config.codexBin)) {
    return config.codexBin;
  }
  const whereRes = spawnSync('where.exe', ['codex.exe'], { encoding: 'utf8', windowsHide: true });
  if (whereRes.status === 0 && whereRes.stdout) {
    const lines = whereRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    for (const candidate of lines) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
  if (fs.existsSync(extRoot)) {
    const dirs = fs.readdirSync(extRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('openai.chatgpt-'))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const dir of dirs) {
      const candidate = path.join(extRoot, dir, 'bin', 'windows-x86_64', 'codex.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function resolvePosixCodexBin(config) {
  if (config?.codexBin && fs.existsSync(config.codexBin)) {
    return config.codexBin;
  }
  const whichRes = spawnSync('which', ['codex'], { encoding: 'utf8' });
  if (whichRes.status === 0 && whichRes.stdout?.trim() && fs.existsSync(whichRes.stdout.trim())) {
    return whichRes.stdout.trim();
  }
  for (const candidate of [
    path.join('/', 'usr', 'local', 'bin', 'codex'),
    path.join('/', 'opt', 'homebrew', 'bin', 'codex'),
    path.join(os.homedir(), '.local', 'bin', 'codex'),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  const extRoot = path.join(os.homedir(), '.vscode', 'extensions');
  if (fs.existsSync(extRoot)) {
    const dirs = fs.readdirSync(extRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith('openai.chatgpt-'))
      .map((d) => d.name)
      .sort()
      .reverse();
    for (const dir of dirs) {
      const binDir = path.join(extRoot, dir, 'bin');
      if (!fs.existsSync(binDir)) continue;
      for (const archDir of fs.readdirSync(binDir)) {
        const candidate = path.join(binDir, archDir, 'codex');
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return null;
}

function resolveLocalCodexBin(config, runtime) {
  return runtime === 'posix' ? resolvePosixCodexBin(config) : resolveWindowsCodexBin(config);
}

function parseSessionIndexLines(rawText) {
  const map = new Map();
  if (!rawText) return map;
  for (const line of rawText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj?.id && UUID_EXACT_RE.test(String(obj.id))) {
        map.set(String(obj.id).toLowerCase(), {
          threadName: typeof obj.thread_name === 'string' ? obj.thread_name : '',
          updatedAt: typeof obj.updated_at === 'string' ? obj.updated_at : '',
        });
      }
    } catch {
      // Ignore partial or malformed lines in append-only index
    }
  }
  return map;
}

function readWindowsSessionIndex() {
  const indexPath = path.join(os.homedir(), '.codex', 'session_index.jsonl');
  if (!fs.existsSync(indexPath)) return new Map();
  try {
    return parseSessionIndexLines(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return new Map();
  }
}

function readWslSessionIndex(distro) {
  const res = runWslBash(distro, 'f="$HOME/.codex/session_index.jsonl"; [ -f "$f" ] && cat "$f" || true', [], undefined, 10000);
  if (res.status !== 0) return new Map();
  return parseSessionIndexLines(res.stdout || '');
}

function scanWindowsCodexThreads(targetIds = null, limit = 10) {
  const sessionsRoot = path.join(os.homedir(), '.codex', 'sessions');
  const indexMap = readWindowsSessionIndex();
  const nowSec = Math.floor(Date.now() / 1000);
  const byId = new Map();

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const match = entry.name.match(UUID_RE);
        if (!match) continue;
        const uuid = match[0].toLowerCase();
        if (targetIds && !targetIds.has(uuid)) continue;
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        const mtimeSec = Math.floor(st.mtimeMs / 1000);
        const existing = byId.get(uuid);
        if (!existing || st.mtimeMs > existing.mtimeMs) {
          byId.set(uuid, {
            uuid,
            threadName: indexMap.get(uuid)?.threadName || '',
            mtimeMs: st.mtimeMs,
            mtimeSec,
            idleSeconds: Math.max(0, nowSec - mtimeSec),
            lastWrite: formatLocalTime(mtimeSec),
            size: st.size,
          });
        }
      }
    }
  }

  if (fs.existsSync(sessionsRoot)) {
    walk(sessionsRoot);
  }
  const list = Array.from(byId.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return limit ? list.slice(0, limit) : list;
}

function scanWslCodexThreads(distro, targetIds = null, limit = 10) {
  const indexMap = readWslSessionIndex(distro);
  const script = `
now=$(date +%s)
root="$HOME/.codex/sessions"
[ -d "$root" ] || exit 0
find "$root" -type f -name '*.jsonl' -printf '%T@|%s|%f\\n' 2>/dev/null
`;
  const res = runWslBash(distro, script, [], undefined, 20000);
  if (res.status !== 0) {
    throw new Error(`WSL session scan failed: ${(res.stderr || res.error?.message || '').trim()}`);
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const byId = new Map();
  const lines = (res.stdout || '').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    const parts = line.split('|');
    if (parts.length < 3) continue;
    const mtimeFloat = parseFloat(parts[0]);
    const size = parseInt(parts[1], 10) || 0;
    const fname = parts.slice(2).join('|');
    const match = fname.match(UUID_RE);
    if (!match || Number.isNaN(mtimeFloat)) continue;
    const uuid = match[0].toLowerCase();
    if (targetIds && !targetIds.has(uuid)) continue;
    const mtimeMs = Math.floor(mtimeFloat * 1000);
    const mtimeSec = Math.floor(mtimeFloat);
    const existing = byId.get(uuid);
    if (!existing || mtimeMs > existing.mtimeMs) {
      byId.set(uuid, {
        uuid,
        threadName: indexMap.get(uuid)?.threadName || '',
        mtimeMs,
        mtimeSec,
        idleSeconds: Math.max(0, nowSec - mtimeSec),
        lastWrite: formatLocalTime(mtimeSec),
        size,
      });
    }
  }
  const list = Array.from(byId.values()).sort((a, b) => b.mtimeMs - a.mtimeMs);
  return limit ? list.slice(0, limit) : list;
}

function findRelayConfigUpward(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    const candidate = path.join(dir, '.agents', 'relay.json');
    if (fs.existsSync(candidate)) return candidate;
    if (path.basename(dir).toLowerCase() === '.agents') {
      const direct = path.join(dir, 'relay.json');
      if (fs.existsSync(direct)) return direct;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadConfigAndPaths(flags) {
  let configPath = null;
  if (typeof flags === 'string') {
    configPath = path.resolve(flags);
  } else if (flags?.config) {
    configPath = path.resolve(flags.config);
  } else if (flags?.project) {
    let projDir = flags.project;
    if (projDir.startsWith('/')) {
      const wslRes = runWslBash(flags.distro || '', 'wslpath -w "$1"', [projDir], undefined, 10000);
      if (wslRes.status === 0 && wslRes.stdout.trim()) projDir = wslRes.stdout.trim();
    }
    configPath = path.join(path.resolve(projDir), '.agents', 'relay.json');
  } else {
    configPath = findRelayConfigUpward(process.cwd());
  }

  if (!configPath) {
    throw new Error(`No --config/--project supplied and no .agents/relay.json found walking up from: ${process.cwd()}`);
  }
  if (!fs.existsSync(configPath)) throw new Error(`Config not found: ${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  const parentDir = path.dirname(configPath);
  const winProjectRoot = path.basename(parentDir).toLowerCase() === '.agents'
    ? path.dirname(parentDir)
    : parentDir;
  const devDir = path.resolve(winProjectRoot, config.devDir || '.agents/development');
  const relayDir = path.resolve(winProjectRoot, config.relayDir || '.agents/relay');
  const statePath = path.join(relayDir, 'relay-state.json');
  const logPath = path.join(relayDir, 'relay.log');
  return { config, configPath, winProjectRoot, devDir, relayDir, statePath, logPath };
}

function createInitialState() {
  return {
    version: '1.0',
    updatedAt: new Date().toISOString(),
    lastObservedSnapshot: {
      headFull: null,
      dirtyCount: null,
      boardMtimeSec: null,
      abCardMtimeSec: null,
    },
    roles: {
      hub: { lastPushAt: null, lastPushThreadWrite: null, consecutivePushesWithoutProgress: 0, totalPushes: 0 },
      ab: { lastPushAt: null, lastPushThreadWrite: null, consecutivePushesWithoutProgress: 0, totalPushes: 0 },
      c: { lastPushAt: null, lastPushThreadWrite: null, consecutivePushesWithoutProgress: 0, totalPushes: 0 },
    },
    stageFixes: {},
    passedStages: {},
    processedHandoffs: [],
    activeCrossAgent: null,
    rotations: [],
  };
}

function loadOrCreateState(statePath) {
  if (fs.existsSync(statePath)) {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const base = createInitialState();
    return {
      ...base,
      ...parsed,
      roles: { ...base.roles, ...(parsed.roles || {}) },
      stageFixes: parsed.stageFixes || {},
      passedStages: parsed.passedStages || {},
      processedHandoffs: Array.isArray(parsed.processedHandoffs) ? parsed.processedHandoffs : [],
      rotations: Array.isArray(parsed.rotations) ? parsed.rotations : [],
    };
  }
  return createInitialState();
}

function saveState(statePath, state) {
  state.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const tmp = `${statePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, statePath);
}

function appendRelayLog(logPath, line) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.appendFileSync(logPath, `${formatLocalTime(Math.floor(Date.now() / 1000))} ${line}\n`, 'utf8');
}

function safeStatMtimeSec(filePath) {
  try {
    return Math.floor(fs.statSync(filePath).mtimeMs / 1000);
  } catch {
    return null;
  }
}

function renderTemplate(templateName, vars) {
  const tplPath = path.join(RESOURCES_DIR, templateName);
  let text = fs.readFileSync(tplPath, 'utf8');
  for (const [k, v] of Object.entries(vars)) {
    text = text.replaceAll(`{{${k}}}`, v ?? '');
  }
  return text;
}

function writeIfMissing(filePath, content, force = false) {
  if (!force && fs.existsSync(filePath)) return false;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.replace(/\r\n/g, '\n'), 'utf8');
  return true;
}

function parseProjectForInit(projectArg, runtime, distroArg) {
  if (!projectArg) throw new Error('Missing --project <path>');
  let distro = distroArg || '';
  if (runtime === 'wsl') {
    const uncMatch = projectArg.match(/^\\\\wsl(?:\.localhost|\$)\\([^\\]+)(.*)$/i);
    if (uncMatch) {
      distro = distro || uncMatch[1];
      const linuxPath = (uncMatch[2] || '/').replace(/\\/g, '/');
      return { distro, projectPathForCodex: linuxPath, winProjectRoot: projectArg };
    }
    if (projectArg.startsWith('/')) {
      const wslRes = runWslBash(distro, 'wslpath -w "$1"', [projectArg], undefined, 10000);
      if (wslRes.status !== 0 || !wslRes.stdout.trim()) {
        throw new Error(`Cannot resolve Windows UNC path for WSL path "${projectArg}": ${(wslRes.stderr || '').trim()}`);
      }
      return {
        distro,
        projectPathForCodex: projectArg,
        winProjectRoot: wslRes.stdout.trim(),
      };
    }
  }
  const winProjectRoot = path.resolve(projectArg);
  return { distro, projectPathForCodex: winProjectRoot, winProjectRoot };
}

function ensureGitignoreEntries(winProjectRoot, entries) {
  const giPath = path.join(winProjectRoot, '.gitignore');
  const existingText = fs.existsSync(giPath) ? fs.readFileSync(giPath, 'utf8') : '';
  const existingSet = new Set(
    existingText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean),
  );
  const missing = entries.filter((e) => !existingSet.has(e));
  if (missing.length === 0) return false;

  const nl = existingText.includes('\r\n') ? '\r\n' : '\n';
  const prefix = existingText.length > 0 && !existingText.endsWith('\n') ? nl : '';
  const header = existingSet.has('# sdd-multi-agent-relay (machine-local runtime files)')
    ? ''
    : `${prefix}${existingText.length > 0 ? nl : ''}# sdd-multi-agent-relay (machine-local runtime files)${nl}`;
  const block = `${header}${missing.join(nl)}${nl}`;
  fs.writeFileSync(giPath, existingText + block, 'utf8');
  return true;
}

function cmdInit(flags) {
  const runtime = normalizeRuntime(flags.runtime);
  const { distro, projectPathForCodex, winProjectRoot } = parseProjectForInit(flags.project, runtime, flags.distro);
  if (!fs.existsSync(winProjectRoot)) {
    throw new Error(`Project directory does not exist: ${winProjectRoot}`);
  }
  const projectName = flags.name || path.basename(winProjectRoot);
  const batchId = flags.batch || 'PKG-INIT-01';
  const tier = flags.tier || 'L3';
  const gitBranch = flags.branch || `feat/${batchId.toLowerCase()}`;
  const force = Boolean(flags.force);
  const createdAt = formatIsoOffset();

  const vars = {
    PROJECT_NAME: projectName,
    BATCH_ID: batchId,
    TIER: tier,
    RUNTIME: runtime,
    WSL_DISTRO: distro,
    PROJECT_PATH: projectPathForCodex,
    DEV_DIR: '.agents/development',
    RELAY_DIR: '.agents/relay',
    GIT_BRANCH: gitBranch,
    CREATED_AT: createdAt,
  };

  const devRoot = path.join(winProjectRoot, '.agents', 'development');
  const relayRoot = path.join(winProjectRoot, '.agents', 'relay');
  for (const dir of [
    path.join(devRoot, 'specs'),
    path.join(devRoot, 'tasks'),
    path.join(devRoot, 'audits', 'design-reviews'),
    path.join(devRoot, 'audits', batchId),
    path.join(relayRoot, 'messages'),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const created = [];
  const tryWrite = (target, content) => {
    if (writeIfMissing(target, content, force)) created.push(target);
  };

  const relayConfig = JSON.parse(fs.readFileSync(path.join(RESOURCES_DIR, 'relay.json.template'), 'utf8'));
  relayConfig.projectName = projectName;
  relayConfig.batchId = batchId;
  relayConfig.tier = tier;
  relayConfig.runtime = runtime;
  relayConfig.wslDistro = distro;
  relayConfig.projectPath = projectPathForCodex;
  relayConfig.gitBranch = gitBranch;
  if (flags['automation-mode']) {
    relayConfig.automationMode = String(flags['automation-mode']).trim();
  }
  relayConfig.worktrees = relayConfig.worktrees || { autoDiscover: true, roleWorktrees: {} };
  relayConfig.threadMatchers = {
    hub: `${projectName}-Codex-Hub`,
    ab: `${projectName}-AB`,
    c: `${projectName}-C`,
  };

  tryWrite(path.join(winProjectRoot, '.agents', 'relay.json'), JSON.stringify(relayConfig, null, 2) + '\n');
  const exampleConfig = {
    ...relayConfig,
    runtime: 'windows | wsl | posix',
    wslDistro: '',
    projectPath: '<LOCAL_REPO_PATH>',
    worktrees: { autoDiscover: true, roleWorktrees: {} },
    threads: { hub: '', ab: '', c: '' },
    webhook: { ...(relayConfig.webhook || {}), url: '' },
  };
  tryWrite(path.join(winProjectRoot, '.agents', 'relay.example.json'), JSON.stringify(exampleConfig, null, 2) + '\n');
  tryWrite(path.join(relayRoot, 'relay-state.json'), JSON.stringify(createInitialState(), null, 2) + '\n');
  tryWrite(path.join(devRoot, 'STATE.md'), renderTemplate('STATE.md.template', vars));
  tryWrite(path.join(devRoot, 'DISPATCH_BOARD.md'), renderTemplate('DISPATCH_BOARD.md.template', vars));
  tryWrite(path.join(devRoot, 'tasks', 'AB-codex.md'), renderTemplate('TASK_CARD.md.template', { ...vars, TASK_TITLE: `${projectName}-AB 全栈实施任务卡`, ROLE_NAME: 'AB（全栈实施专席）' }));
  tryWrite(path.join(devRoot, 'tasks', 'R0-review.md'), renderTemplate('TASK_CARD.md.template', { ...vars, TASK_TITLE: `${projectName}-R0 独立审计派发卡`, ROLE_NAME: 'R0（独立审计专席）' }));
  tryWrite(path.join(devRoot, 'tasks', 'C-desktop.md'), renderTemplate('TASK_CARD.md.template', { ...vars, TASK_TITLE: `${projectName}-C 真机/原生验证任务卡`, ROLE_NAME: 'C（原生环境验证专席）' }));
  tryWrite(path.join(devRoot, 'DISCUSSIONS.md'), `# ${projectName} 讨论与方案索引\n\n| 时间 | 主题 | 归档文档 | 效力状态 |\n| --- | --- | --- | --- |\n`);
  tryWrite(path.join(devRoot, 'ISSUE_LEDGER.md'), `# ${projectName} 审计问题台账（仅 R0 权威更新）\n\n| 问题 ID | 阶段与对象 SHA | 级别 | 问题描述 | 状态 |\n| --- | --- | --- | --- | --- |\n`);
  tryWrite(path.join(devRoot, 'AUDIT_QUEUE.md'), `# ${projectName} 送审队列\n\n| 送审任务 | 冻结 40 位 SHA | 证据清单 | 状态 |\n| --- | --- | --- | --- |\n`);

  const agentsTarget = path.join(winProjectRoot, 'AGENTS.md');
  const agentsSnippet = path.join(devRoot, 'AGENTS_WORKFLOW_SNIPPET.md');
  const agentsContent = renderTemplate('AGENTS.md.template', vars);
  if (!fs.existsSync(agentsTarget) || force) {
    tryWrite(agentsTarget, agentsContent);
  } else {
    tryWrite(agentsSnippet, agentsContent);
  }

  let gitignoreUpdated = false;
  if (!flags['no-gitignore']) {
    gitignoreUpdated = ensureGitignoreEntries(winProjectRoot, ['.agents/relay/', '.agents/relay.json']);
  }

  console.log(JSON.stringify({
    ok: true,
    winProjectRoot,
    runtime,
    batchId,
    configPath: path.join(winProjectRoot, '.agents', 'relay.json'),
    exampleConfigPath: path.join(winProjectRoot, '.agents', 'relay.example.json'),
    gitignoreUpdated,
    createdCount: created.length,
    createdFiles: created,
  }, null, 2));
}

function listAllRuntimeThreads(runtime, distro = '') {
  const rt = normalizeRuntime(runtime);
  return rt === 'wsl'
    ? scanWslCodexThreads(distro || '', null, null)
    : scanWindowsCodexThreads(null, null);
}

function cmdThreads(flags) {
  const runtime = normalizeRuntime(flags.runtime);
  const limit = parseInt(flags.limit || '10', 10) || 10;
  const filterKw = (flags.filter || '').trim().toLowerCase();
  let list = listAllRuntimeThreads(runtime, flags.distro || '');
  if (filterKw) {
    list = list.filter((t) =>
      t.uuid.toLowerCase().includes(filterKw) ||
      (t.threadName && t.threadName.toLowerCase().includes(filterKw)));
  }
  list = list.slice(0, limit);

  if (flags.json) {
    console.log(JSON.stringify({ runtime, count: list.length, threads: list }, null, 2));
    return;
  }
  console.log(`=== Codex Threads (${runtime}${flags.distro ? `:${flags.distro}` : ''}, shown ${list.length}) ===`);
  for (const t of list) {
    const titlePart = t.threadName ? `  name=${JSON.stringify(t.threadName)}` : '';
    console.log(`${t.uuid}  idle_seconds=${t.idleSeconds}  last_write=${t.lastWrite}  size=${t.size}${titlePart}`);
  }
}

function resolveRoleThreads(config, state, idleThreshold, maxNoProgress) {
  const allThreads = listAllRuntimeThreads(config.runtime || 'windows', config.wslDistro || '');
  const byId = new Map(allThreads.map((t) => [t.uuid, t]));
  const roles = {};
  const roleNames = getConfiguredRoleNames(config);

  for (const r of roleNames) {
    const pinned = (config.threads?.[r] || '').trim().toLowerCase();
    const matcher = (config.threadMatchers?.[r] || '').trim();
    const roleState = state.roles[r] || {};

    let resolvedVia = 'unbound';
    let tid = '';
    let info = null;

    if (pinned && UUID_EXACT_RE.test(pinned)) {
      resolvedVia = 'pinned';
      tid = pinned;
      info = byId.get(tid) || null;
    } else if (matcher) {
      const needle = matcher.toLowerCase();
      info = allThreads.find((t) => t.threadName && t.threadName.toLowerCase().includes(needle)) || null;
      if (info) {
        resolvedVia = 'matcher';
        tid = info.uuid;
      } else {
        resolvedVia = 'matcher_unmatched';
      }
    }

    if (!info) {
      roles[r] = {
        uuid: tid,
        threadName: '',
        resolvedVia,
        matcher,
        status: resolvedVia === 'pinned' ? 'NOT_FOUND' : 'UNBOUND',
        idleSeconds: null,
        lastWrite: null,
        consecutivePushesWithoutProgress: roleState.consecutivePushesWithoutProgress || 0,
        noProgressBreaker: false,
      };
    } else {
      roles[r] = {
        uuid: tid,
        threadName: info.threadName || '',
        resolvedVia,
        matcher,
        status: info.idleSeconds < idleThreshold ? 'WORKING' : 'STOPPED',
        idleSeconds: info.idleSeconds,
        lastWrite: info.lastWrite,
        size: info.size,
        lastPushThreadWrite: roleState.lastPushThreadWrite || null,
        consecutivePushesWithoutProgress: roleState.consecutivePushesWithoutProgress || 0,
        noProgressBreaker: (roleState.consecutivePushesWithoutProgress || 0) >= maxNoProgress,
      };
    }
  }
  return roles;
}

function classifyBoardRowStatus(cells, rawId, stageKey, state, activeCrossAgent) {
  if (state?.passedStages?.[stageKey]) return 'done';
  const activeStage = activeCrossAgent?.taskId ? normalizeStageKey(activeCrossAgent.taskId) : null;
  if (activeStage && activeStage === stageKey) return 'active';

  const statusText = cells.slice(1).join(' | ');
  if (/(?:通过|已闭环|已完成|\bPASS\b|\bDONE\b|\bCLOSED\b)/i.test(statusText) &&
      !/(?:要求整改|不满足|未送审|待.*(?:通过|确认))/.test(statusText)) {
    return 'done';
  }
  if (/(?:熔断|阻塞|要求整改|\bBLOCKED\b|\bFAIL\b)/i.test(statusText) && !/解阻/.test(statusText)) {
    return 'blocked';
  }
  if (/(?:实施中|已接棒|返修中|进行中|审核中|复审中|已内部送达|\bIN_PROGRESS\b|\bWORKING\b)/i.test(statusText)) {
    return 'active';
  }
  return 'pending';
}

function parsePipelineSummary(boardTaskRows, state, activeCrossAgent) {
  const stageMap = new Map();
  let seq = 0;

  for (const row of boardTaskRows || []) {
    const rawCells = row.split('|').map((c) => c.trim());
    if (rawCells[0] === '') rawCells.shift();
    if (rawCells.length > 0 && rawCells[rawCells.length - 1] === '') rawCells.pop();
    if (rawCells.length < 2) continue;

    const rawId = rawCells[0].replace(/`/g, '').trim();
    if (!rawId || /^<.*>$/.test(rawId) || /^---+$/.test(rawId)) continue;

    const stageKey = normalizeStageKey(rawId);
    const isReview = /(?:[-_]REVIEW|[-_]R0)$/i.test(rawId);
    const fixMatch = rawId.match(/[-_]FIX(\d+)/i);
    const round = fixMatch ? parseInt(fixMatch[1], 10) : 0;
    const rank = round * 2 + (isReview ? 1 : 0);
    const status = classifyBoardRowStatus(rawCells, rawId, stageKey, state, activeCrossAgent);

    const existing = stageMap.get(stageKey);
    if (!existing) {
      stageMap.set(stageKey, { stage: stageKey, status, rank, order: seq++ });
    } else if (status === 'done' || rank >= existing.rank) {
      if (existing.status !== 'done' || status === 'done' || !isReview) {
        existing.status = status;
        existing.rank = Math.max(existing.rank, rank);
      }
    }
  }

  let stages = Array.from(stageMap.values()).sort((a, b) => a.order - b.order);
  if (stages.length > 6) {
    const firstNonDone = stages.findIndex((s) => s.status !== 'done');
    const startIdx = firstNonDone >= 0 ? Math.max(0, firstNonDone - 2) : Math.max(0, stages.length - 6);
    stages = stages.slice(startIdx, startIdx + 6);
  }

  const plainParts = stages.map((s) => {
    if (s.status === 'done') return `${s.stage} ✓`;
    if (s.status === 'active') return `▸ ${s.stage}`;
    if (s.status === 'blocked') return `! ${s.stage}`;
    return `${s.stage} ◌`;
  });
  const mdParts = stages.map((s) => {
    if (s.status === 'done') return `\`${s.stage} ✓\``;
    if (s.status === 'active') return `**\`▸ ${s.stage}\`**`;
    if (s.status === 'blocked') return `**\`! ${s.stage}\`**`;
    return `\`${s.stage} ◌\``;
  });

  return {
    stages: stages.map(({ stage, status }) => ({ stage, status })),
    breadcrumb: plainParts.join(' → ') || '-',
    markdownBreadcrumb: mdParts.join(' → ') || '',
  };
}

function formatDurationCn(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '-';
  const s = Math.max(0, Math.round(Number(seconds)));
  if (s < 60) return `${s} 秒`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m} 分 ${rem} 秒` : `${m} 分`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h} 小时 ${m} 分`;
}

function formatRoleLabelCn(role) {
  const key = String(role || '').trim().toLowerCase();
  if (key === 'hub') return '总控中枢';
  if (key === 'ab') return '实施专席 (AB)';
  if (key === 'c') return '真机验证 (C)';
  return `${key.toUpperCase()} 线`;
}

function formatCountsCn(raw) {
  const parts = String(raw || '').split('/').map((x) => x.trim()).filter(Boolean);
  if (parts.length === 5) {
    return `阻断 ${parts[0]} · 高危 ${parts[1]} · 中危 ${parts[2]} · 低危 ${parts[3]} · 建议 ${parts[4]}`;
  }
  return String(raw || '-');
}

function buildTelemetryLine(st) {
  const roleEntries = Object.entries(st.roles || {});
  const workerEntries = roleEntries.filter(([name, info]) =>
    name !== 'hub' && (info.status === 'WORKING' || info.status === 'STOPPED'));
  const allLive = roleEntries.filter(([, info]) => info.status === 'WORKING' || info.status === 'STOPPED');
  const hasBreaker = Boolean(st.breakers?.fixCapBreaker || (st.breakers?.noProgressRoles?.length || 0) > 0);
  const hasAudit = Boolean(st.activeCrossAgent);
  const hasHandoff = (st.pendingCrossAgent?.length || 0) > 0;
  const hasWorktrees = Array.isArray(st.worktrees) && st.worktrees.length > 0;
  const hasWorking = allLive.some(([, info]) => info.status === 'WORKING');

  let title = '◌ **待命观察中**';
  if (hasBreaker) title = '■ **自动推进已暂停**';
  else if (hasAudit) title = '◐ **独立审计进行中**';
  else if (hasHandoff) title = '◆ **发现待转交任务**';
  else if (hasWorking && hasWorktrees) title = '● **多线并行开发中**';
  else if (hasWorking) title = '● **研发推进中**';
  else if (allLive.length > 0) title = '▲ **等待状态核查**';

  // Pick latest observed write timestamp HH:MM if present, else checkedAt
  const latestLastWrite = allLive
    .map(([, info]) => info.lastWrite)
    .filter(Boolean)
    .sort()
    .slice(-1)[0];
  const tsFull = latestLastWrite
    ? String(latestLastWrite).slice(11, 19)
    : String(st.checkedAt || '').slice(11, 19);
  const ts = tsFull ? tsFull.slice(0, 5) : '--:--';

  const headerLine = st.pipeline?.markdownBreadcrumb
    ? `> ${title} · \`${ts}\` · \`${st.batchId}\` · 进度 ${st.pipeline.markdownBreadcrumb}`
    : `> ${title} · \`${ts}\` · 批次 \`${st.batchId}\``;

  let detailLine = '';
  if (hasBreaker) {
    detailLine = '> 触发安全熔断保护，自动中继已暂停，等待你确认处理方式。';
  } else if (hasAudit) {
    detailLine = `> 独立审计专员正在隔离核验 \`${st.activeCrossAgent.taskId}\`（代码仓保持只读未改动），完成后自动回传总控，无需你操作。`;
  } else if (hasHandoff) {
    detailLine = `> 检测到 \`${st.pendingCrossAgent.length}\` 项跨端待转交任务，正在自动安排独立审计专员接手。`;
  } else if (hasWorktrees) {
    const wtParts = st.worktrees.map((wt) => {
      const label = wt.role ? formatRoleLabelCn(wt.role) : `${wt.id.toUpperCase()} 线`;
      if (!wt.exists) return `\`${label}\`（目录缺失）`;
      const rInfo = wt.role ? st.roles?.[wt.role] : null;
      const activeTxt = rInfo && rInfo.idleSeconds !== null && rInfo.idleSeconds !== undefined
        ? `活跃于 ${formatDurationCn(rInfo.idleSeconds)}前，`
        : '';
      const dirtyTxt = wt.dirtyCount > 0 ? `改动 ${wt.dirtyCount} 个文件` : '工作区干净';
      return `\`${label}\`（${activeTxt}${dirtyTxt}）`;
    });
    const tailTxt = hasWorking ? '正常运行，继续值守。' : '当前无新写入，正在核对是否待推进。';
    detailLine = `> ${wtParts.join(' · ')}，${tailTxt}`;
  } else {
    const dirtyNum = st.git?.dirtyCount;
    const dirtyTxt = dirtyNum === null || dirtyNum === undefined
      ? '工作区状态未知'
      : (dirtyNum === 0 ? '当前工作区干净' : `当前工作区改动 ${dirtyNum} 个文件`);
    const targetList = workerEntries.length > 0 ? workerEntries : allLive.slice(0, 2);
    if (targetList.length > 0) {
      const roleSummaries = targetList.map(([name, info]) => {
        const label = formatRoleLabelCn(name);
        const dur = formatDurationCn(info.idleSeconds);
        return info.status === 'WORKING'
          ? `\`${label}\` 活跃（${dur}前有输出）`
          : `\`${label}\` 已静默 ${dur}`;
      });
      const tailTxt = hasWorking ? '一切正常，继续值守。' : '正在核对是否已完工或需要唤醒。';
      detailLine = `> ${roleSummaries.join(' · ')}，${dirtyTxt}，${tailTxt}`;
    } else {
      detailLine = `> 暂未绑定执行会话（${dirtyTxt}），等待绑定或启动会话。`;
    }
  }

  return `${headerLine}\n${detailLine}`;
}

function collectStatus(ctx) {
  const { config, winProjectRoot, devDir, statePath, logPath } = ctx;
  const state = loadOrCreateState(statePath);
  const idleThreshold = config.thresholds?.idleThresholdSec ?? 180;
  const maxNoProgress = config.thresholds?.maxNoProgressPushes ?? 3;
  const maxFixRounds = config.thresholds?.maxFixRounds ?? 2;

  const roles = resolveRoleThreads(config, state, idleThreshold, maxNoProgress);

  const boardPath = path.join(devDir, 'DISPATCH_BOARD.md');
  const abCardPath = path.join(devDir, 'tasks', 'AB-codex.md');
  const boardMtimeSec = safeStatMtimeSec(boardPath);
  const abCardMtimeSec = safeStatMtimeSec(abCardPath);

  let boardLastLogs = [];
  let boardTaskRows = [];
  if (fs.existsSync(boardPath)) {
    const boardLines = fs.readFileSync(boardPath, 'utf8').split(/\r?\n/);
    boardLastLogs = boardLines.filter((l) => /^\|\s*`20/.test(l)).slice(-5);
    boardTaskRows = boardLines.filter((l) => /^\|\s*(?:`?[A-Z0-9][A-Za-z0-9._-]+`?)\s*\|/.test(l) && !/^\|\s*`20/.test(l));
  }

  let abHeadings = [];
  if (fs.existsSync(abCardPath)) {
    const abLines = fs.readFileSync(abCardPath, 'utf8').split(/\r?\n/);
    abHeadings = abLines
      .map((line, idx) => ({ line, num: idx + 1 }))
      .filter((x) => /^#{2,4}\s+/.test(x.line))
      .slice(-4)
      .map((x) => `${x.num}:${x.line}`);
  }

  // Detect new pending cross-agent handoffs addressed to Antigravity
  const processedSet = new Set(state.processedHandoffs || []);
  const pendingCrossAgent = [];
  const tasksDir = path.join(devDir, 'tasks');
  const scanFiles = [];
  if (fs.existsSync(boardPath)) scanFiles.push({ rel: 'DISPATCH_BOARD.md', full: boardPath });
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir)) {
      if (f.endsWith('.md')) scanFiles.push({ rel: `tasks/${f}`, full: path.join(tasksDir, f) });
    }
  }
  for (const sf of scanFiles) {
    const lines = fs.readFileSync(sf.full, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (!/Antigravity/.test(ln)) continue;
      if (!/(?:^发送到：\s*Antigravity|待转交|待用户转发|待调度)/.test(ln)) continue;
      if (/(?:已送达|已转交|已核收|<VS Code Codex|<标准会话全名)/.test(ln)) continue;
      const key = `${sf.rel}:${i + 1}`;
      if (!processedSet.has(key)) {
        pendingCrossAgent.push({ key, file: sf.rel, line: i + 1, text: ln.slice(0, 180) });
      }
    }
  }

  // Git metadata & secondary worktrees
  const headRes = runGit(config, winProjectRoot, ['rev-parse', 'HEAD']);
  const branchRes = runGit(config, winProjectRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const porcelainRes = runGit(config, winProjectRoot, ['status', '--porcelain']);
  const headFull = headRes.status === 0 ? headRes.stdout.trim() : null;
  const branch = branchRes.status === 0 ? branchRes.stdout.trim() : null;
  const dirtyCount = porcelainRes.status === 0
    ? porcelainRes.stdout.split(/\r?\n/).filter((l) => l.trim().length > 0).length
    : null;
  const worktrees = collectWorktrees(config, winProjectRoot);

  const snapshot = {
    headFull,
    dirtyCount,
    worktreesDirty: worktrees.map((w) => ({ id: w.id, headShort: w.headShort, dirtyCount: w.dirtyCount })),
    boardMtimeSec,
    abCardMtimeSec,
  };
  const prev = state.lastObservedSnapshot || {};
  const changedSinceLastSnapshot =
    snapshot.headFull !== prev.headFull ||
    JSON.stringify(snapshot.worktreesDirty) !== JSON.stringify(prev.worktreesDirty || []) ||
    snapshot.boardMtimeSec !== prev.boardMtimeSec ||
    snapshot.abCardMtimeSec !== prev.abCardMtimeSec;

  const fixCapStages = Object.entries(state.stageFixes || {})
    .filter(([, count]) => count >= maxFixRounds)
    .map(([stage, count]) => ({ stage, count, maxFixRounds }));

  let recentLog = [];
  if (fs.existsSync(logPath)) {
    recentLog = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-8);
  }

  const pipeline = parsePipelineSummary(boardTaskRows, state, state.activeCrossAgent);
  const statusObj = {
    checkedAt: formatIsoOffset(),
    projectName: config.projectName,
    batchId: config.batchId,
    tier: config.tier,
    automationMode: config.automationMode || 'full-auto',
    runtime: config.runtime,
    git: { branch, headFull, headShort: headFull ? headFull.slice(0, 8) : null, dirtyCount },
    worktrees,
    boardMtime: formatLocalTime(boardMtimeSec),
    abCardMtime: formatLocalTime(abCardMtimeSec),
    snapshot,
    changedSinceLastSnapshot,
    roles,
    pipeline,
    boardTaskRows,
    boardLastLogs,
    abHeadings,
    pendingCrossAgent,
    activeCrossAgent: state.activeCrossAgent,
    stageFixes: state.stageFixes,
    breakers: {
      noProgressRoles: Object.entries(roles).filter(([, r]) => r.noProgressBreaker).map(([name]) => name),
      fixCapBreaker: fixCapStages.length > 0,
      fixCapStages,
    },
    recentLog,
  };
  statusObj.telemetryLine = buildTelemetryLine(statusObj);
  return statusObj;
}

function cmdStatus(flags) {
  const ctx = loadConfigAndPaths(flags);
  const st = collectStatus(ctx);
  if (flags.json) {
    console.log(JSON.stringify(st, null, 2));
    return;
  }
  if (flags.compact) {
    console.log(st.telemetryLine);
    return;
  }
  console.log(`=== ${st.projectName} (${st.batchId} / ${st.tier} / ${st.automationMode} / ${st.runtime}) @ ${st.checkedAt} ===`);
  console.log(`TELEMETRY: ${st.telemetryLine}`);
  for (const [r, info] of Object.entries(st.roles)) {
    const via = info.resolvedVia && info.resolvedVia !== 'unbound' ? ` via=${info.resolvedVia}` : '';
    const title = info.threadName ? ` name=${JSON.stringify(info.threadName)}` : '';
    console.log(`THREAD ${r.toUpperCase()}: status=${info.status}${via} idle_seconds=${info.idleSeconds ?? '-'} last_write=${info.lastWrite ?? '-'} no_prog_pushes=${info.consecutivePushesWithoutProgress}${title}`);
  }
  console.log(`GIT: branch=${st.git.branch ?? '-'} HEAD=${st.git.headShort ?? '-'} DIRTY=${st.git.dirtyCount ?? '-'}`);
  if (st.worktrees.length > 0) {
    console.log('--- worktrees ---');
    for (const wt of st.worktrees) {
      console.log(`WORKTREE ${wt.id} (${wt.source}): exists=${wt.exists} branch=${wt.branch ?? '-'} HEAD=${wt.headShort ?? '-'} DIRTY=${wt.dirtyCount ?? '-'} path=${wt.path}`);
    }
  }
  console.log(`BOARD_MTIME=${st.boardMtime ?? '-'}  AB_CARD_MTIME=${st.abCardMtime ?? '-'}`);
  if (st.breakers.fixCapBreaker || st.breakers.noProgressRoles.length > 0) {
    console.log(`BREAKERS: fixCap=${JSON.stringify(st.breakers.fixCapStages)} noProgressRoles=${JSON.stringify(st.breakers.noProgressRoles)}`);
  }
  if (st.activeCrossAgent) {
    console.log(`ACTIVE_CROSS_AGENT: ${JSON.stringify(st.activeCrossAgent)}`);
  }
  console.log('--- pending cross-agent handoffs ---');
  for (const p of st.pendingCrossAgent) console.log(`${p.key}: ${p.text}`);
  console.log('--- board task rows ---');
  for (const row of st.boardTaskRows) console.log(row.slice(0, 220));
  console.log('--- board last logs ---');
  for (const row of st.boardLastLogs) console.log(row.slice(0, 220));
  console.log('--- AB last headings ---');
  for (const h of st.abHeadings) console.log(h);
  console.log('--- relay.log (last 8) ---');
  for (const l of st.recentLog) console.log(l);
}

function tryLoadStatusOptional(flags) {
  try {
    const ctx = loadConfigAndPaths(flags);
    return collectStatus(ctx);
  } catch {
    return null;
  }
}

function cmdRender(flags, kindRaw) {
  const kind = String(kindRaw || 'heartbeat').trim().toLowerCase();
  const st = tryLoadStatusOptional(flags);
  const tsFull = String(st?.checkedAt || formatIsoOffset()).slice(11, 19);
  const ts = tsFull ? tsFull.slice(0, 5) : '--:--';
  const pipeline = flags.pipeline || st?.pipeline?.markdownBreadcrumb || '-';
  const mode = String(flags.mode || st?.automationMode || 'full-auto').toUpperCase();
  const batch = flags.batch || st?.batchId || 'BATCH';

  if (kind === 'heartbeat') {
    const activity = flags.activity ? String(flags.activity).trim() : '';
    if (st && !activity) {
      console.log(st.telemetryLine);
      return;
    }
    const progPart = pipeline && pipeline !== '-' ? `进度 ${pipeline}` : `批次 \`${batch}\``;
    if (activity) {
      const titleLine = st?.activeCrossAgent
        ? `> ◐ **独立审计进行中** · \`${ts}\` · \`${batch}\` · ${progPart}`
        : `> ● **研发推进中** · \`${ts}\` · \`${batch}\` · ${progPart}`;
      console.log(`${titleLine}\n> ${activity}`);
      return;
    }
    const roleLabel = formatRoleLabelCn(flags.role || 'ab');
    const dur = formatDurationCn(flags.idle ?? 0);
    const dirtyNum = Number(flags.dirty ?? 0);
    const dirtyTxt = !Number.isNaN(dirtyNum) && dirtyNum === 0 ? '工作区干净' : `当前工作区改动 ${flags.dirty ?? 0} 个文件`;
    console.log([
      `> ● **研发推进中** · \`${ts}\` · ${progPart}`,
      `> \`${roleLabel}\` 活跃（${dur}前有输出），${dirtyTxt}，一切正常，继续值守。`,
    ].join('\n'));
    return;
  }

  if (kind === 'nudge') {
    const task = flags.task || '当前任务';
    const roleRaw = String(flags.role || 'ab').toLowerCase();
    const roleLabel = formatRoleLabelCn(roleRaw);
    const dur = formatDurationCn(flags.idle ?? st?.roles?.[roleRaw]?.idleSeconds ?? 0);
    const exitCode = String(flags.exit ?? '0');
    const statusTxt = exitCode === '0' ? '投递成功' : `投递失败（退出码 ${exitCode}）`;
    console.log([
      `> ▲ **已自动唤醒推进** · \`${ts}\` · 任务 \`${task}\``,
      `> \`${roleLabel}\` 已静默 ${dur}，已自动发送续推指令（${statusTxt}），等待恢复执行。`,
    ].join('\n'));
    return;
  }

  if (kind === 'milestone') {
    const task = flags.task || 'T-01-R0';
    const verdictRaw = String(flags.verdict || '通过').trim();
    let verdictTitle = '审核完成';
    let verdictCell = verdictRaw;
    if (/通过|PASS/i.test(verdictRaw)) {
      verdictTitle = '审核通过';
      verdictCell = '审核通过';
    } else if (/整改|REWORK/i.test(verdictRaw)) {
      verdictTitle = '需要返修';
      verdictCell = '需要返修';
    } else if (/阻塞|BLOCKED/i.test(verdictRaw)) {
      verdictTitle = '遇到阻塞';
      verdictCell = '遇到阻塞';
    }
    const gate = flags.gate || (verdictCell === '审核通过' ? '已解锁下一阶段' : '等待处理');
    const sha8 = String(flags.sha || st?.git?.headShort || '--------').slice(0, 8);
    const reportName = flags.report ? path.basename(String(flags.report)) : '-';
    const sha256Short = flags.sha256 ? String(flags.sha256).slice(0, 8) : '-';
    const countsText = formatCountsCn(flags.counts || '0 / 0 / 0 / 0 / 0');
    const unverified = flags.unverified ? ` *（另有 ${flags.unverified} 项待实机验证）*` : '';
    const next = flags.next || '总控中枢核收后按流水线自动推进下一步';
    const modeCn = /SEMI/i.test(mode) ? '半自动' : '全自动';
    console.log([
      `> ◆ **阶段里程碑 · \`${task}\` ${verdictTitle}**（${gate}）`,
      `> 当前进度：${pipeline} ｜ 托管模式：${modeCn}`,
      '',
      '| 核验结论 | 问题统计 | 审计报告与代码快照 | 接下来的自动动作 |',
      '| :--- | :--- | :--- | :--- |',
      `| **${verdictCell}** · ${gate} | ${countsText}${unverified} | \`${reportName}\`（版本 \`${sha8}\` · 指纹 \`${sha256Short}\`） | ${next} |`,
    ].join('\n'));
    return;
  }

  if (kind === 'breaker') {
    const task = flags.task || 'T-01-FIX2-R0';
    const reason = flags.reason || '单阶段返修次数达到上限或遇到阻塞门禁';
    const sha8 = String(flags.sha || st?.git?.headShort || '--------').slice(0, 8);
    const report = flags.report ? path.basename(String(flags.report)) : '-';
    const options = flags.options || '① 批准追加修复轮次；② 发起 Spec 变更；③ 人工接管';
    console.log([
      '> [!CAUTION]',
      `> **■ 自动推进已暂停 · 任务 \`${task}\` 需要你拍板**`,
      `> - **暂停原因**：${reason}`,
      `> - **当前现场**：代码版本 \`${sha8}\` · 审计报告 \`${report}\``,
      `> - **你可以选择**：${options}`,
    ].join('\n'));
    return;
  }

  if (kind === 'complete') {
    const countdown = flags.countdown ? `\`${flags.countdown} 秒后自动关机\`` : '`未启用自动关机`';
    const rawStages = String(flags.stages || '');
    const rows = [];
    if (rawStages.trim().startsWith('[')) {
      for (const item of JSON.parse(rawStages)) {
        const gateCn = /PASS|通过/i.test(String(item.gate || '通过')) ? '通过' : String(item.gate);
        rows.push(`| \`${item.stage || '-'}\` | \`${String(item.sha || '-').slice(0, 8)}\` | \`${item.fixes ?? 0} 次\` | \`${item.report ? path.basename(String(item.report)) : '-'}\` | ${gateCn} |`);
      }
    } else if (rawStages.trim()) {
      for (const seg of rawStages.split(',').map((s) => s.trim()).filter(Boolean)) {
        const [stg = '-', sha = '-', fixes = '0', report = '-', _hash = '-', gate = '通过'] = seg.split(':');
        const gateCn = /PASS|通过/i.test(String(gate || '通过')) ? '通过' : gate;
        rows.push(`| \`${stg}\` | \`${sha.slice(0, 8)}\` | \`${fixes} 次\` | \`${path.basename(report)}\` | ${gateCn} |`);
      }
    } else {
      rows.push(`| \`${batch}\` | \`${st?.git?.headShort ?? '-'}\` | \`0 次\` | \`FINAL_SUMMARY.md\` | 通过 |`);
    }
    console.log([
      '> [!TIP]',
      `> **✓ 全部阶段已完成 · \`${batch}\` 独立审计闭环**`,
      `> 完成进度：${pipeline} ｜ 自动巡检已停止 ｜ 关机倒计时：${countdown}`,
      '',
      '| 阶段 | 最终代码版本 | 返修次数 | 独立审计报告 | 结论 |',
      '| :--- | :---: | :---: | :--- | :---: |',
      ...rows,
    ].join('\n'));
    return;
  }

  throw new Error(`Unknown render subcommand "${kind}". Expected: heartbeat, nudge, milestone, breaker, or complete.`);
}

function cmdSend(flags) {
  const ctx = loadConfigAndPaths(flags);
  const role = normalizeRoleName(flags.role, 'send --role');
  if (!flags.file) throw new Error('Missing --file <message-file>');
  const msgPath = path.resolve(flags.file);
  if (!fs.existsSync(msgPath)) throw new Error(`Message file missing: ${msgPath}`);

  const rawMsg = fs.readFileSync(msgPath, 'utf8').replace(/\r\n/g, '\n');
  if (!rawMsg.trim()) throw new Error('Message file is empty');

  const st = collectStatus(ctx);
  const state = loadOrCreateState(ctx.statePath);
  const roleInfo = st.roles[role];
  const tid = roleInfo?.uuid;
  if (!tid || !UUID_EXACT_RE.test(tid)) {
    throw new Error(`No Codex thread resolved for role "${role}" (resolvedVia=${roleInfo?.resolvedVia}, matcher=${roleInfo?.matcher || '-'}). Bind or spawn one first.`);
  }
  const roleState = state.roles[role] || {};
  const maxNoProgress = ctx.config.thresholds?.maxNoProgressPushes ?? 3;

  if (!flags.force) {
    if (roleInfo.lastWrite && roleState.lastPushThreadWrite === roleInfo.lastWrite) {
      console.error(`REFUSED_DUPLICATE: ${role} last_write (${roleInfo.lastWrite}) unchanged since last push.`);
      process.exitCode = 1;
      return;
    }
    if (!st.changedSinceLastSnapshot && (roleState.consecutivePushesWithoutProgress || 0) >= maxNoProgress) {
      console.error(`CIRCUIT_BREAKER: ${role} reached maxNoProgressPushes (${maxNoProgress}) with no change in Git/Board/TaskCard.`);
      process.exitCode = 1;
      return;
    }
  }

  const targetCwd = resolveRoleCwdForCodex(ctx.config, role, ctx.winProjectRoot);
  let sendRes;
  if (ctx.config.runtime === 'wsl') {
    const bashScript = `
set -u
export PATH="$HOME/.local/bin:$PATH"
TID="$1"
CWD="$2"
MSG=$(cat; printf x)
MSG=\${MSG%x}
cd "$CWD" || exit 2
timeout 120 codex queue --thread "$TID" --message "$MSG" --resume -C "$CWD" 2>&1 | tail -n 20
exit \${PIPESTATUS[0]}
`;
    sendRes = runWslBash(ctx.config.wslDistro, bashScript, [tid, targetCwd], rawMsg, 130000);
  } else {
    const rt = normalizeRuntime(ctx.config.runtime);
    const codexExe = resolveLocalCodexBin(ctx.config, rt);
    if (!codexExe) throw new Error(`Cannot locate ${rt} codex binary; configure codexBin in relay.json`);
    sendRes = spawnSync(
      codexExe,
      ['queue', '--thread', tid, '--message', rawMsg, '--resume', '-C', targetCwd],
      { encoding: 'utf8', timeout: 120000, windowsHide: true, shell: false },
    );
  }

  const output = ((sendRes.stdout || '') + '\n' + (sendRes.stderr || '')).trim();
  if (output) console.log(output);

  if (sendRes.status !== 0) {
    console.error(`SEND_FAILED exit=${sendRes.status} ${sendRes.error?.message || ''}`);
    process.exitCode = sendRes.status || 1;
    return;
  }

  // Archive copy under relayDir/messages
  const archiveDir = path.join(ctx.relayDir, 'messages');
  fs.mkdirSync(archiveDir, { recursive: true });
  const archiveName = `${Date.now()}-${role}-${path.basename(msgPath)}`;
  fs.writeFileSync(path.join(archiveDir, archiveName), rawMsg, 'utf8');

  const hadProgress = st.changedSinceLastSnapshot || !state.lastObservedSnapshot.boardMtimeSec;
  roleState.lastPushAt = formatIsoOffset();
  roleState.lastPushThreadWrite = roleInfo.lastWrite;
  roleState.totalPushes = (roleState.totalPushes || 0) + 1;
  roleState.consecutivePushesWithoutProgress = hadProgress ? 1 : (roleState.consecutivePushesWithoutProgress || 0) + 1;
  state.roles[role] = roleState;
  state.lastObservedSnapshot = st.snapshot;
  saveState(ctx.statePath, state);

  const reason = flags.reason || 'anti-stall-push';
  appendRelayLog(ctx.logPath, `PUSH ${role.toUpperCase()} file=${path.basename(msgPath)} exit=0 thread_last_write=${roleInfo.lastWrite} no_prog_count=${roleState.consecutivePushesWithoutProgress} reason=${reason}`);
}

function cmdBind(flags) {
  const ctx = loadConfigAndPaths(flags);
  const role = normalizeRoleName(flags.role, 'bind --role');

  const state = loadOrCreateState(ctx.statePath);
  const oldTid = ctx.config.threads?.[role] || '';
  ctx.config.threads = ctx.config.threads || {};
  ctx.config.threadMatchers = ctx.config.threadMatchers || {};

  if (flags.auto) {
    ctx.config.threads[role] = '';
    if (typeof flags.match === 'string' && flags.match.trim()) {
      ctx.config.threadMatchers[role] = flags.match.trim();
    }
    fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.config, null, 2) + '\n', 'utf8');
    state.roles[role] = { lastPushAt: null, lastPushThreadWrite: null, consecutivePushesWithoutProgress: 0, totalPushes: state.roles[role]?.totalPushes || 0 };
    saveState(ctx.statePath, state);
    appendRelayLog(ctx.logPath, `BIND_AUTO role=${role.toUpperCase()} matcher=${JSON.stringify(ctx.config.threadMatchers[role] || '')}`);
    console.log(JSON.stringify({ ok: true, mode: 'auto', role, matcher: ctx.config.threadMatchers[role] || '' }, null, 2));
    return;
  }

  let newTid = '';
  let matchedName = '';
  let mode = '';
  if (flags.thread) {
    if (!UUID_EXACT_RE.test(flags.thread)) throw new Error('Invalid 36-char --thread UUID');
    newTid = flags.thread.toLowerCase();
    mode = 'thread';
  } else if (typeof flags.match === 'string' && flags.match.trim()) {
    const kw = flags.match.trim();
    const list = listAllRuntimeThreads(ctx.config.runtime || 'windows', ctx.config.wslDistro || '');
    const found = list.find((t) =>
      (t.threadName && t.threadName.toLowerCase().includes(kw.toLowerCase())) ||
      t.uuid.toLowerCase().includes(kw.toLowerCase()));
    if (!found) throw new Error(`No Codex session found matching keyword "${kw}" in runtime=${ctx.config.runtime}`);
    newTid = found.uuid;
    matchedName = found.threadName || '';
    ctx.config.threadMatchers[role] = kw;
    mode = 'match';
  } else {
    throw new Error('bind requires one of: --thread <uuid>, --match <keyword>, or --auto');
  }

  ctx.config.threads[role] = newTid;
  fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.config, null, 2) + '\n', 'utf8');
  state.roles[role] = { lastPushAt: null, lastPushThreadWrite: null, consecutivePushesWithoutProgress: 0, totalPushes: state.roles[role]?.totalPushes || 0 };
  state.rotations.push({ role, oldTid, newTid, reason: `bind-${mode}`, at: formatIsoOffset() });
  saveState(ctx.statePath, state);
  appendRelayLog(ctx.logPath, `BIND_${mode.toUpperCase()} role=${role.toUpperCase()} old=${oldTid || '-'} new=${newTid}${matchedName ? ` name=${JSON.stringify(matchedName)}` : ''}`);
  console.log(JSON.stringify({ ok: true, mode, role, oldTid, newTid, threadName: matchedName }, null, 2));
}

function cmdSpawn(flags) {
  const ctx = loadConfigAndPaths(flags);
  const role = normalizeRoleName(flags.role, 'spawn --role');

  const sandbox = flags.sandbox || (role === 'hub' ? 'read-only' : 'workspace-write');
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(sandbox)) {
    throw new Error(`Invalid --sandbox: ${sandbox}`);
  }

  let promptText = '';
  if (flags['prompt-file']) {
    const pf = path.resolve(flags['prompt-file']);
    if (!fs.existsSync(pf)) throw new Error(`Prompt file not found: ${pf}`);
    promptText = fs.readFileSync(pf, 'utf8').replace(/\r\n/g, '\n');
  } else if (typeof flags.prompt === 'string' && flags.prompt.trim()) {
    promptText = flags.prompt.replace(/\r\n/g, '\n');
  } else {
    const devRel = ctx.config.devDir || '.agents/development';
    promptText = [
      `你是项目「${ctx.config.projectName}」（批次 ${ctx.config.batchId}）新创建的 ${role.toUpperCase()} 会话。`,
      `请以只读方式先阅读 ${devRel}/STATE.md 与 ${devRel}/DISPATCH_BOARD.md 了解角色写入边界、当前阶段与最新任务卡。`,
      `核对无误后回复简短接班就绪确认（列出你的角色与当前仓库 HEAD）。`,
    ].join('\n');
  }

  const targetCwd = resolveRoleCwdForCodex(ctx.config, role, ctx.winProjectRoot);
  const winSpawnCwd = resolveRoleWinCwd(ctx.config, role, ctx.winProjectRoot);
  const execArgs = ['exec', '-C', targetCwd, '-s', sandbox, '-a', 'never', '--json', '-'];
  if (flags['dry-run']) {
    console.log(JSON.stringify({
      dryRun: true,
      runtime: ctx.config.runtime,
      wslDistro: ctx.config.wslDistro || '',
      projectPath: targetCwd,
      role,
      sandbox,
      args: execArgs,
      promptPreview: promptText.slice(0, 300),
    }, null, 2));
    return;
  }

  let spawnRes;
  if (ctx.config.runtime === 'wsl') {
    const bashScript = `
set -u
export PATH="$HOME/.local/bin:$PATH"
CWD="$1"
SANDBOX="$2"
cd "$CWD" || exit 2
codex exec -C "$CWD" -s "$SANDBOX" -a never --json -
`;
    spawnRes = runWslBash(ctx.config.wslDistro, bashScript, [targetCwd, sandbox], promptText, 180000);
  } else {
    const rt = normalizeRuntime(ctx.config.runtime);
    const codexExe = resolveLocalCodexBin(ctx.config, rt);
    if (!codexExe) throw new Error(`Cannot locate ${rt} codex binary; configure codexBin in relay.json`);
    spawnRes = spawnSync(codexExe, execArgs, {
      cwd: winSpawnCwd,
      input: promptText,
      encoding: 'utf8',
      timeout: 180000,
      windowsHide: true,
      shell: false,
    });
  }

  let threadId = null;
  for (const line of (spawnRes.stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const ev = JSON.parse(line);
      if (ev?.type === 'thread.started' && ev.thread_id && UUID_EXACT_RE.test(String(ev.thread_id))) {
        threadId = String(ev.thread_id).toLowerCase();
        break;
      }
    } catch {
      // ignore non-json lines
    }
  }

  if (spawnRes.status !== 0 || !threadId) {
    const snippet = ((spawnRes.stderr || '') + '\n' + (spawnRes.stdout || '')).trim().slice(-500);
    throw new Error(`spawn failed (exit=${spawnRes.status}, threadId=${threadId}): ${snippet}`);
  }

  const state = loadOrCreateState(ctx.statePath);
  const oldTid = ctx.config.threads?.[role] || '';
  ctx.config.threads = { ...(ctx.config.threads || {}), [role]: threadId };
  fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.config, null, 2) + '\n', 'utf8');
  state.roles[role] = { lastPushAt: null, lastPushThreadWrite: null, consecutivePushesWithoutProgress: 0, totalPushes: state.roles[role]?.totalPushes || 0 };
  state.rotations.push({ role, oldTid, newTid: threadId, reason: 'spawn-fresh', at: formatIsoOffset() });
  saveState(ctx.statePath, state);
  appendRelayLog(ctx.logPath, `SPAWN_THREAD role=${role.toUpperCase()} sandbox=${sandbox} old=${oldTid || '-'} new=${threadId}`);

  console.log(JSON.stringify({ ok: true, role, threadId, oldTid, sandbox, projectPath: ctx.config.projectPath }, null, 2));
}

function cmdState(flags, action) {
  const ctx = loadConfigAndPaths(flags);
  const state = loadOrCreateState(ctx.statePath);

  if (!action || action === 'show') {
    console.log(JSON.stringify(state, null, 2));
    return;
  }

  if (action === 'start-review') {
    if (!flags.task || !flags.subagent || !flags.output) {
      throw new Error('start-review requires --task, --subagent, and --output');
    }
    state.activeCrossAgent = {
      taskId: flags.task,
      role: flags.role || 'R0',
      subagentId: flags.subagent,
      outputPath: flags.output,
      handoffKey: flags.handoff || null,
      startedAt: formatIsoOffset(),
    };
    saveState(ctx.statePath, state);
    appendRelayLog(ctx.logPath, `CROSS-AGENT DISPATCHED task=${flags.task} role=${flags.role || 'R0'} subagent=${flags.subagent} expected=${flags.output}`);
    console.log(JSON.stringify({ ok: true, activeCrossAgent: state.activeCrossAgent }, null, 2));
    return;
  }

  if (action === 'finish-review') {
    if (!flags.task || !flags.verdict) {
      throw new Error('finish-review requires --task and --verdict');
    }
    const stageKey = normalizeStageKey(flags.task);
    const maxFixRounds = ctx.config.thresholds?.maxFixRounds ?? 2;
    if (flags.verdict === '要求整改') {
      state.stageFixes[stageKey] = (state.stageFixes[stageKey] || 0) + 1;
    } else if (flags.verdict === '通过') {
      state.passedStages[stageKey] = {
        taskId: flags.task,
        report: flags.report || state.activeCrossAgent?.outputPath || null,
        sha256: flags.sha256 || null,
        passedAt: formatIsoOffset(),
      };
    }
    if (state.activeCrossAgent?.handoffKey && !state.processedHandoffs.includes(state.activeCrossAgent.handoffKey)) {
      state.processedHandoffs.push(state.activeCrossAgent.handoffKey);
    }
    state.activeCrossAgent = null;
    saveState(ctx.statePath, state);
    const fixCount = state.stageFixes[stageKey] || 0;
    const fixCapTriggered = fixCount >= maxFixRounds && flags.verdict === '要求整改';
    appendRelayLog(ctx.logPath, `CROSS-AGENT DONE task=${flags.task} stage=${stageKey} verdict=${flags.verdict} fix_count=${fixCount}/${maxFixRounds} sha256=${flags.sha256 || '-'} report=${flags.report || '-'}`);
    console.log(JSON.stringify({
      ok: true,
      stageKey,
      verdict: flags.verdict,
      fixCount,
      maxFixRounds,
      fixCapBreaker: fixCapTriggered,
    }, null, 2));
    return;
  }

  if (action === 'mark-processed') {
    if (!flags.handoff) throw new Error('mark-processed requires --handoff <id>');
    if (!state.processedHandoffs.includes(flags.handoff)) {
      state.processedHandoffs.push(flags.handoff);
    }
    saveState(ctx.statePath, state);
    console.log(JSON.stringify({ ok: true, processedHandoffs: state.processedHandoffs }, null, 2));
    return;
  }

  if (action === 'rotate-thread') {
    const role = normalizeRoleName(flags.role, 'rotate-thread --role');
    if (!flags.thread || !UUID_EXACT_RE.test(flags.thread)) throw new Error('rotate-thread requires valid 36-char --thread UUID');
    const oldTid = ctx.config.threads?.[role] || '';
    const newTid = flags.thread.toLowerCase();
    ctx.config.threads = { ...(ctx.config.threads || {}), [role]: newTid };
    fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.config, null, 2) + '\n', 'utf8');
    state.roles[role] = { lastPushAt: null, lastPushThreadWrite: null, consecutivePushesWithoutProgress: 0, totalPushes: state.roles[role]?.totalPushes || 0 };
    state.rotations.push({ role, oldTid, newTid, reason: flags.reason || 'session-rotation', at: formatIsoOffset() });
    saveState(ctx.statePath, state);
    appendRelayLog(ctx.logPath, `ROTATE_THREAD role=${role.toUpperCase()} old=${oldTid || '-'} new=${newTid} reason=${flags.reason || 'session-rotation'}`);
    console.log(JSON.stringify({ ok: true, role, oldTid, newTid }, null, 2));
    return;
  }

  if (action === 'reset-pushes') {
    const role = normalizeRoleName(flags.role, 'reset-pushes --role');
    state.roles[role] = { ...(state.roles[role] || {}), consecutivePushesWithoutProgress: 0 };
    saveState(ctx.statePath, state);
    console.log(JSON.stringify({ ok: true, role, consecutivePushesWithoutProgress: 0 }, null, 2));
    return;
  }

  throw new Error(`Unknown state action: ${action}`);
}

function buildWebhookPayload(type, event, title, message, ctx) {
  const fullTitle = `[${ctx.config.projectName} / ${ctx.config.batchId}] [${event.toUpperCase()}] ${title}`;
  const bodyText = `${fullTitle}\n\n${message}\n时间：${formatIsoOffset()}`;
  switch ((type || 'generic').toLowerCase()) {
    case 'feishu':
      return { msg_type: 'text', content: { text: bodyText } };
    case 'wecom':
      return { msgtype: 'text', text: { content: bodyText } };
    case 'dingtalk':
      return { msgtype: 'text', text: { content: bodyText } };
    default:
      return {
        event,
        project: ctx.config.projectName,
        batchId: ctx.config.batchId,
        title,
        message,
        timestamp: formatIsoOffset(),
      };
  }
}

async function cmdNotify(flags) {
  const ctx = loadConfigAndPaths(flags);
  const webhook = ctx.config.webhook || {};
  const event = flags.event || 'info';
  const title = flags.title || 'Relay Notification';
  const message = flags.message || '';
  const payload = buildWebhookPayload(webhook.type, event, title, message, ctx);

  const envName = webhook.envUrl || 'RELAY_WEBHOOK_URL';
  const targetUrl = process.env[envName] || webhook.url || '';

  if (flags['dry-run']) {
    console.log(JSON.stringify({
      dryRun: true,
      enabled: Boolean(webhook.enabled),
      type: webhook.type || 'generic',
      urlConfigured: Boolean(targetUrl),
      payload,
    }, null, 2));
    return;
  }

  if (!webhook.enabled || !targetUrl) {
    console.log(JSON.stringify({
      sent: false,
      skipped: true,
      reason: !webhook.enabled ? 'webhook.enabled is false' : `webhook URL empty (checked env:${envName} & config.webhook.url)`,
    }));
    return;
  }

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`Webhook HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  appendRelayLog(ctx.logPath, `NOTIFY event=${event} type=${webhook.type} status=${res.status}`);
  console.log(JSON.stringify({ sent: true, status: res.status, responseSnippet: text.slice(0, 200) }));
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];
  if (!cmd || flags.help) {
    printHelp();
    return;
  }
  switch (cmd) {
    case 'init':
      cmdInit(flags);
      break;
    case 'threads':
      cmdThreads(flags);
      break;
    case 'bind':
      cmdBind(flags);
      break;
    case 'spawn':
      cmdSpawn(flags);
      break;
    case 'status':
      cmdStatus(flags);
      break;
    case 'render':
      cmdRender(flags, positionals[1]);
      break;
    case 'send':
      cmdSend(flags);
      break;
    case 'state':
      cmdState(flags, positionals[1]);
      break;
    case 'notify':
      await cmdNotify(flags);
      break;
    default:
      throw new Error(`Unknown command: ${cmd}. Use --help for usage.`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
