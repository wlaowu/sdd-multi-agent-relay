#!/usr/bin/env bash
set -euo pipefail

MODE="plugin"
while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--mode)
      MODE="${2:-}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: bash install.sh [-m plugin|skill]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

if [[ "$MODE" != "plugin" && "$MODE" != "skill" ]]; then
  echo "Invalid mode: $MODE (must be plugin or skill)" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_SRC="$REPO_ROOT/skills/sdd-multi-agent-relay"
PLUGIN_JSON_SRC="$REPO_ROOT/plugin.json"
GEMINI_CONFIG="${HOME}/.gemini/config"

if [[ ! -d "$SKILL_SRC" ]]; then
  echo "Skill source directory not found: $SKILL_SRC" >&2
  exit 1
fi

if command -v node >/dev/null 2>&1; then
  echo "Detected Node.js: $(node --version)"
else
  echo "Warning: Node.js >= 18 is required to run relay.mjs, but 'node' was not found on PATH." >&2
fi

if [[ "$MODE" == "plugin" ]]; then
  TARGET_ROOT="${GEMINI_CONFIG}/plugins/sdd-multi-agent-relay"
  TARGET_SKILL="${TARGET_ROOT}/skills/sdd-multi-agent-relay"
  mkdir -p "${TARGET_ROOT}/skills"
  rm -rf "$TARGET_SKILL"
  cp -R "$SKILL_SRC" "$TARGET_SKILL"
  cp "$PLUGIN_JSON_SRC" "${TARGET_ROOT}/plugin.json"
  RELAY_SCRIPT="${TARGET_SKILL}/scripts/relay.mjs"
  echo "Installed as Antigravity Plugin -> $TARGET_ROOT"
else
  TARGET_SKILL="${GEMINI_CONFIG}/skills/sdd-multi-agent-relay"
  mkdir -p "${GEMINI_CONFIG}/skills"
  rm -rf "$TARGET_SKILL"
  cp -R "$SKILL_SRC" "$TARGET_SKILL"
  RELAY_SCRIPT="${TARGET_SKILL}/scripts/relay.mjs"
  echo "Installed as standalone Antigravity Skill -> $TARGET_SKILL"
fi

if command -v node >/dev/null 2>&1; then
  node --check "$RELAY_SCRIPT"
  echo "Verified relay.mjs cleanly."
fi

echo ""
echo "Done! Next in any project directory:"
echo "  node \"$RELAY_SCRIPT\" init --project . --runtime posix --name MyApp --batch PKG-FEAT-01"
