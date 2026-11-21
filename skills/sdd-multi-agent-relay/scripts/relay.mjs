#!/usr/bin/env node
/**
 * Cross-platform (WSL + Windows native) relay & anti-stall supervisor CLI
 * for the Spec-Driven Multi-Agent Gated Workflow (0 + 2 + 3 roles).
 *
 * Strictly reads ONLY Codex session metadata (mtime, size, filename UUID),
 * NEVER reads ~/.codex/sessions/*.jsonl file contents.
 */

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
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
            Options: [--config <path> | --project <dir>] [--compact] [--check-procs] [--json]

  procs     Inspect running build/test worker processes and classify attached vs orphan (ppid lineage)
            Options: [--config <path> | --project <dir>] [--runtime <wsl|windows|posix>] [--distro <name>]
                     [--filter <regex>] [--input <ps-file>] [--json]

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

  analyze   Read-only pre-flight drift & consistency check (Spec V-xx/PD-xx, board IDs/tags/links, budgets, events, breakers)
            Options: [--config <path> | --project <dir>] [--json]

  event     Zero-dependency event signal bus (.agents/relay/events.jsonl)
            Actions:
              emit   --role <role> --type <done|blocked|review_ready|heartbeat|decision_needed> [--task <id>] [--sha <sha>] [--message <text>]
              list   [--all] [--limit <n>] [--json]
              ack    (--all | --id <eventId> | --task <id> | --role <role>)
              clear  [--all]

  compact   Monitor context budgets and archive old DISPATCH_BOARD.md scheduling logs safely
            Options: [--config <path> | --project <dir>] [--dry-run] [--apply] [--keep-logs <n>] [--json]

  ui        Generate or serve zero-dependency offline Chinese HTML cockpit
            Options: [--config <path> | --project <dir>] [--export <file.html>] [--host <addr>] [--port <4317>]
