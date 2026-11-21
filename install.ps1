[CmdletBinding()]
param(
  [ValidateSet("plugin", "skill", "project")]
  [string]$Mode = "plugin",
  [string]$Project = "",
  [string]$WslDistro = "",
  [switch]$WithCodex,
  [switch]$Dedupe,
  [switch]$Quiet
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$CliScript = Join-Path $RepoRoot "bin\cli.mjs"

if (Get-Command node -ErrorAction SilentlyContinue) {
  $nodeArgs = @($CliScript, "install", "--mode", $Mode)
  if ($Project) { $nodeArgs += @("--project", $Project) }
  if ($WithCodex) { $nodeArgs += "--with-codex" }
  if ($WslDistro) { $nodeArgs += @("--wsl-distro", $WslDistro) }
  if ($Dedupe) { $nodeArgs += "--dedupe" }
  if ($Quiet) { $nodeArgs += "--quiet" }

  & node @nodeArgs
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  exit 0
}

Write-Warning "Node.js >= 18 was not found on PATH. Falling back to file copy only (Node.js will still be required at runtime)."
$SkillSrc = Join-Path $RepoRoot "skills\sdd-multi-agent-relay"
$PluginJsonSrc = Join-Path $RepoRoot "plugin.json"
$GeminiConfig = Join-Path $env:USERPROFILE ".gemini\config"

if ($Mode -eq "plugin") {
  $TargetRoot = Join-Path $GeminiConfig "plugins\sdd-multi-agent-relay"
  $TargetSkill = Join-Path $TargetRoot "skills\sdd-multi-agent-relay"
  New-Item -ItemType Directory -Force -Path (Join-Path $TargetRoot "skills") | Out-Null
  if (Test-Path $TargetSkill) { Remove-Item -Recurse -Force $TargetSkill }
  Copy-Item -Recurse -Force $SkillSrc $TargetSkill
  Copy-Item -Force $PluginJsonSrc (Join-Path $TargetRoot "plugin.json")
  $AssetsSrc = Join-Path $RepoRoot "assets"
  $TargetAssets = Join-Path $TargetRoot "assets"
  if (Test-Path $AssetsSrc) {
    if (Test-Path $TargetAssets) { Remove-Item -Recurse -Force $TargetAssets }
    Copy-Item -Recurse -Force $AssetsSrc $TargetAssets
  }
  if (-not $Quiet) { Write-Host "Installed Plugin -> $TargetRoot" }
} elseif ($Mode -eq "skill") {
  $TargetSkill = Join-Path $GeminiConfig "skills\sdd-multi-agent-relay"
  New-Item -ItemType Directory -Force -Path (Join-Path $GeminiConfig "skills") | Out-Null
  if (Test-Path $TargetSkill) { Remove-Item -Recurse -Force $TargetSkill }
  Copy-Item -Recurse -Force $SkillSrc $TargetSkill
  if (-not $Quiet) { Write-Host "Installed Skill -> $TargetSkill" }
} else {
  $ProjDir = if ($Project) { $Project } else { (Get-Location).Path }
  $TargetSkill = Join-Path $ProjDir ".agents\skills\sdd-multi-agent-relay"
  New-Item -ItemType Directory -Force -Path (Join-Path $ProjDir ".agents\skills") | Out-Null
  if (Test-Path $TargetSkill) { Remove-Item -Recurse -Force $TargetSkill }
  Copy-Item -Recurse -Force $SkillSrc $TargetSkill
  if (-not $Quiet) { Write-Host "Installed Project Skill -> $TargetSkill" }
}
