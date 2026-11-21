[CmdletBinding()]
param(
  [ValidateSet("plugin", "skill")]
  [string]$Mode = "plugin",
  [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillSrc = Join-Path $RepoRoot "skills\sdd-multi-agent-relay"
$PluginJsonSrc = Join-Path $RepoRoot "plugin.json"

if (!(Test-Path $SkillSrc)) {
  throw "Skill source directory not found: $SkillSrc"
}

try {
  $nodeVer = (& node --version 2>$null).Trim()
  Write-Host "Detected Node.js: $nodeVer"
} catch {
  Write-Warning "Node.js >= 18 is required to run relay.mjs, but 'node' was not found on PATH."
}

$GeminiConfigRoot = Join-Path $env:USERPROFILE ".gemini\config"

if ($Mode -eq "plugin") {
  $TargetRoot = Join-Path $GeminiConfigRoot "plugins\sdd-multi-agent-relay"
  $TargetSkill = Join-Path $TargetRoot "skills\sdd-multi-agent-relay"
  New-Item -ItemType Directory -Force -Path (Join-Path $TargetRoot "skills") | Out-Null
  if (Test-Path $TargetSkill) {
    Remove-Item -Recurse -Force $TargetSkill
  }
  Copy-Item -Recurse -Force $SkillSrc $TargetSkill
  Copy-Item -Force $PluginJsonSrc (Join-Path $TargetRoot "plugin.json")
  $RelayScript = Join-Path $TargetSkill "scripts\relay.mjs"
  Write-Host "Installed as Antigravity Plugin -> $TargetRoot"
} else {
  $TargetSkill = Join-Path $GeminiConfigRoot "skills\sdd-multi-agent-relay"
  New-Item -ItemType Directory -Force -Path (Join-Path $GeminiConfigRoot "skills") | Out-Null
  if (Test-Path $TargetSkill) {
    Remove-Item -Recurse -Force $TargetSkill
  }
  Copy-Item -Recurse -Force $SkillSrc $TargetSkill
  $RelayScript = Join-Path $TargetSkill "scripts\relay.mjs"
  Write-Host "Installed as standalone Antigravity Skill -> $TargetSkill"
}

if (Get-Command node -ErrorAction SilentlyContinue) {
  & node --check $RelayScript
  if ($LASTEXITCODE -ne 0) { throw "Syntax check failed for $RelayScript" }
  Write-Host "Verified relay.mjs cleanly."
}

Write-Host ""
Write-Host "Done! Next in any project directory:"
Write-Host "  node `"$RelayScript`" init --project . --runtime windows --name MyApp --batch PKG-FEAT-01"