`);
}

const BOOLEAN_FLAGS = new Set([
  'help', 'json', 'compact', 'force', 'dry-run', 'apply', 'auto', 'all', 'no-gitignore', 'check-procs',
]);

function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
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
  const eventsPath = path.join(relayDir, 'events.jsonl');
  return { config, configPath, winProjectRoot, devDir, relayDir, statePath, logPath, eventsPath };
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
    stageTimers: {},
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
      stageTimers: parsed.stageTimers || {},
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

const DEFAULT_CONTEXT_BUDGETS = {
  stateMaxLines: 120,
  boardMaxLines: 160,
  taskCardMaxLines: 250,
};

const VALID_EVENT_TYPES = new Set([
  'done', 'blocked', 'review_ready', 'heartbeat', 'decision_needed',
]);

function splitTableCells(row) {
  const rawCells = String(row || '').split('|').map((c) => c.trim());
  if (rawCells[0] === '') rawCells.shift();
  if (rawCells.length > 0 && rawCells[rawCells.length - 1] === '') rawCells.pop();
  return rawCells;
}

function isMarkdownSepRow(cells) {
  return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
}

function parseBoardDocument(boardPath) {
  if (!boardPath || !fs.existsSync(boardPath)) {
    return {
      exists: false,
      lines: [],
      taskHeaderCells: [],
      waveColIdx: -1,
      titleColIdx: 1,
      taskRows: [],
      logHeaderLine: '| 时间 | 任务编号 | 动作摘要 | 来源 → 去向 | 关联 SHA / 版本 | 备注与核收凭据 |',
      logSepLine: '| --- | --- | --- | --- | --- | --- |',
      logRows: [],
      logStartIdx: -1,
      logEndIdx: -1,
    };
  }
  const lines = fs.readFileSync(boardPath, 'utf8').split(/\r?\n/);
  const sec1Idx = lines.findIndex((l) => /^##\s*1\.|阶段任务总表/.test(l));
  const sec2Idx = lines.findIndex((l) => /^##\s*2\.|时序.*日志|调度日志/.test(l));

  const taskRangeStart = sec1Idx >= 0 ? sec1Idx + 1 : 0;
  const taskRangeEnd = sec2Idx >= 0 ? sec2Idx : lines.length;
  let taskHeaderCells = [];
  let seenTaskSep = false;
  const taskRows = [];

  for (let i = taskRangeStart; i < taskRangeEnd; i++) {
    const ln = lines[i].trim();
    if (!ln.startsWith('|')) continue;
    const cells = splitTableCells(ln);
    if (cells.length < 2) continue;
    if (isMarkdownSepRow(cells)) {
      seenTaskSep = true;
      continue;
    }
    if (!seenTaskSep && taskHeaderCells.length === 0) {
      taskHeaderCells = cells;
      continue;
    }
    if (/^`?20\d{2}-/.test(cells[0])) continue;
    taskRows.push({ lineNum: i + 1, raw: lines[i], cells });
  }

  let waveColIdx = -1;
  let titleColIdx = 1;
  if (taskHeaderCells.length > 0) {
    const foundWave = taskHeaderCells.findIndex((h) => /波次|Wave/i.test(h));
    if (foundWave >= 0) {
      waveColIdx = foundWave;
      titleColIdx = foundWave === 1 && taskHeaderCells.length > 2 ? 2 : 1;
    }
  }

  let logHeaderLine = '| 时间 | 任务编号 | 动作摘要 | 来源 → 去向 | 关联 SHA / 版本 | 备注与核收凭据 |';
  let logSepLine = '| --- | --- | --- | --- | --- | --- |';
  const logRows = [];
  let logStartIdx = -1;
  let logEndIdx = -1;

  if (sec2Idx >= 0) {
    let seenLogHeader = false;
    let seenLogSep = false;
    for (let i = sec2Idx + 1; i < lines.length; i++) {
      const ln = lines[i].trim();
      if (!ln.startsWith('|')) {
        if (seenLogSep && ln !== '') break;
        continue;
      }
      const cells = splitTableCells(ln);
      if (!seenLogHeader) {
        logHeaderLine = lines[i];
        seenLogHeader = true;
        continue;
      }
      if (!seenLogSep && isMarkdownSepRow(cells)) {
        logSepLine = lines[i];
        seenLogSep = true;
        continue;
      }
      if (logStartIdx === -1) logStartIdx = i;
      logEndIdx = i;
      logRows.push({ lineNum: i + 1, raw: lines[i], cells });
    }
  } else {
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      if (/^\|\s*`?20\d{2}-/.test(ln)) {
        if (logStartIdx === -1) logStartIdx = i;
        logEndIdx = i;
        logRows.push({ lineNum: i + 1, raw: ln, cells: splitTableCells(ln) });
      }
    }
  }

  return {
    exists: true,
    lines,
    taskHeaderCells,
    waveColIdx,
    titleColIdx,
    taskRows,
    logHeaderLine,
    logSepLine,
    logRows,
    logStartIdx,
    logEndIdx,
  };
}

function classifyBoardRowStatus(cells, rawId, stageKey, state, activeCrossAgent, waveColIdx = -1) {
  if (state?.passedStages?.[stageKey]) return 'done';
  const activeStage = activeCrossAgent?.taskId ? normalizeStageKey(activeCrossAgent.taskId) : null;
  if (activeStage && activeStage === stageKey) return 'active';

  const statusText = cells
    .filter((_, idx) => idx !== 0 && idx !== waveColIdx)
    .join(' | ');
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

function parsePipelineSummary(boardTaskRows, state, activeCrossAgent, waveColIdx = -1) {
  const stageMap = new Map();
  let seq = 0;

  for (const entry of boardTaskRows || []) {
    const rawCells = typeof entry === 'string' ? splitTableCells(entry) : entry.cells;
    if (rawCells.length < 2) continue;

    const rawId = rawCells[0].replace(/`/g, '').trim();
    if (!rawId || /^<.*>$/.test(rawId) || /^---+$/.test(rawId)) continue;

    const stageKey = normalizeStageKey(rawId);
    const isReview = /(?:[-_]REVIEW|[-_]R0)$/i.test(rawId);
    const fixMatch = rawId.match(/[-_]FIX(\d+)/i);
    const round = fixMatch ? parseInt(fixMatch[1], 10) : 0;
    const rank = round * 2 + (isReview ? 1 : 0);
    const status = classifyBoardRowStatus(rawCells, rawId, stageKey, state, activeCrossAgent, waveColIdx);

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

function parseWaveSummary(boardTaskRows, config, state, activeCrossAgent, waveColIdx = -1) {
  const stageStatusMap = new Map();
  const stageWaveMeta = new Map();
  const stageOrder = [];

  const configWaveMetaById = new Map();
  const configTaskToWave = new Map();
  for (const w of Array.isArray(config?.waves) ? config.waves : []) {
    if (!w || typeof w !== 'object') continue;
    const wid = String(w.id || w.wave || '').trim().toUpperCase();
    if (!wid) continue;
    const deps = Array.isArray(w.dependsOn) ? w.dependsOn.map((d) => String(d).trim().toUpperCase()).filter(Boolean) : [];
    configWaveMetaById.set(wid, { name: String(w.name || '').trim(), dependsOn: deps });
    for (const t of Array.isArray(w.tasks) ? w.tasks : []) {
      const tid = normalizeStageKey(String(t || '').trim());
      if (tid) configTaskToWave.set(tid, { wave: wid, dependsOn: deps });
    }
  }

  for (const entry of boardTaskRows || []) {
    const rawCells = typeof entry === 'string' ? splitTableCells(entry) : entry.cells;
    if (rawCells.length < 2) continue;
    const rawId = rawCells[0].replace(/`/g, '').trim();
    if (!rawId || /^<.*>$/.test(rawId) || /^---+$/.test(rawId)) continue;

    const stageKey = normalizeStageKey(rawId);
    const isReview = /(?:[-_]REVIEW|[-_]R0)$/i.test(rawId);
    const fixMatch = rawId.match(/[-_]FIX(\d+)/i);
    const round = fixMatch ? parseInt(fixMatch[1], 10) : 0;
    const rank = round * 2 + (isReview ? 1 : 0);
    const status = classifyBoardRowStatus(rawCells, rawId, stageKey, state, activeCrossAgent, waveColIdx);

    const prev = stageStatusMap.get(stageKey);
    if (!prev) {
      stageStatusMap.set(stageKey, { stage: stageKey, status, rank });
      stageOrder.push(stageKey);
    } else if (status === 'done' || rank >= prev.rank) {
      if (prev.status !== 'done' || status === 'done' || !isReview) {
        prev.status = status;
        prev.rank = Math.max(prev.rank, rank);
      }
    }

    const waveIdx = waveColIdx >= 0 ? waveColIdx : (rawCells.length >= 8 && /W\d+/i.test(rawCells[1]) ? 1 : -1);
    const waveCell = waveIdx >= 0 ? String(rawCells[waveIdx] || '').replace(/`/g, ' ').trim() : '';
    const wMatch = waveCell.match(/\b(W\d+)\b/i);
    if (wMatch) {
      const waveId = wMatch[1].toUpperCase();
      const depTasks = Array.from(new Set(
        (waveCell.match(/\bT-\d+(?:\.\d+)?\b/gi) || []).map((x) => normalizeStageKey(x)).filter((x) => x !== stageKey),
      ));
      const depWaves = Array.from(new Set(
        (waveCell.match(/\bW\d+\b/gi) || []).map((x) => x.toUpperCase()).filter((x) => x !== waveId),
      ));
      const existingMeta = stageWaveMeta.get(stageKey) || { wave: waveId, taskDeps: [], waveDeps: [] };
      existingMeta.wave = waveId;
      existingMeta.taskDeps = Array.from(new Set([...existingMeta.taskDeps, ...depTasks]));
      existingMeta.waveDeps = Array.from(new Set([...existingMeta.waveDeps, ...depWaves]));
      stageWaveMeta.set(stageKey, existingMeta);
    } else if (!stageWaveMeta.has(stageKey) && configTaskToWave.has(stageKey)) {
      const cfgMeta = configTaskToWave.get(stageKey);
      stageWaveMeta.set(stageKey, { wave: cfgMeta.wave, taskDeps: [], waveDeps: [...cfgMeta.dependsOn] });
    }
  }

  for (const [taskKey, cfgMeta] of configTaskToWave.entries()) {
    if (!stageStatusMap.has(taskKey)) {
      stageStatusMap.set(taskKey, { stage: taskKey, status: state?.passedStages?.[taskKey] ? 'done' : 'pending', rank: 0 });
      stageOrder.push(taskKey);
      stageWaveMeta.set(taskKey, { wave: cfgMeta.wave, taskDeps: [], waveDeps: [...cfgMeta.dependsOn] });
    }
  }

  const waveGroups = new Map();
  for (const stageKey of stageOrder) {
    const meta = stageWaveMeta.get(stageKey);
    if (!meta) continue;
    const wid = meta.wave;
    if (!waveGroups.has(wid)) {
      const cfgMeta = configWaveMetaById.get(wid);
      waveGroups.set(wid, {
        wave: wid,
        name: cfgMeta?.name || '',
        dependsOn: new Set(cfgMeta?.dependsOn || []),
        tasks: [],
      });
    }
    const grp = waveGroups.get(wid);
    for (const wd of meta.waveDeps) grp.dependsOn.add(wd);
    const stInfo = stageStatusMap.get(stageKey);
    grp.tasks.push({
      task: stageKey,
      status: stInfo?.status || 'pending',
      dependsOn: Array.from(new Set([...meta.taskDeps, ...meta.waveDeps])),
    });
  }

  const waveNum = (wid) => {
    const m = String(wid).match(/\d+/);
    return m ? parseInt(m[0], 10) : Number.MAX_SAFE_INTEGER;
  };
  const items = Array.from(waveGroups.values())
    .sort((a, b) => waveNum(a.wave) - waveNum(b.wave) || a.wave.localeCompare(b.wave))
    .map((g) => {
      const total = g.tasks.length;
      const done = g.tasks.filter((t) => t.status === 'done').length;
      const active = g.tasks.filter((t) => t.status === 'active').length;
      const blocked = g.tasks.filter((t) => t.status === 'blocked').length;
      const pending = g.tasks.filter((t) => t.status === 'pending').length;
      let status = 'pending';
      if (total > 0 && done === total) status = 'done';
      else if (blocked > 0) status = 'blocked';
      else if (active > 0 || done > 0) status = 'active';
      return {
        wave: g.wave,
        name: g.name,
        dependsOn: Array.from(g.dependsOn),
        tasks: g.tasks,
        total,
        done,
        active,
        blocked,
        pending,
        status,
      };
    });

  const waveStatusMap = new Map(items.map((w) => [w.wave, w.status]));
  const currentItem =
    items.find((w) => w.status === 'active' || w.status === 'blocked') ||
    items.find((w) => w.status === 'pending') ||
    (items.length > 0 ? items[items.length - 1] : null);
  const currentWave = currentItem ? currentItem.wave : null;

  const parallelReady = [];
  if (currentItem) {
    for (const t of currentItem.tasks) {
      if (t.status !== 'pending') continue;
      const depsOk = t.dependsOn.every((dep) => {
        if (/^W\d+$/i.test(dep)) return waveStatusMap.get(dep.toUpperCase()) === 'done';
        return stageStatusMap.get(normalizeStageKey(dep))?.status === 'done';
      });
      if (depsOk) parallelReady.push(t.task);
    }
  }

  const summary = items.map((w) => {
    const label = w.status === 'done' ? '已完成' : (w.status === 'blocked' ? '阻塞' : (w.status === 'active' ? '进行中' : '待开始'));
    return `${w.wave} ${label}(${w.done}/${w.total})`;
  }).join(' · ');

  return {
    hasWaves: items.length > 0,
    currentWave,
    parallelReady,
    canParallelize: parallelReady.length >= 2,
    summary,
    items,
  };
}

function getContextBudgets(config) {
  const raw = config?.contextBudgets || {};
  const posInt = (v, dft) => (Number.isInteger(v) && v > 0 ? v : dft);
  return {
    stateMaxLines: posInt(raw.stateMaxLines, DEFAULT_CONTEXT_BUDGETS.stateMaxLines),
    boardMaxLines: posInt(raw.boardMaxLines, DEFAULT_CONTEXT_BUDGETS.boardMaxLines),
    taskCardMaxLines: posInt(raw.taskCardMaxLines, DEFAULT_CONTEXT_BUDGETS.taskCardMaxLines),
  };
}

function countFileLines(filePath) {
  if (!fs.existsSync(filePath)) return 0;
  const text = fs.readFileSync(filePath, 'utf8');
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

function inspectContextBudgets(ctx) {
  const budgets = getContextBudgets(ctx.config);
  const files = [];
  const checkFile = (relPath, fullPath, maxLines, kind) => {
    if (!fs.existsSync(fullPath)) return;
    const lines = countFileLines(fullPath);
    const exceeded = lines > maxLines;
    files.push({
      file: relPath,
      kind,
      lines,
      maxLines,
      exceeded,
      excessLines: exceeded ? lines - maxLines : 0,
    });
  };

  checkFile('STATE.md', path.join(ctx.devDir, 'STATE.md'), budgets.stateMaxLines, 'state');
  checkFile('DISPATCH_BOARD.md', path.join(ctx.devDir, 'DISPATCH_BOARD.md'), budgets.boardMaxLines, 'board');
  const tasksDir = path.join(ctx.devDir, 'tasks');
  if (fs.existsSync(tasksDir)) {
    for (const f of fs.readdirSync(tasksDir).sort()) {
      if (f.endsWith('.md')) {
        checkFile(`tasks/${f}`, path.join(tasksDir, f), budgets.taskCardMaxLines, 'taskCard');
      }
    }
  }
  const overBudgetFiles = files.filter((f) => f.exceeded);
  return {
    budgets,
    files,
    overBudgetCount: overBudgetFiles.length,
    overBudgetFiles,
  };
}

function formatEventTypeCn(type) {
  switch (String(type || '').toLowerCase()) {
    case 'done': return '任务完工';
    case 'blocked': return '遇到阻塞';
    case 'review_ready': return '送审就绪';
    case 'heartbeat': return '进度心跳';
    case 'decision_needed': return '等待拍板';
    default: return String(type || '事件信号');
  }
}

function readEvents(eventsPath) {
  if (!eventsPath || !fs.existsSync(eventsPath)) return [];
  const raw = fs.readFileSync(eventsPath, 'utf8');
  const events = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj === 'object') events.push(obj);
    } catch {
      // ignore malformed JSONL lines
    }
  }
  return events;
}

function writeEventsAtomic(eventsPath, events) {
  fs.mkdirSync(path.dirname(eventsPath), { recursive: true });
  const tmp = `${eventsPath}.tmp`;
  const payload = events.map((ev) => JSON.stringify(ev)).join('\n') + (events.length > 0 ? '\n' : '');
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, eventsPath);
}

