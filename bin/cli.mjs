#!/usr/bin/env node
/**
 * Zero-dependency cross-platform auto-installer & CLI launcher
 * for sdd-multi-agent-relay (Antigravity Plugin / Skill + Codex relay).
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');
const SKILL_NAME = 'sdd-multi-agent-relay';
const SKILL_SRC = path.join(REPO_ROOT, 'skills', SKILL_NAME);
const PLUGIN_JSON_SRC = path.join(REPO_ROOT, 'plugin.json');
const RELAY_SRC = path.join(SKILL_SRC, 'scripts', 'relay.mjs');

const RELAY_PASSTHROUGH_CMDS = new Set([
  'init', 'threads', 'bind', 'spawn', 'status', 'send', 'state', 'notify',
]);

function printHelp() {
  console.log(`${SKILL_NAME} auto-installer & relay CLI

Usage:
  sdd-multi-agent-relay <command> [options]

Auto-Install & Lifecycle Commands:
  install     Automatically install as an Antigravity Plugin, standalone Skill, or Project Skill
              Options: [--mode plugin|skill|project] [--project <dir>]
                       [--home <dir>] [--with-codex] [--wsl-distro <name>]
                       [--dedupe] [--quiet]

  update      Pull updates (if git-cloned) or re-sync files cleanly from current package
              Options: (same as install)

  uninstall   Remove installed plugin / skill from the target scope
              Options: [--mode plugin|skill|project] [--project <dir>]
                       [--home <dir>] [--with-codex] [--wsl-distro <name>]

  doctor      Inspect local Node.js, Antigravity plugin/skill install, and Codex CLI health
              Options: [--home <dir>] [--wsl-distro <name>]

Relay Supervision Commands (forwarded to relay.mjs):
  init | threads | bind | spawn | status | send | state | notify
  (Run "sdd-multi-agent-relay init --help" or "--help" on any relay command)
`);
}

function parseFlags(argv) {
  const positionals = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      flags.help = true;
    } else if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[k] = next;
        i++;
      } else {
        flags[k] = true;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function resolveTargets(flags) {
  const mode = String(flags.mode || 'plugin').toLowerCase().trim();
  if (!['plugin', 'skill', 'project'].includes(mode)) {
    throw new Error(`Invalid --mode "${mode}". Expected: plugin, skill, or project.`);
  }
  const homeDir = flags.home ? path.resolve(flags.home) : os.homedir();
  const geminiConfigDir = path.join(homeDir, '.gemini', 'config');
  const codexSkillDir = path.join(homeDir, '.codex', 'skills', SKILL_NAME);

  if (mode === 'plugin') {
    const pluginRoot = path.join(geminiConfigDir, 'plugins', SKILL_NAME);
    return {
      mode,
      homeDir,
      geminiConfigDir,
      targetRoot: pluginRoot,
      skillTarget: path.join(pluginRoot, 'skills', SKILL_NAME),
      relayTarget: path.join(pluginRoot, 'skills', SKILL_NAME, 'scripts', 'relay.mjs'),
      duplicateSkillTarget: path.join(geminiConfigDir, 'skills', SKILL_NAME),
      codexSkillDir,
    };
  }
  if (mode === 'skill') {
    const skillTarget = path.join(geminiConfigDir, 'skills', SKILL_NAME);
    return {
      mode,
      homeDir,
      geminiConfigDir,
      targetRoot: skillTarget,
      skillTarget,
      relayTarget: path.join(skillTarget, 'scripts', 'relay.mjs'),
      duplicateSkillTarget: null,
      codexSkillDir,
    };
  }
  const projectDir = flags.project ? path.resolve(flags.project) : process.cwd();
  const skillTarget = path.join(projectDir, '.agents', 'skills', SKILL_NAME);
  return {
    mode,
    homeDir,
    geminiConfigDir,
    projectDir,
    targetRoot: skillTarget,
    skillTarget,
    relayTarget: path.join(skillTarget, 'scripts', 'relay.mjs'),
    duplicateSkillTarget: null,
    codexSkillDir,
  };
}

function copyDirClean(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
}

function syncWslCodexSkill(distro) {
  const wslArgs = [];
  if (distro) wslArgs.push('-d', distro);
  const bashCmd = 'src=$(wslpath -u "$1") && dst="$HOME/.codex/skills/$2" && rm -rf "$dst" && mkdir -p "$HOME/.codex/skills" && cp -R "$src" "$dst"';
  const res = spawnSync('wsl.exe', [...wslArgs, '-e', 'bash', '-lc', bashCmd, 'sync', SKILL_SRC, SKILL_NAME], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
  });
  if (res.status !== 0) {
    throw new Error(`WSL Codex skill sync failed: ${(res.stderr || res.error?.message || '').trim()}`);
  }
}

function removeWslCodexSkill(distro) {
  const wslArgs = [];
  if (distro) wslArgs.push('-d', distro);
  const bashCmd = 'rm -rf "$HOME/.codex/skills/$1"';
  spawnSync('wsl.exe', [...wslArgs, '-e', 'bash', '-lc', bashCmd, 'rm', SKILL_NAME], {
    encoding: 'utf8',
    timeout: 15000,
    windowsHide: true,
  });
}

function verifyRelaySyntax(scriptPath) {
  const check = spawnSync(process.execPath, ['--check', scriptPath], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return check.status === 0;
}

function cmdInstall(flags) {
  if (!fs.existsSync(SKILL_SRC)) throw new Error(`Skill source missing: ${SKILL_SRC}`);
  const targets = resolveTargets(flags);

  if (targets.mode === 'plugin') {
    if (!fs.existsSync(PLUGIN_JSON_SRC)) throw new Error(`plugin.json missing: ${PLUGIN_JSON_SRC}`);
    fs.mkdirSync(path.join(targets.targetRoot, 'skills'), { recursive: true });
    fs.copyFileSync(PLUGIN_JSON_SRC, path.join(targets.targetRoot, 'plugin.json'));
  }
  copyDirClean(SKILL_SRC, targets.skillTarget);

  let dedupedStandaloneSkill = false;
  let duplicateWarning = null;
  if (targets.duplicateSkillTarget && fs.existsSync(targets.duplicateSkillTarget)) {
    if (flags.dedupe) {
      fs.rmSync(targets.duplicateSkillTarget, { recursive: true, force: true });
      dedupedStandaloneSkill = true;
    } else {
      duplicateWarning = `Standalone skill also exists at ${targets.duplicateSkillTarget}; pass --dedupe if you want only the plugin copy active.`;
    }
  }

  let codexInstalled = false;
  let wslCodexInstalled = false;
  if (flags['with-codex']) {
    copyDirClean(SKILL_SRC, targets.codexSkillDir);
    codexInstalled = true;
    if (process.platform === 'win32' && typeof flags['wsl-distro'] === 'string' && flags['wsl-distro'].trim()) {
      syncWslCodexSkill(flags['wsl-distro'].trim());
      wslCodexInstalled = true;
    }
  }

  const syntaxOk = verifyRelaySyntax(targets.relayTarget);
  if (!syntaxOk) {
    throw new Error(`Installed relay.mjs failed syntax check: ${targets.relayTarget}`);
  }

  const result = {
    ok: true,
    action: 'install',
    mode: targets.mode,
    targetRoot: targets.targetRoot,
    skillPath: targets.skillTarget,
    relayScript: targets.relayTarget,
    codexSkillPath: codexInstalled ? targets.codexSkillDir : null,
    wslCodexSynced: wslCodexInstalled,
    dedupedStandaloneSkill,
    warning: duplicateWarning,
  };

  if (!flags.quiet) {
    console.log(JSON.stringify(result, null, 2));
  }
  return result;
}

function cmdUpdate(flags) {
  const targets = resolveTargets(flags);
  if (fs.existsSync(path.join(targets.targetRoot, '.git'))) {
    const pull = spawnSync('git', ['-C', targets.targetRoot, 'pull', '--ff-only'], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (pull.status !== 0) {
      throw new Error(`git pull failed in ${targets.targetRoot}: ${(pull.stderr || pull.stdout || '').trim()}`);
    }
    const syntaxOk = verifyRelaySyntax(targets.relayTarget);
    if (!flags.quiet) {
      console.log(JSON.stringify({
        ok: syntaxOk,
        action: 'update-git',
        mode: targets.mode,
        targetRoot: targets.targetRoot,
        output: (pull.stdout || '').trim(),
      }, null, 2));
    }
    if (!syntaxOk) process.exitCode = 1;
    return;
  }
  const res = cmdInstall({ ...flags, quiet: true });
  if (!flags.quiet) {
    console.log(JSON.stringify({ ...res, action: 'update-reinstall' }, null, 2));
  }
}

function cmdUninstall(flags) {
  const targets = resolveTargets(flags);
  let removedMain = false;
  if (fs.existsSync(targets.targetRoot)) {
    fs.rmSync(targets.targetRoot, { recursive: true, force: true });
    removedMain = true;
  }
  let removedCodex = false;
  if (flags['with-codex'] && fs.existsSync(targets.codexSkillDir)) {
    fs.rmSync(targets.codexSkillDir, { recursive: true, force: true });
    removedCodex = true;
  }
  if (flags['with-codex'] && process.platform === 'win32' && typeof flags['wsl-distro'] === 'string' && flags['wsl-distro'].trim()) {
    removeWslCodexSkill(flags['wsl-distro'].trim());
  }
  console.log(JSON.stringify({
    ok: true,
    action: 'uninstall',
    mode: targets.mode,
    targetRoot: targets.targetRoot,
    removedMain,
    removedCodex,
  }, null, 2));
}

function cmdDoctor(flags) {
  const homeDir = flags.home ? path.resolve(flags.home) : os.homedir();
  const geminiConfig = path.join(homeDir, '.gemini', 'config');
  const pluginDir = path.join(geminiConfig, 'plugins', SKILL_NAME);
  const pluginManifest = path.join(pluginDir, 'plugin.json');
  const pluginSkillMd = path.join(pluginDir, 'skills', SKILL_NAME, 'SKILL.md');
  const pluginRelay = path.join(pluginDir, 'skills', SKILL_NAME, 'scripts', 'relay.mjs');
  const standaloneSkillMd = path.join(geminiConfig, 'skills', SKILL_NAME, 'SKILL.md');
  const codexSkillMd = path.join(homeDir, '.codex', 'skills', SKILL_NAME, 'SKILL.md');

  let pluginManifestValid = false;
  if (fs.existsSync(pluginManifest)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pluginManifest, 'utf8'));
      pluginManifestValid = Boolean(parsed?.name);
    } catch {
      pluginManifestValid = false;
    }
  }

  const activeRelay = fs.existsSync(pluginRelay) ? pluginRelay : RELAY_SRC;
  const relaySyntaxOk = fs.existsSync(activeRelay) ? verifyRelaySyntax(activeRelay) : false;

  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  const threadsRes = spawnSync(
    process.execPath,
    [activeRelay, 'threads', '--runtime', process.platform === 'win32' ? 'windows' : 'posix', '--limit', '1', '--json'],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 },
  );

  let localThreadsProbeOk = false;
  if (threadsRes.status === 0) {
    try {
      JSON.parse(threadsRes.stdout);
      localThreadsProbeOk = true;
    } catch {
      localThreadsProbeOk = false;
    }
  }

  console.log(JSON.stringify({
    ok: nodeMajor >= 18 && relaySyntaxOk && (fs.existsSync(pluginSkillMd) || fs.existsSync(standaloneSkillMd)),
    nodeVersion: process.versions.node,
    nodeSupported: nodeMajor >= 18,
    homeDir,
    pluginInstalled: fs.existsSync(pluginSkillMd),
    pluginManifestValid,
    standaloneSkillInstalled: fs.existsSync(standaloneSkillMd),
    codexSkillInstalled: fs.existsSync(codexSkillMd),
    relaySyntaxOk,
    localThreadsProbeOk,
  }, null, 2));
}

function main() {
  const argv = process.argv.slice(2);
  const first = argv[0];

  if (first && RELAY_PASSTHROUGH_CMDS.has(first)) {
    const res = spawnSync(process.execPath, [RELAY_SRC, ...argv], {
      stdio: 'inherit',
      windowsHide: false,
    });
    process.exitCode = res.status ?? 1;
    return;
  }

  const { positionals, flags } = parseFlags(argv);
  const cmd = positionals[0];

  if (!cmd || flags.help) {
    printHelp();
    return;
  }

  switch (cmd) {
    case 'install':
      cmdInstall(flags);
      break;
    case 'update':
      cmdUpdate(flags);
      break;
    case 'uninstall':
      cmdUninstall(flags);
      break;
    case 'doctor':
      cmdDoctor(flags);
      break;
    default:
      throw new Error(`Unknown command: ${cmd}. Use --help for usage.`);
  }
}

try {
  main();
} catch (err) {
  console.error(err?.message || String(err));
  process.exitCode = 1;
}