function touchStageTimer(state, taskId, phase, extra = {}) {
  if (!taskId) return null;
  const stageKey = normalizeStageKey(taskId);
  const nowIso = formatIsoOffset();
  const nowMs = Date.now();
  state.stageTimers = state.stageTimers || {};
  const existing = state.stageTimers[stageKey] || {
    stage: stageKey,
    startedAt: nowIso,
    startedAtMs: nowMs,
    reviewStartedAt: null,
    reviewStartedAtMs: null,
    finishedAt: null,
    finishedAtMs: null,
    lastReviewDurationSec: null,
    totalReviewDurationSec: 0,
    elapsedSec: 0,
    status: 'active',
    lastEventAt: null,
    lastEventType: null,
  };
  if (!existing.startedAtMs) {
    existing.startedAt = existing.startedAt || nowIso;
    existing.startedAtMs = nowMs;
  }

  if (phase === 'start-review') {
    existing.reviewStartedAt = nowIso;
    existing.reviewStartedAtMs = nowMs;
    existing.status = 'reviewing';
  } else if (phase === 'finish-review') {
    const revStartMs = existing.reviewStartedAtMs || extra.fallbackReviewStartMs || existing.startedAtMs;
    const reviewDurationSec = revStartMs ? Math.max(0, Math.round((nowMs - revStartMs) / 1000)) : 0;
    existing.lastReviewDurationSec = reviewDurationSec;
    existing.totalReviewDurationSec = (existing.totalReviewDurationSec || 0) + reviewDurationSec;
    existing.finishedAt = nowIso;
    existing.finishedAtMs = nowMs;
    existing.elapsedSec = Math.max(0, Math.round((nowMs - existing.startedAtMs) / 1000));
    existing.status = extra.verdict === '通过' ? 'passed' : (extra.verdict === '阻塞' ? 'blocked' : 'rework');
  } else if (phase === 'event') {
    existing.lastEventAt = nowIso;
    existing.lastEventType = extra.eventType || null;
    existing.elapsedSec = Math.max(0, Math.round((nowMs - existing.startedAtMs) / 1000));
    if (extra.eventType === 'blocked' || extra.eventType === 'decision_needed') {
      existing.status = 'blocked';
    } else if (extra.eventType === 'review_ready') {
      existing.status = 'review_ready';
    } else if (!existing.finishedAtMs) {
      existing.status = 'active';
    }
  }

  state.stageTimers[stageKey] = existing;
  return existing;
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
  if (key === 'r0') return '独立审计 (R0)';
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
  const pendingEvents = Array.isArray(st.pendingEvents) ? st.pendingEvents : [];
  const hasPendingEvents = pendingEvents.length > 0;
  const hasAudit = Boolean(st.activeCrossAgent);
  const hasHandoff = (st.pendingCrossAgent?.length || 0) > 0;
  const hasWorktrees = Array.isArray(st.worktrees) && st.worktrees.length > 0;
  const hasWorking = allLive.some(([, info]) => info.status === 'WORKING');

  let title = '◌ **待命观察中**';
  if (hasBreaker) title = '■ **自动推进已暂停**';
  else if (hasPendingEvents) title = '◆ **收到事件信号**';
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
  const latestEventAt = pendingEvents.length > 0 ? pendingEvents[pendingEvents.length - 1]?.createdAt : null;
  const tsSource = latestEventAt || latestLastWrite || st.checkedAt || '';
  const tsFull = String(tsSource).slice(11, 19);
  const ts = tsFull ? tsFull.slice(0, 5) : '--:--';

  const waveSuffix = st.waves?.hasWaves && st.waves.currentWave ? ` · 波次 \`${st.waves.currentWave}\`` : '';
  const timerSuffix = st.activeStageTimer && st.activeStageTimer.elapsedSec !== null && st.activeStageTimer.elapsedSec !== undefined
    ? ` · 已耗时 ${st.activeStageTimer.elapsedCn || formatDurationCn(st.activeStageTimer.elapsedSec)}`
    : '';
  const headerLine = st.pipeline?.markdownBreadcrumb
    ? `> ${title} · \`${ts}\` · \`${st.batchId}\` · 进度 ${st.pipeline.markdownBreadcrumb}${waveSuffix}${timerSuffix}`
    : `> ${title} · \`${ts}\` · 批次 \`${st.batchId}\`${waveSuffix}${timerSuffix}`;

  let detailLine = '';
  if (hasBreaker) {
    const evExtra = hasPendingEvents ? `（另有 ${pendingEvents.length} 条待处理事件信号）` : '';
    detailLine = `> 触发安全熔断保护，自动中继已暂停，等待你确认处理方式${evExtra}。`;
  } else if (hasPendingEvents) {
    const latestEv = pendingEvents[pendingEvents.length - 1];
    const roleCn = formatRoleLabelCn(latestEv.role || 'ab');
    const typeCn = formatEventTypeCn(latestEv.type);
    const taskPart = latestEv.task ? `（任务 \`${latestEv.task}\`）` : '';
    const msgPart = latestEv.message ? `：${latestEv.message}` : '';
    const morePart = pendingEvents.length > 1 ? `（共 ${pendingEvents.length} 条待确认）` : '';
    detailLine = `> 收到 \`${roleCn}\` 发出的「${typeCn}」信号${taskPart}${msgPart}${morePart}，请总控及时核查并确认。`;
  } else if (hasAudit) {
    const auditTimer = st.activeStageTimer?.elapsedCn ? `，当前已耗时 ${st.activeStageTimer.elapsedCn}` : '';
    detailLine = `> 独立审计专员正在隔离核验 \`${st.activeCrossAgent.taskId}\`（代码仓保持只读未改动${auditTimer}），完成后自动回传总控，无需你操作。`;
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

  return `${headerLine}\n>\n${detailLine}`;
}

function resolveActiveStageTimer(pipeline, state) {
  const nowMs = Date.now();
  if (state.activeCrossAgent?.taskId) {
    const stg = normalizeStageKey(state.activeCrossAgent.taskId);
    const rec = state.stageTimers?.[stg];
    const startMs = rec?.reviewStartedAtMs || rec?.startedAtMs || Date.parse(state.activeCrossAgent.startedAt);
    if (startMs && !Number.isNaN(startMs)) {
      const sec = Math.max(0, Math.round((nowMs - startMs) / 1000));
      return { stage: stg, phase: 'review', elapsedSec: sec, elapsedCn: formatDurationCn(sec), status: 'reviewing' };
    }
  }
  const activeStage = pipeline?.stages?.find((s) => s.status === 'active' || s.status === 'blocked');
  const candidateKey = activeStage?.stage || Object.keys(state.stageTimers || {}).slice(-1)[0];
  if (candidateKey && state.stageTimers?.[candidateKey]) {
    const rec = state.stageTimers[candidateKey];
    let sec = rec.elapsedSec ?? 0;
    if (rec.startedAtMs && !rec.finishedAtMs) {
      sec = Math.max(0, Math.round((nowMs - rec.startedAtMs) / 1000));
    }
    return { stage: candidateKey, phase: rec.status || 'active', elapsedSec: sec, elapsedCn: formatDurationCn(sec), status: rec.status || 'active' };
  }
  return null;
}

function collectStatus(ctx) {
  const { config, winProjectRoot, devDir, statePath, logPath, eventsPath } = ctx;
  const state = loadOrCreateState(statePath);
  const idleThreshold = config.thresholds?.idleThresholdSec ?? 180;
  const maxNoProgress = config.thresholds?.maxNoProgressPushes ?? 3;
  const maxFixRounds = config.thresholds?.maxFixRounds ?? 2;

  const roles = resolveRoleThreads(config, state, idleThreshold, maxNoProgress);

  const boardPath = path.join(devDir, 'DISPATCH_BOARD.md');
  const abCardPath = path.join(devDir, 'tasks', 'AB-codex.md');
  const boardMtimeSec = safeStatMtimeSec(boardPath);
  const abCardMtimeSec = safeStatMtimeSec(abCardPath);

  const boardDoc = parseBoardDocument(boardPath);
  const boardLastLogs = boardDoc.logRows.slice(-5).map((r) => r.raw);
  const boardTaskRows = boardDoc.taskRows.map((r) => r.raw);

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

  const allEvents = readEvents(eventsPath);
  const pendingEvents = allEvents.filter((e) => !e.acked);
  const recentEvents = allEvents.slice(-10);

  const pipeline = parsePipelineSummary(boardDoc.taskRows, state, state.activeCrossAgent, boardDoc.waveColIdx);
  const waves = parseWaveSummary(boardDoc.taskRows, config, state, state.activeCrossAgent, boardDoc.waveColIdx);
  const contextBudgets = inspectContextBudgets(ctx);
  const activeStageTimer = resolveActiveStageTimer(pipeline, state);
  const processAudit = ctx._checkProcs ? collectProcessSnapshot(config, ctx._procFlags || {}) : undefined;

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
    waves,
    pendingEvents,
    recentEvents,
    stageTimers: state.stageTimers || {},
    activeStageTimer,
    contextBudgets,
    ...(processAudit !== undefined ? { processAudit } : {}),
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
  if (flags['check-procs']) {
    ctx._checkProcs = true;
    ctx._procFlags = flags;
  }
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
  if (st.processAudit) {
    console.log('--- process audit (ppid lineage) ---');
    console.log(`PROCS: ok=${st.processAudit.ok} codexHosts=${st.processAudit.codexHostCount ?? 0} attached=${st.processAudit.attachedWorkers?.length ?? 0} orphan=${st.processAudit.orphanWorkers?.length ?? 0}`);
    if (st.processAudit.hasOrphanWorkers && !st.processAudit.hasActiveCodexWorker) {
      console.log(`ORPHAN_WORKERS_WARNING: ${st.processAudit.warning}`);
    }
  }
  if (st.waves?.hasWaves) {
    console.log('--- waves ---');
    console.log(`WAVES: current=${st.waves.currentWave ?? '-'} parallelReady=${JSON.stringify(st.waves.parallelReady)} summary=${st.waves.summary}`);
  }
  if (st.activeStageTimer) {
    console.log(`STAGE_TIMER: stage=${st.activeStageTimer.stage} phase=${st.activeStageTimer.phase} elapsed=${st.activeStageTimer.elapsedCn}`);
  }
  if (st.pendingEvents.length > 0) {
    console.log('--- pending events ---');
    for (const ev of st.pendingEvents) {
      console.log(`${ev.id} [${ev.createdAt}] role=${ev.role} type=${ev.type} task=${ev.task || '-'} msg=${ev.message || ''}`);
    }
  }
  if (st.contextBudgets?.overBudgetCount > 0) {
    console.log('--- context budget warnings ---');
    for (const f of st.contextBudgets.overBudgetFiles) {
      console.log(`OVER_BUDGET ${f.file}: ${f.lines}/${f.maxLines} lines (+${f.excessLines})`);
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
      console.log(`${titleLine}\n>\n> ${activity}`);
      return;
    }
    const roleLabel = formatRoleLabelCn(flags.role || 'ab');
    const dur = formatDurationCn(flags.idle ?? 0);
    const dirtyNum = Number(flags.dirty ?? 0);
    const dirtyTxt = !Number.isNaN(dirtyNum) && dirtyNum === 0 ? '工作区干净' : `当前工作区改动 ${flags.dirty ?? 0} 个文件`;
    console.log([
      `> ● **研发推进中** · \`${ts}\` · ${progPart}`,
      '>',
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
      '>',
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
      '>',
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
      '>',
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
      '>',
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
    const startedAt = formatIsoOffset();
    state.activeCrossAgent = {
      taskId: flags.task,
      role: flags.role || 'R0',
      subagentId: flags.subagent,
      outputPath: flags.output,
      handoffKey: flags.handoff || null,
      startedAt,
    };
    touchStageTimer(state, flags.task, 'start-review');
    saveState(ctx.statePath, state);
    appendRelayLog(ctx.logPath, `CROSS-AGENT DISPATCHED task=${flags.task} role=${flags.role || 'R0'} subagent=${flags.subagent} expected=${flags.output}`);
    console.log(JSON.stringify({
      ok: true,
      activeCrossAgent: state.activeCrossAgent,
      stageTimer: state.stageTimers[normalizeStageKey(flags.task)] || null,
    }, null, 2));
    return;
  }

  if (action === 'finish-review') {
    if (!flags.task || !flags.verdict) {
      throw new Error('finish-review requires --task and --verdict');
    }
    const stageKey = normalizeStageKey(flags.task);
    const maxFixRounds = ctx.config.thresholds?.maxFixRounds ?? 2;
    const fallbackReviewStartMs = state.activeCrossAgent?.startedAt
      ? Date.parse(state.activeCrossAgent.startedAt)
      : null;
    const timer = touchStageTimer(state, flags.task, 'finish-review', {
      verdict: flags.verdict,
      fallbackReviewStartMs: fallbackReviewStartMs && !Number.isNaN(fallbackReviewStartMs) ? fallbackReviewStartMs : null,
    });
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
    const reviewDurationSec = timer?.lastReviewDurationSec ?? null;
    const stageElapsedSec = timer?.elapsedSec ?? null;
    appendRelayLog(ctx.logPath, `CROSS-AGENT DONE task=${flags.task} stage=${stageKey} verdict=${flags.verdict} fix_count=${fixCount}/${maxFixRounds} review_sec=${reviewDurationSec ?? '-'} sha256=${flags.sha256 || '-'} report=${flags.report || '-'}`);
    console.log(JSON.stringify({
      ok: true,
      stageKey,
      verdict: flags.verdict,
      fixCount,
      maxFixRounds,
      fixCapBreaker: fixCapTriggered,
      reviewDurationSec,
      stageElapsedSec,
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

function cmdEvent(flags, action) {
  const ctx = loadConfigAndPaths(flags);
  const sub = String(action || 'list').trim().toLowerCase();

  if (sub === 'emit') {
    if (!flags.role) throw new Error('event emit requires --role <role>');
    const role = normalizeRoleName(flags.role, 'event emit --role');
    const type = String(flags.type || '').trim().toLowerCase();
    if (!VALID_EVENT_TYPES.has(type)) {
      throw new Error(`Invalid --type "${flags.type || ''}". Expected: ${Array.from(VALID_EVENT_TYPES).join(', ')}`);
    }
    const sha = flags.sha ? String(flags.sha).trim() : null;
    const task = flags.task ? String(flags.task).trim() : null;
    const message = flags.message ? String(flags.message).trim() : '';
    const ev = {
      id: `ev-${Date.now()}-${randomBytes(2).toString('hex')}`,
      createdAt: formatIsoOffset(),
      role,
      type,
      task,
      sha,
      message,
      acked: false,
      ackedAt: null,
    };
    fs.mkdirSync(path.dirname(ctx.eventsPath), { recursive: true });
    fs.appendFileSync(ctx.eventsPath, JSON.stringify(ev) + '\n', 'utf8');

    if (task) {
      const state = loadOrCreateState(ctx.statePath);
      touchStageTimer(state, task, 'event', { eventType: type });
      saveState(ctx.statePath, state);
    }

    const allEvents = readEvents(ctx.eventsPath);
    const pendingCount = allEvents.filter((e) => !e.acked).length;
    appendRelayLog(ctx.logPath, `EVENT_EMIT id=${ev.id} role=${role.toUpperCase()} type=${type} task=${task || '-'}`);
    console.log(JSON.stringify({ ok: true, event: ev, pendingCount }, null, 2));
    return;
  }

  if (sub === 'list') {
    const allEvents = readEvents(ctx.eventsPath);
    const showAll = Boolean(flags.all);
    const limit = flags.limit ? Math.max(1, parseInt(String(flags.limit), 10) || 20) : null;
    let items = showAll ? allEvents : allEvents.filter((e) => !e.acked);
    if (limit) items = items.slice(-limit);
    const pendingCount = allEvents.filter((e) => !e.acked).length;

    if (flags.json) {
      console.log(JSON.stringify({
        ok: true,
        totalCount: allEvents.length,
        pendingCount,
        shownCount: items.length,
        events: items,
      }, null, 2));
      return;
    }
    console.log(`=== Relay Events (${showAll ? 'all' : 'pending'}: ${items.length}/${allEvents.length}, pending=${pendingCount}) ===`);
    for (const ev of items) {
      console.log(`${ev.id} [${ev.acked ? 'ACKED' : 'PENDING'}] ${ev.createdAt} role=${ev.role} type=${ev.type} task=${ev.task || '-'} msg=${ev.message || ''}`);
    }
    return;
  }

  if (sub === 'ack') {
    const all = Boolean(flags.all);
    const targetId = flags.id ? String(flags.id).trim() : null;
    const targetTask = flags.task ? String(flags.task).trim() : null;
    const targetRole = flags.role ? normalizeRoleName(flags.role, 'event ack --role') : null;
    if (!all && !targetId && !targetTask && !targetRole) {
      throw new Error('event ack requires one of: --all, --id <eventId>, --task <id>, or --role <role>');
    }
    const events = readEvents(ctx.eventsPath);
    const nowIso = formatIsoOffset();
    let ackedCount = 0;
    for (const ev of events) {
      if (ev.acked) continue;
      const matches = all ||
        (targetId && ev.id === targetId) ||
        (targetTask && (ev.task === targetTask || normalizeStageKey(ev.task) === normalizeStageKey(targetTask))) ||
        (targetRole && ev.role === targetRole);
      if (matches) {
        ev.acked = true;
        ev.ackedAt = nowIso;
        ackedCount++;
      }
    }
    writeEventsAtomic(ctx.eventsPath, events);
    const remainingPending = events.filter((e) => !e.acked).length;
    appendRelayLog(ctx.logPath, `EVENT_ACK acked=${ackedCount} remaining=${remainingPending}`);
    console.log(JSON.stringify({ ok: true, ackedCount, remainingPending }, null, 2));
    return;
  }

  if (sub === 'clear') {
    const clearAll = Boolean(flags.all);
    const events = readEvents(ctx.eventsPath);
    const kept = clearAll ? [] : events.filter((e) => !e.acked);
    const removedCount = events.length - kept.length;
    writeEventsAtomic(ctx.eventsPath, kept);
    appendRelayLog(ctx.logPath, `EVENT_CLEAR mode=${clearAll ? 'all' : 'acked'} removed=${removedCount} remaining=${kept.length}`);
    console.log(JSON.stringify({ ok: true, removedCount, remainingCount: kept.length }, null, 2));
    return;
  }

  throw new Error(`Unknown event action "${sub}". Expected: emit, list, ack, or clear.`);
}

function resolveDocLinkTarget(ctx, sourceFile, rawTarget) {
  let clean = String(rawTarget || '').trim();
  if (!clean || /^(?:https?:|mailto:|file:|#|<)/i.test(clean)) return { skipped: true };
  clean = clean.split('#')[0].split('?')[0].trim();
  if (!clean) return { skipped: true };
  const fromSource = path.resolve(path.dirname(sourceFile), clean);
  if (fs.existsSync(fromSource)) return { skipped: false, exists: true, resolved: fromSource };
  const fromDev = path.resolve(ctx.devDir, clean);
  if (fs.existsSync(fromDev)) return { skipped: false, exists: true, resolved: fromDev };
  const fromRoot = path.resolve(ctx.winProjectRoot, clean);
  if (fs.existsSync(fromRoot)) return { skipped: false, exists: true, resolved: fromRoot };
  return { skipped: false, exists: false, rawTarget: clean, resolved: fromSource };
}

function collectMarkdownLinks(text) {
  const results = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  const lines = String(text || '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    let m;
    while ((m = re.exec(lines[i])) !== null) {
      results.push({ lineNum: i + 1, label: m[1], target: m[2].trim() });
    }
  }
  return results;
}

function pickLatestSpecFile(specsDir) {
  if (!fs.existsSync(specsDir)) return null;
  const files = fs.readdirSync(specsDir)
    .filter((f) => f.endsWith('.md'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (files.length === 0) return null;
  const specNamed = files.filter((f) => /SPEC/i.test(f));
  const chosen = specNamed.length > 0 ? specNamed[specNamed.length - 1] : files[files.length - 1];
  return path.join(specsDir, chosen);
}

function runAnalyze(ctx) {
  const errors = [];
  const warnings = [];
  const addError = (code, file, line, message) => errors.push({ code, file, line: line || null, message });
  const addWarning = (code, file, line, message) => warnings.push({ code, file, line: line || null, message });

  const specsDir = path.join(ctx.devDir, 'specs');
  const latestSpecPath = pickLatestSpecFile(specsDir);
  let specSummary = {
    found: false,
    file: null,
    approved: false,
    draft: false,
    verificationIds: [],
    undecidedPds: [],
  };

  const boardPath = path.join(ctx.devDir, 'DISPATCH_BOARD.md');
  const boardDoc = parseBoardDocument(boardPath);
  const statePath = path.join(ctx.devDir, 'STATE.md');

  const boardHasActiveTasks = boardDoc.taskRows.some((r) => {
    const rawId = (r.cells[0] || '').replace(/`/g, '').trim();
    const txt = r.cells.slice(1).join(' | ');
    return rawId !== 'T-00' && /(?:实施中|已接棒|返修中|进行中|审核中|复审中)/.test(txt);
  });

  if (!latestSpecPath) {
    addWarning('SPEC_MISSING', 'specs/', null, '未检测到 Spec 方案文件，请先完成立项规范文档后再开工。');
  } else {
    const specRel = path.relative(ctx.devDir, latestSpecPath).replace(/\\/g, '/');
    const specText = fs.readFileSync(latestSpecPath, 'utf8');
    const specLines = specText.split(/\r?\n/);
    const vIds = Array.from(new Set(specText.match(/\bV-\d+\b/g) || []));
    const isApproved = /\[已批准方案/.test(specText);
    const isDraft = /\[讨论草案|\[设计预审/.test(specText) && !isApproved;

    const undecidedPds = [];
    for (let i = 0; i < specLines.length; i++) {
      const ln = specLines[i];
      const pdMatches = ln.match(/\bPD-(?:CR-)?\d+\b/g);
      if (!pdMatches) continue;
      if (/(?:待确认|待拍板|待用户拍板|TBD|待定)/.test(ln)) {
        for (const pd of pdMatches) {
          undecidedPds.push({ id: pd, line: i + 1 });
        }
      }
    }

    specSummary = {
      found: true,
      file: specRel,
      approved: isApproved,
      draft: isDraft,
      verificationIds: vIds,
      undecidedPds,
    };

    if (vIds.length === 0) {
      addError('SPEC_NO_VERIFICATION_MATRIX', specRel, null, `最新方案 ${specRel} 缺少可量化的 V-xx 验收矩阵条目。`);
    }
    if (undecidedPds.length > 0) {
      const pdList = undecidedPds.map((p) => p.id).join(', ');
      if (isDraft && !boardHasActiveTasks) {
        addWarning('SPEC_DRAFT_UNDECIDED_PD', specRel, undecidedPds[0].line, `方案草案仍含未拍板项：${pdList}（批准开工前须全部拍板）。`);
      } else {
        addError('SPEC_UNDECIDED_PD', specRel, undecidedPds[0].line, `方案存在未拍板决策项：${pdList}，禁止带着未决 PD 开工。`);
      }
    }
    if (isDraft && boardHasActiveTasks) {
      addError('SPEC_DRAFT_WHILE_ACTIVE', specRel, null, `看板已存在实施中任务，但最新方案 ${specRel} 仍标记为草案/待拍板标签。`);
    }
  }

  let boardSummary = {
    exists: boardDoc.exists,
    taskCount: boardDoc.taskRows.length,
    duplicateTaskIds: [],
    missingTagRows: [],
    brokenLinks: [],
  };

  if (!boardDoc.exists) {
    addError('BOARD_MISSING', 'DISPATCH_BOARD.md', null, '缺少核心调度看板 DISPATCH_BOARD.md。');
  } else {
    const seenIds = new Map();
    for (const row of boardDoc.taskRows) {
      const rawId = (row.cells[0] || '').replace(/`/g, '').trim();
      if (!rawId || /^<.*>$/.test(rawId) || /^---+$/.test(rawId)) continue;
      const normId = rawId.toUpperCase();
      if (seenIds.has(normId)) {
        boardSummary.duplicateTaskIds.push(rawId);
        addError('BOARD_DUPLICATE_TASK_ID', 'DISPATCH_BOARD.md', row.lineNum, `看板存在重复任务编号 "${rawId}"（首次出现于第 ${seenIds.get(normId)} 行）。`);
      } else {
        seenIds.set(normId, row.lineNum);
      }

      if (/^T-\d+(?:\.\d+)?(?:[-_](?:R0|FIX\d+|C))?$/i.test(rawId)) {
        const titleCell = row.cells[boardDoc.titleColIdx] || row.cells[1] || '';
        const escaped = rawId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const tagRe = new RegExp(`\\[\\s*\`?${escaped}\`?\\s*\\]`, 'i');
        if (!tagRe.test(titleCell)) {
          boardSummary.missingTagRows.push({ taskId: rawId, line: row.lineNum });
          addError('BOARD_MISSING_TASK_TAG', 'DISPATCH_BOARD.md', row.lineNum, `任务 "${rawId}" 标题列末尾缺少标准化标记 "[${rawId}]"。`);
        }
      }

      const evidenceCell = row.cells[row.cells.length - 1] || '';
      for (const m of evidenceCell.matchAll(/`([^`\r\n]+)`/g)) {
        const token = m[1].trim();
        if (!token || token === '—' || token === '-' || /^<.*>$/.test(token)) continue;
        if (token.includes('/') || /\.(?:md|json|txt|html)$/i.test(token)) {
          const chk = resolveDocLinkTarget(ctx, boardPath, token);
          if (!chk.skipped && !chk.exists) {
            boardSummary.brokenLinks.push({ file: 'DISPATCH_BOARD.md', line: row.lineNum, target: token });
            addError('BOARD_BROKEN_LINK', 'DISPATCH_BOARD.md', row.lineNum, `看板证据/报告引用断链：\`${token}\` 不存在。`);
          }
        }
      }
    }

    for (const row of boardDoc.logRows) {
      for (const m of row.raw.matchAll(/归档文件：\s*`([^`\r\n]+)`/g)) {
        const target = m[1].trim();
        const chk = resolveDocLinkTarget(ctx, boardPath, target);
        if (!chk.skipped && !chk.exists) {
          boardSummary.brokenLinks.push({ file: 'DISPATCH_BOARD.md', line: row.lineNum, target });
          addError('BOARD_BROKEN_LINK', 'DISPATCH_BOARD.md', row.lineNum, `看板归档索引断链：\`${target}\` 不存在。`);
        }
      }
    }

    const mdLinkFiles = [{ rel: 'DISPATCH_BOARD.md', full: boardPath }];
    if (fs.existsSync(statePath)) mdLinkFiles.push({ rel: 'STATE.md', full: statePath });
    for (const f of mdLinkFiles) {
      const content = fs.readFileSync(f.full, 'utf8');
      for (const lk of collectMarkdownLinks(content)) {
        const chk = resolveDocLinkTarget(ctx, f.full, lk.target);
        if (!chk.skipped && !chk.exists) {
          boardSummary.brokenLinks.push({ file: f.rel, line: lk.lineNum, target: lk.target });
          addError('BOARD_BROKEN_LINK', f.rel, lk.lineNum, `${f.rel} 第 ${lk.lineNum} 行链接目标不存在：${lk.target}`);
        }
      }
    }
  }

  const contextBudgets = inspectContextBudgets(ctx);
  for (const f of contextBudgets.overBudgetFiles) {
    addWarning('CONTEXT_BUDGET_EXCEEDED', f.file, null, `${f.file} 当前 ${f.lines} 行，超出上下文预算 ${f.maxLines} 行（+${f.excessLines} 行），建议执行 compact 或精简历史区。`);
  }

  const state = loadOrCreateState(ctx.statePath);
  const idleThreshold = ctx.config.thresholds?.idleThresholdSec ?? 180;
  const maxNoProgress = ctx.config.thresholds?.maxNoProgressPushes ?? 3;
  const maxFixRounds = ctx.config.thresholds?.maxFixRounds ?? 2;
  const roles = resolveRoleThreads(ctx.config, state, idleThreshold, maxNoProgress);
  const noProgressRoles = Object.entries(roles).filter(([, r]) => r.noProgressBreaker).map(([n]) => n);
  const fixCapStages = Object.entries(state.stageFixes || {}).filter(([, c]) => c >= maxFixRounds).map(([s]) => s);
  if (noProgressRoles.length > 0 || fixCapStages.length > 0) {
    addError(
      'CIRCUIT_BREAKER_ACTIVE',
      '.agents/relay/relay-state.json',
      null,
      `存在未解除的熔断保护（无进展角色：${noProgressRoles.join(',') || '无'}；返修上限阶段：${fixCapStages.join(',') || '无'}）。`,
    );
  }

  const pendingEvents = readEvents(ctx.eventsPath).filter((e) => !e.acked);
  if (pendingEvents.length > 0) {
    addWarning('PENDING_EVENTS', '.agents/relay/events.jsonl', null, `存在 ${pendingEvents.length} 条未确认事件信号，请及时查看并 ack。`);
  }

  if (ctx.config.runtime === 'wsl') {
    const wslPaths = [
      { label: 'projectPath', val: ctx.config.projectPath },
      ...Object.entries(ctx.config.worktrees?.roleWorktrees || {}).map(([k, v]) => ({ label: `worktrees.roleWorktrees.${k}`, val: v })),
      ...Object.entries(ctx.config.roleWorktrees || {}).map(([k, v]) => ({ label: `roleWorktrees.${k}`, val: v })),
    ];
    for (const item of wslPaths) {
      const p = String(item.val || '').trim();
      if (/^\/mnt\/[a-z](?:\/|$)/i.test(p)) {
        addWarning(
          'WSL_DRVFS_IO_RISK',
          '.agents/relay.json',
          null,
          `WSL 配置字段 ${item.label}（${p}）位于跨盘 /mnt/<drive>/ 挂载下；Rust target/、node_modules、SQLite 与高频测试 I/O 易拖死 9P/DrvFS 通道，建议将代码与构建缓存迁移至 WSL Linux ext4 分区（如 /home/...）。`,
        );
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedAt: formatIsoOffset(),
    projectName: ctx.config.projectName,
    batchId: ctx.config.batchId,
    errorCount: errors.length,
    warningCount: warnings.length,
    errors,
    warnings,
    spec: specSummary,
    board: boardSummary,
    contextBudgets,
    pendingEventCount: pendingEvents.length,
    breakers: { noProgressRoles, fixCapStages },
  };
}

function cmdAnalyze(flags) {
  const ctx = loadConfigAndPaths(flags);
  const res = runAnalyze(ctx);
  if (!res.ok) process.exitCode = 1;
  if (flags.json) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(`=== 防漂移体检 (${res.projectName} / ${res.batchId}) -> ${res.ok ? '通过' : '发现阻断错误'} ===`);
  console.log(`错误: ${res.errorCount} 条 ｜ 提示: ${res.warningCount} 条 ｜ 未确认事件: ${res.pendingEventCount} 条`);
  for (const e of res.errors) {
    console.log(`[错误/${e.code}] ${e.file}${e.line ? `:${e.line}` : ''} - ${e.message}`);
  }
  for (const w of res.warnings) {
    console.log(`[提醒/${w.code}] ${w.file}${w.line ? `:${w.line}` : ''} - ${w.message}`);
  }
}

function formatCompactStamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function cmdCompact(flags) {
  const ctx = loadConfigAndPaths(flags);
  const apply = Boolean(flags.apply);
  const keepLogs = Math.max(1, parseInt(String(flags['keep-logs'] || '15'), 10) || 15);
  const boardPath = path.join(ctx.devDir, 'DISPATCH_BOARD.md');
  const budgetsCheck = inspectContextBudgets(ctx);
  const boardDoc = parseBoardDocument(boardPath);

  const isArchiveIndexRow = (r) => {
    const idCell = (r.cells[1] || '').replace(/`/g, '').trim();
    return idCell === 'ARCHIVE' || /历史调度日志已归档/.test(r.raw);
  };
  const existingArchiveRows = boardDoc.logRows.filter(isArchiveIndexRow);
  const regularLogRows = boardDoc.logRows.filter((r) => !isArchiveIndexRow(r));
  const archivableCount = Math.max(0, regularLogRows.length - keepLogs);
  const linesBefore = boardDoc.exists ? boardDoc.lines.length : 0;

  let linesAfter = linesBefore;
  let archivedCount = 0;
  let archiveFile = null;
  let archiveRelPath = null;

  if (apply && boardDoc.exists && archivableCount > 0 && boardDoc.logStartIdx >= 0 && boardDoc.logEndIdx >= boardDoc.logStartIdx) {
    const toArchive = regularLogRows.slice(0, archivableCount);
    const toKeep = regularLogRows.slice(archivableCount);

    const archiveDir = path.join(ctx.devDir, 'archive');
    fs.mkdirSync(archiveDir, { recursive: true });
    const baseStamp = formatCompactStamp();
    let fileName = `DISPATCH_BOARD_LOG_${baseStamp}.md`;
    let seq = 1;
    while (fs.existsSync(path.join(archiveDir, fileName))) {
      fileName = `DISPATCH_BOARD_LOG_${baseStamp}_${seq++}.md`;
    }
    archiveFile = path.join(archiveDir, fileName);
    archiveRelPath = `archive/${fileName}`;

    const nowIso = formatIsoOffset();
    const archiveDoc = [
      `# ${ctx.config.projectName} 调度日志历史归档`,
      '',
      `- **批次**：\`${ctx.config.batchId}\``,
      `- **归档时间**：\`${nowIso}\``,
      `- **归档条数**：${toArchive.length} 条`,
      `- **来源**：\`DISPATCH_BOARD.md\``,
      '',
      boardDoc.logHeaderLine,
      boardDoc.logSepLine,
      ...toArchive.map((r) => r.raw),
      '',
    ].join('\n');
    fs.writeFileSync(archiveFile, archiveDoc, 'utf8');

    const indexRow = `| \`${nowIso}\` | \`ARCHIVE\` | 历史调度日志已归档（${toArchive.length} 条） | \`relay compact\` | \`—\` | 归档文件：\`${archiveRelPath}\` |`;
    const newLogBlock = [
      ...existingArchiveRows.map((r) => r.raw),
      indexRow,
      ...toKeep.map((r) => r.raw),
    ];
    const updatedLines = [
      ...boardDoc.lines.slice(0, boardDoc.logStartIdx),
      ...newLogBlock,
      ...boardDoc.lines.slice(boardDoc.logEndIdx + 1),
    ];
    fs.writeFileSync(boardPath, updatedLines.join('\n').replace(/\r\n/g, '\n'), 'utf8');
    linesAfter = updatedLines.length;
    archivedCount = toArchive.length;
    appendRelayLog(ctx.logPath, `COMPACT_BOARD archived=${archivedCount} kept=${toKeep.length} archive=${archiveRelPath}`);
  }

  const afterBudgets = apply ? inspectContextBudgets(ctx) : budgetsCheck;
  const suggestions = [];
  for (const f of afterBudgets.overBudgetFiles) {
    if (f.kind === 'board' && archivableCount > 0 && !apply) {
      suggestions.push(`DISPATCH_BOARD.md 超出预算（${f.lines}/${f.maxLines} 行），可执行 compact --apply 归档 ${archivableCount} 条历史日志。`);
    } else {
      suggestions.push(`${f.file} 当前 ${f.lines}/${f.maxLines} 行（+${f.excessLines} 行），请由 Codex-Hub 整理折叠已闭环旧节，勿直接删改审计或 Spec 原件。`);
    }
  }

  const result = {
    ok: true,
    mode: apply ? 'apply' : 'dry-run',
    keepLogs,
    budgets: afterBudgets.budgets,
    files: afterBudgets.files,
    overBudgetCount: afterBudgets.overBudgetCount,
    board: {
      exists: boardDoc.exists,
      totalLogRows: regularLogRows.length,
      existingArchiveRows: existingArchiveRows.length,
      archivableLogRows: archivableCount,
      keptLogRows: apply && archivedCount > 0 ? Math.min(regularLogRows.length, keepLogs) : regularLogRows.length,
      archivedCount,
      archiveFile,
      archiveRelPath,
      linesBefore,
      linesAfter,
    },
    suggestions,
  };

  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`=== 上下文预算与日志瘦身 (${result.mode}) ===`);
  for (const f of result.files) {
    console.log(`${f.exceeded ? '[超预算]' : '[正常]'} ${f.file}: ${f.lines}/${f.maxLines} 行`);
  }
  console.log(`看板常规日志: ${result.board.totalLogRows} 条 | 保留上限: ${keepLogs} 条 | ${apply ? `已归档: ${archivedCount} 条` : `可归档: ${archivableCount} 条`}`);
  if (archiveRelPath) console.log(`归档文件: ${archiveRelPath} (看板行数 ${linesBefore} -> ${linesAfter})`);
  for (const s of suggestions) console.log(`建议: ${s}`);
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeJsonForScript(obj) {
  return JSON.stringify(obj)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function collectUiPayload(ctx, live = false) {
  const status = collectStatus(ctx);
  const analysis = runAnalyze(ctx);
  return {
    generatedAt: formatIsoOffset(),
    live,
    status,
    analysis,
  };
}

function renderCockpitHtml(payload, live = false) {
  const st = payload.status;
  const titleText = `${st.projectName || 'SDD'} · 中文协同驾驶舱`;
  const embeddedJson = safeJsonForScript(payload);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(titleText)}</title>
  <style>
    :root {
      --bg: #0f172a;
      --panel: #1e293b;
      --panel-alt: #162032;
      --border: #334155;
      --text: #e2e8f0;
      --muted: #94a3b8;
      --ok: #22c55e;
      --active: #38bdf8;
      --warn: #f59e0b;
      --err: #ef4444;
      --accent: #818cf8;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      line-height: 1.5;
    }
    .wrap { max-width: 1240px; margin: 0 auto; display: flex; flex-direction: column; gap: 16px; }
    .topbar {
      background: linear-gradient(135deg, #1e293b 0%, #172554 100%);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 18px 20px;
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .title { font-size: 20px; font-weight: 700; margin: 0; }
    .meta { color: var(--muted); font-size: 13px; margin-top: 4px; }
    .pill-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .pill {
      display: inline-block;
      padding: 3px 10px;
      border-radius: 999px;
      font-size: 12px;
      border: 1px solid var(--border);
      background: var(--panel-alt);
    }
    .pill.ok { border-color: rgba(34, 197, 94, 0.5); color: #86efac; }
    .pill.active { border-color: rgba(56, 189, 248, 0.5); color: #7dd3fc; }
    .pill.warn { border-color: rgba(245, 158, 11, 0.5); color: #fcd34d; }
    .pill.err { border-color: rgba(239, 68, 68, 0.5); color: #fca5a5; }
    .btn {
      background: #2563eb;
      color: #fff;
      border: none;
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
    }
    .btn:hover { background: #1d4ed8; }
    .telemetry-box {
      background: var(--panel);
      border-left: 4px solid var(--active);
      border-radius: 8px;
      padding: 14px 16px;
      font-size: 14px;
      white-space: pre-wrap;
    }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .card h2 { font-size: 15px; margin: 0; color: #f8fafc; border-bottom: 1px solid var(--border); padding-bottom: 8px; }
    .stage-flow { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .stage-chip {
      padding: 5px 10px;
      border-radius: 8px;
      font-size: 13px;
      background: var(--panel-alt);
      border: 1px solid var(--border);
    }
    .stage-done { border-color: var(--ok); color: #86efac; }
    .stage-active { border-color: var(--active); color: #7dd3fc; font-weight: 600; }
    .stage-blocked { border-color: var(--err); color: #fca5a5; font-weight: 600; }
    .list { display: flex; flex-direction: column; gap: 8px; margin: 0; padding: 0; list-style: none; }
    .item {
      background: var(--panel-alt);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 13px;
    }
    .muted { color: var(--muted); font-size: 12px; }
    .bar-bg { height: 7px; background: #0b1220; border-radius: 999px; overflow: hidden; margin-top: 6px; }
    .bar-fill { height: 100%; background: var(--ok); }
    .bar-fill.warn { background: var(--warn); }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; }
    pre.logbox {
      margin: 0;
      padding: 10px 12px;
      background: #0b1220;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      max-height: 240px;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <header class="topbar">
      <div>
        <h1 class="title" id="hdr-title">${escapeHtml(titleText)}</h1>
        <div class="meta" id="hdr-meta"></div>
      </div>
      <div class="pill-row">
        <span class="pill active" id="hdr-mode"></span>
        <span class="pill" id="hdr-sync">${live ? '实时轮询中（每 5 秒）' : '静态离线快照'}</span>
        ${live ? '<button class="btn" id="btn-refresh" type="button">立即刷新</button>' : ''}
      </div>
    </header>

    <section class="telemetry-box" id="telemetry-box"></section>

    <div class="grid">
      <section class="card">
        <h2>流水线进度与阶段耗时</h2>
        <div class="stage-flow" id="pipeline-flow"></div>
        <ul class="list" id="timer-list"></ul>
      </section>

      <section class="card">
        <h2>波次并行推进（Waves）</h2>
        <div class="muted" id="wave-summary"></div>
        <ul class="list" id="wave-list"></ul>
      </section>

      <section class="card">
        <h2>协同角色与工作树（Worktrees）</h2>
        <ul class="list" id="role-list"></ul>
        <ul class="list" id="worktree-list"></ul>
      </section>

      <section class="card">
        <h2>待处理事件信号（Event Bus）</h2>
        <ul class="list" id="event-list"></ul>
      </section>

      <section class="card">
        <h2>防漂移体检与上下文预算</h2>
        <div id="analyze-summary"></div>
        <ul class="list" id="budget-list"></ul>
      </section>

      <section class="card">
        <h2>最近调度记录与中继日志</h2>
        <pre class="logbox mono" id="log-box"></pre>
      </section>
    </div>
  </div>

  <script>
    window.__INITIAL_DATA__ = ${embeddedJson};
    const IS_LIVE = ${live ? 'true' : 'false'};

    function esc(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    }

    function fmtDur(sec) {
      if (sec == null || Number.isNaN(Number(sec))) return '未知';
      const s = Math.max(0, Math.round(Number(sec)));
      if (s < 60) return s + ' 秒';
      if (s < 3600) {
        const m = Math.floor(s / 60), r = s % 60;
        return r > 0 ? m + ' 分 ' + r + ' 秒' : m + ' 分';
      }
      return Math.floor(s / 3600) + ' 小时 ' + Math.floor((s % 3600) / 60) + ' 分';
    }

    function roleNameCn(r) {
      const k = String(r || '').toLowerCase();
      if (k === 'hub') return '总控中枢';
      if (k === 'ab') return '实施专席 (AB)';
      if (k === 'c') return '真机验证 (C)';
      if (k === 'r0') return '独立审计 (R0)';
      return k.toUpperCase() + ' 线';
    }

    function eventTypeCn(t) {
      const m = { done: '任务完工', blocked: '遇到阻塞', review_ready: '送审就绪', heartbeat: '进度心跳', decision_needed: '等待拍板' };
      return m[String(t || '').toLowerCase()] || String(t || '事件信号');
    }

    function renderAll(data) {
      const st = data.status || {};
      const an = data.analysis || {};
      const modeCn = /semi/i.test(st.automationMode || '') ? '半自动值守' : '全自动托管';

      document.getElementById('hdr-title').textContent = (st.projectName || '项目') + ' · 中文协同驾驶舱';
      document.getElementById('hdr-meta').textContent =
        '批次 ' + (st.batchId || '-') + ' ｜ 分级 ' + (st.tier || '-') +
        ' ｜ 分支 ' + (st.git && st.git.branch ? st.git.branch : '-') +
        ' ｜ 版本快照 ' + (st.git && st.git.headShort ? st.git.headShort : '-') +
        ' ｜ 更新于 ' + (st.checkedAt || data.generatedAt || '-');
      document.getElementById('hdr-mode').textContent = modeCn + ' · ' + (st.runtime || '-');

      const cleanTelemetry = String(st.telemetryLine || '暂无态势')
        .replace(/^>\\s?$/gm, '')
        .replace(/^>\\s?/gm, '')
        .replace(/\\n{2,}/g, '\\n')
        .replace(/\\*\\*/g, '')
        .replace(/\`/g, '')
        .trim();
      document.getElementById('telemetry-box').textContent = cleanTelemetry;

      const stages = (st.pipeline && st.pipeline.stages) || [];
      document.getElementById('pipeline-flow').innerHTML = stages.length
        ? stages.map((s) => {
            const cls = s.status === 'done' ? 'stage-done' : (s.status === 'active' ? 'stage-active' : (s.status === 'blocked' ? 'stage-blocked' : ''));
            const icon = s.status === 'done' ? '✓' : (s.status === 'active' ? '▸' : (s.status === 'blocked' ? '!' : '◌'));
            return '<span class="stage-chip ' + cls + '">' + esc(s.stage) + ' ' + icon + '</span>';
          }).join('')
        : '<span class="muted">暂无流水线阶段记录</span>';

      const timerEntries = Object.values(st.stageTimers || {});
      document.getElementById('timer-list').innerHTML = timerEntries.length
        ? timerEntries.map((t) =>
            '<li class="item"><strong>' + esc(t.stage) + '</strong> · 状态：' + esc(t.status || '-') +
            ' ｜ 累计耗时：' + esc(fmtDur(t.elapsedSec)) +
            (t.lastReviewDurationSec != null ? ' ｜ 最近审计：' + esc(fmtDur(t.lastReviewDurationSec)) : '') +
            '</li>'
          ).join('')
        : '<li class="item muted">尚无阶段计时记录（将在送审或事件上报时自动累计）</li>';

      const waves = st.waves || {};
      const waveItems = waves.items || [];
      document.getElementById('wave-summary').textContent = waves.hasWaves
        ? ('当前波次：' + (waves.currentWave || '-') + (waves.canParallelize ? ' ｜ 可并行开工：' + (waves.parallelReady || []).join(', ') : ''))
        : '暂未在看板中划分 W0/W1 波次';
      document.getElementById('wave-list').innerHTML = waveItems.length
        ? waveItems.map((w) =>
            '<li class="item"><div><strong>' + esc(w.wave) + '</strong> · 完成 ' + w.done + '/' + w.total +
            (w.dependsOn && w.dependsOn.length ? ' ｜ 依赖：' + esc(w.dependsOn.join(', ')) : '') +
            '</div><div class="muted">' + w.tasks.map((t) => esc(t.task) + '(' + esc(t.status) + ')').join(' · ') + '</div></li>'
          ).join('')
        : '<li class="item muted">暂无波次数据</li>';

      const roleEntries = Object.entries(st.roles || {});
      document.getElementById('role-list').innerHTML = roleEntries.map(([r, info]) => {
        const stateCn = info.status === 'WORKING' ? '活跃执行中' : (info.status === 'STOPPED' ? '已静默待命' : '未绑定会话');
        const idleCn = info.idleSeconds != null ? ('（静默 ' + fmtDur(info.idleSeconds) + '）') : '';
        return '<li class="item"><strong>' + esc(roleNameCn(r)) + '</strong> · ' + esc(stateCn) + esc(idleCn) +
          (info.threadName ? '<div class="muted">会话标题：' + esc(info.threadName) + '</div>' : '') + '</li>';
      }).join('');

      const wts = st.worktrees || [];
      document.getElementById('worktree-list').innerHTML = wts.length
        ? wts.map((w) =>
            '<li class="item"><strong>工作树 ' + esc(w.role ? roleNameCn(w.role) : w.id) + '</strong> · ' +
            (w.exists ? ('分支 ' + esc(w.branch || '-') + ' · 版本 ' + esc(w.headShort || '-') + ' · 改动 ' + (w.dirtyCount ?? 0) + ' 个文件') : '目录未创建') +
            '</li>'
          ).join('')
        : '<li class="item muted">当前为单仓库工作区（未发现附加 worktree）</li>';

      const evs = (st.pendingEvents && st.pendingEvents.length ? st.pendingEvents : st.recentEvents) || [];
      document.getElementById('event-list').innerHTML = evs.length
        ? evs.slice().reverse().map((ev) =>
            '<li class="item"><span class="pill ' + (ev.acked ? 'ok' : 'warn') + '">' + (ev.acked ? '已确认' : '待处理') + '</span> ' +
            '<strong>' + esc(roleNameCn(ev.role)) + '</strong> · ' + esc(eventTypeCn(ev.type)) +
            (ev.task ? ' · 任务 ' + esc(ev.task) : '') +
            '<div class="muted">' + esc(ev.message || '无附加说明') + ' ｜ ' + esc(ev.createdAt || '') + '</div></li>'
          ).join('')
        : '<li class="item muted">暂无事件信号记录</li>';

      const errHtml = (an.errors || []).map((e) => '<div class="item"><span class="pill err">错误</span> ' + esc(e.message) + '</div>').join('');
      const warnHtml = (an.warnings || []).map((w) => '<div class="item"><span class="pill warn">提醒</span> ' + esc(w.message) + '</div>').join('');
      document.getElementById('analyze-summary').innerHTML =
        '<div style="margin-bottom:8px;"><span class="pill ' + (an.ok ? 'ok' : 'err') + '">' +
        (an.ok ? '体检通过（零阻断错误）' : '发现 ' + (an.errorCount || 0) + ' 项阻断错误') +
        '</span> <span class="pill">提示 ' + (an.warningCount || 0) + ' 项</span></div>' +
        errHtml + warnHtml;

      const budgetFiles = (st.contextBudgets && st.contextBudgets.files) || [];
      document.getElementById('budget-list').innerHTML = budgetFiles.map((f) => {
        const pct = Math.min(100, Math.round((f.lines / Math.max(1, f.maxLines)) * 100));
        return '<li class="item"><div>' + esc(f.file) + '：' + f.lines + ' / ' + f.maxLines + ' 行' +
          (f.exceeded ? ' <span class="pill warn">超预算</span>' : '') +
          '</div><div class="bar-bg"><div class="bar-fill ' + (f.exceeded ? 'warn' : '') + '" style="width:' + pct + '%"></div></div></li>';
      }).join('');

      const logLines = []
        .concat(['--- 看板最新调度记录 ---'], st.boardLastLogs || ['暂无'])
        .concat(['', '--- 中继运行日志 ---'], st.recentLog || ['暂无']);
      document.getElementById('log-box').textContent = logLines.join('\\n');
    }

    async function fetchStatus() {
      const badge = document.getElementById('hdr-sync');
      try {
        const res = await fetch('/api/status', { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        renderAll(data);
        if (badge) badge.textContent = '实时同步于 ' + new Date().toLocaleTimeString();
      } catch (err) {
        if (badge) badge.textContent = '轮询连接断开（将自动重试）';
      }
    }

    renderAll(window.__INITIAL_DATA__);
    if (IS_LIVE) {
      const btn = document.getElementById('btn-refresh');
      if (btn) btn.addEventListener('click', fetchStatus);
      setInterval(fetchStatus, 5000);
    }
  </script>
</body>
</html>
`;
}

async function cmdUi(flags) {
  const ctx = loadConfigAndPaths(flags);

  if (flags.export) {
    const outPath = path.resolve(String(flags.export));
    const payload = collectUiPayload(ctx, false);
    const html = renderCockpitHtml(payload, false);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, html, 'utf8');
    console.log(JSON.stringify({
      ok: true,
      mode: 'export',
      outputPath: outPath,
      bytes: Buffer.byteLength(html, 'utf8'),
      projectName: ctx.config.projectName,
      batchId: ctx.config.batchId,
    }, null, 2));
    return;
  }

  const host = String(flags.host || '127.0.0.1').trim();
  const port = parseInt(String(flags.port || '4317'), 10);
  const listenPort = Number.isInteger(port) && port >= 0 ? port : 4317;

  const server = http.createServer((req, res) => {
    const reqPath = (req.url || '/').split('?')[0];
    if (reqPath === '/api/status') {
      try {
        const payload = collectUiPayload(ctx, true);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(JSON.stringify(payload));
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: err?.message || String(err) }));
      }
      return;
    }

    if (reqPath === '/' || reqPath === '/index.html') {
      try {
        const payload = collectUiPayload(ctx, true);
        const html = renderCockpitHtml(payload, true);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(html);
      } catch (err) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(err?.message || String(err));
      }
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
  });

  await new Promise((resolve, reject) => {
    const onSig = () => {
      server.close(() => resolve());
    };
    process.once('SIGINT', onSig);
    process.once('SIGTERM', onSig);
    server.on('error', reject);
    server.listen(listenPort, host, () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : listenPort;
      console.log(JSON.stringify({
        ok: true,
        mode: 'serve',
        host,
        port: actualPort,
        url: `http://${host}:${actualPort}/`,
        projectName: ctx.config.projectName,
        batchId: ctx.config.batchId,
      }, null, 2));
    });
  });
}

const DEFAULT_WORKER_PROC_RE = /\b(?:cargo|rustc|pytest|jest|vitest|playwright|mocha|tsx|tsc|vite|webpack|esbuild|npm|pnpm|yarn|node|python3?|go\s+test|dotnet|gradle|mvn|capture-worker)\b/i;
const CODEX_HOST_RE = /(?:^|[\\/])codex(?:\.exe)?(?:\s|$)/i;
const SYSTEM_ANCESTOR_RE = /^(?:init|systemd|sessionleader|relay|sshd|login|wsl|code-server|explorer\.exe|services\.exe|svchost\.exe|wininit\.exe|smss\.exe)$/i;

function parsePsTable(rawText) {
  const rows = [];
  for (const line of String(rawText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = trimmed.match(/^(\d+)\s+(\d+)\s+(\S+)(?:\s+(.*))?$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    const comm = m[3];
    const args = (m[4] || comm).trim();
    if (/(?:relay\.mjs|ps\s+-eo\s+pid=)/.test(args)) continue;
    rows.push({ pid, ppid, comm, args });
  }
  return rows;
}

function classifyProcessTree(procRows, filterRegexStr = '') {
  const byPid = new Map(procRows.map((r) => [r.pid, r]));
  const workerRe = filterRegexStr ? new RegExp(filterRegexStr, 'i') : DEFAULT_WORKER_PROC_RE;

  const codexHosts = procRows.filter((r) => CODEX_HOST_RE.test(`${r.comm} ${r.args}`));
  const codexPidSet = new Set(codexHosts.map((r) => r.pid));

  const attachedWorkers = [];
  const orphanWorkers = [];
  const detachedWorkers = [];

  for (const row of procRows) {
    if (codexPidSet.has(row.pid)) continue;
    const fullText = `${row.comm} ${row.args}`;
    if (!workerRe.test(fullText)) continue;

    const visited = new Set([row.pid]);
    const ancestorChain = [];
    let cur = row;
    let codexAncestorPid = null;
    let rootAnchor = row;
    let exitedToSystemOrMissing = false;

    for (let step = 0; step < 64; step++) {
      if (cur.ppid <= 1) {
        exitedToSystemOrMissing = true;
        break;
      }
      const parent = byPid.get(cur.ppid);
      if (!parent) {
        exitedToSystemOrMissing = true;
        break;
      }
      if (visited.has(parent.pid)) break;
      visited.add(parent.pid);
      ancestorChain.push(parent.pid);

      if (codexPidSet.has(parent.pid)) {
        codexAncestorPid = parent.pid;
        break;
      }
      if (SYSTEM_ANCESTOR_RE.test(parent.comm)) {
        rootAnchor = cur;
        break;
      }
      rootAnchor = parent;
      cur = parent;
    }

    const baseItem = {
      pid: row.pid,
      ppid: row.ppid,
      comm: row.comm,
      args: row.args.slice(0, 200),
      ancestorChain,
    };

    if (codexAncestorPid !== null) {
      attachedWorkers.push({
        ...baseItem,
        attachedToCodex: true,
        codexAncestorPid,
        lineage: [row.pid, ...ancestorChain],
      });
    } else if (exitedToSystemOrMissing && !SYSTEM_ANCESTOR_RE.test(rootAnchor.comm)) {
      orphanWorkers.push({
        ...baseItem,
        isOrphan: true,
        orphanRootPid: rootAnchor.pid,
        orphanReason: row.ppid <= 1 || !byPid.has(row.ppid)
          ? `父进程 (${row.ppid}) 已退出或挂至 PID 1`
          : `根工作进程 ${rootAnchor.comm} (PID ${rootAnchor.pid}) 的父进程已退出或挂至 PID 1`,
      });
    } else {
      detachedWorkers.push(baseItem);
    }
  }

  const hasActiveCodexWorker = attachedWorkers.length > 0;
  const hasOrphanWorkers = orphanWorkers.length > 0;
  const warning = hasOrphanWorkers && !hasActiveCodexWorker
    ? `检测到 ${orphanWorkers.length} 个孤儿构建/测试进程（父 Codex 会话已退出，祖先链已挂至 PID 1 或断开），不可误判为 AB/C 仍在线；请核对后按防停规则唤醒。`
    : null;

  return {
    codexHostCount: codexHosts.length,
    codexHosts: codexHosts.map((h) => ({ pid: h.pid, ppid: h.ppid, comm: h.comm, args: h.args.slice(0, 160) })),
    attachedWorkers,
    orphanWorkers,
    detachedWorkers,
    hasActiveCodexWorker,
    hasOrphanWorkers,
    warning,
  };
}

function collectProcessSnapshot(config, flags = {}) {
  const runtime = flags.runtime ? normalizeRuntime(flags.runtime) : normalizeRuntime(config?.runtime);
  const distro = flags.distro !== undefined ? flags.distro : (config?.wslDistro || '');
  const filterRegexStr = typeof flags.filter === 'string' ? flags.filter.trim() : '';

  let rawText = '';
  let source = runtime;
  try {
    if (flags.input) {
      const inp = path.resolve(String(flags.input));
      if (!fs.existsSync(inp)) throw new Error(`Process snapshot file not found: ${inp}`);
      rawText = fs.readFileSync(inp, 'utf8');
      source = 'input-file';
    } else if (runtime === 'wsl') {
      const res = runWslBash(distro, 'ps -eo pid=,ppid=,comm=,args= 2>/dev/null', [], undefined, 15000);
      if (res.status !== 0) {
        throw new Error((res.stderr || res.error?.message || `wsl ps exit=${res.status}`).trim());
      }
      rawText = res.stdout || '';
    } else if (runtime === 'posix') {
      const res = spawnSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: 10000 });
      if (res.status !== 0) {
        throw new Error((res.stderr || res.error?.message || `ps exit=${res.status}`).trim());
      }
      rawText = res.stdout || '';
    } else {
      const psScript = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId) $($_.Name) $($_.CommandLine)" }';
      const res = spawnSync('powershell.exe', ['-NoProfile', '-Command', psScript], {
        encoding: 'utf8',
        timeout: 15000,
        windowsHide: true,
      });
      if (res.status !== 0) {
        throw new Error((res.stderr || res.error?.message || `powershell exit=${res.status}`).trim());
      }
      rawText = res.stdout || '';
    }
  } catch (err) {
    return {
      ok: false,
      source,
      runtime,
      error: err?.message || String(err),
      codexHostCount: 0,
      codexHosts: [],
      attachedWorkers: [],
      orphanWorkers: [],
      detachedWorkers: [],
      hasActiveCodexWorker: false,
      hasOrphanWorkers: false,
      warning: null,
    };
  }

  const rows = parsePsTable(rawText);
  const classified = classifyProcessTree(rows, filterRegexStr);
  return {
    ok: true,
    source,
    runtime,
    totalScanned: rows.length,
    ...classified,
  };
}

function cmdProcs(flags) {
  let config = null;
  if (flags.config || flags.project || (!flags.runtime && !flags.input)) {
    try {
      config = loadConfigAndPaths(flags).config;
    } catch {
      config = null;
    }
  }
  const result = collectProcessSnapshot(config, flags);
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`=== 后台工作进程血缘核查 (${result.runtime} / ${result.source}) ===`);
  if (!result.ok) {
    console.log(`采集失败: ${result.error}`);
    return;
  }
  console.log(`存活 Codex 宿主: ${result.codexHostCount} | 挂在 Codex 下: ${result.attachedWorkers.length} | 孤儿进程: ${result.orphanWorkers.length} | 其他独立进程: ${result.detachedWorkers.length}`);
  if (result.warning) console.log(`告警: ${result.warning}`);
  for (const w of result.attachedWorkers) {
    console.log(`[ATTACHED] pid=${w.pid} ppid=${w.ppid} codex=${w.codexAncestorPid} ${w.comm} ${w.args}`);
  }
  for (const w of result.orphanWorkers) {
    console.log(`[ORPHAN] pid=${w.pid} ppid=${w.ppid} reason=${w.orphanReason} ${w.comm} ${w.args}`);
  }
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
    case 'procs':
      cmdProcs(flags);
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
    case 'analyze':
      cmdAnalyze(flags);
      break;
    case 'event':
      cmdEvent(flags, positionals[1]);
      break;
    case 'compact':
      cmdCompact(flags);
      break;
    case 'ui':
      await cmdUi(flags);
      break;
    default:
      throw new Error(`Unknown command: ${cmd}. Use --help for usage.`);
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exitCode = 1;
});
