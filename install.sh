#!/usr/bin/env bash
set -euo pipefail

MODE="plugin"
PROJECT=""
WITH_CODEX="false"
DEDUPE="false"
QUIET="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--mode)
      MODE="${2:-}"
      shift 2
      ;;
    --project)
      PROJECT="${2:-}"
      shift 2
      ;;
    --with-codex)
      WITH_CODEX="true"
      shift
      ;;
    --dedupe)
      DEDUPE="true"
      shift
      ;;
    -q|--quiet)
      QUIET="true"
      shift
      ;;
    -h|--help)
      echo "Usage: bash install.sh [-m plugin|skill|project] [--project <dir>] [--with-codex] [--dedupe] [-q|--quiet]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_SCRIPT="$REPO_ROOT/bin/cli.mjs"

if command -v node >/dev/null 2>&1; then
  ARGS=("$CLI_SCRIPT" "install" "--mode" "$MODE")
  [[ -n "$PROJECT" ]] && ARGS+=("--project" "$PROJECT")
  [[ "$WITH_CODEX" == "true" ]] && ARGS+=("--with-codex")
  [[ "$DEDUPE" == "true" ]] && ARGS+=("--dedupe")
  [[ "$QUIET" == "true" ]] && ARGS+=("--quiet")
  exec node "${ARGS[@]}"
fi

echo "Warning: Node.js >= 18 is not installed. Falling back to file copy only." >&2
SKILL_SRC="$REPO_ROOT/skills/sdd-multi-agent-relay"
PLUGIN_JSON_SRC="$REPO_ROOT/plugin.json"
GEMINI_CONFIG="${HOME}/.gemini/config"

case "$MODE" in
  plugin)
    TARGET_ROOT="${GEMINI_CONFIG}/plugins/sdd-multi-agent-relay"
    TARGET_SKILL="${TARGET_ROOT}/skills/sdd-multi-agent-relay"
    mkdir -p "${TARGET_ROOT}/skills"
    rm -rf "$TARGET_SKILL"
    cp -R "$SKILL_SRC" "$TARGET_SKILL"
    cp "$PLUGIN_JSON_SRC" "${TARGET_ROOT}/plugin.json"
    if [[ -d "$REPO_ROOT/assets" ]]; then
      rm -rf "${TARGET_ROOT}/assets"
      cp -R "$REPO_ROOT/assets" "${TARGET_ROOT}/assets"
    fi
    [[ "$QUIET" == "false" ]] && echo "Installed Plugin -> $TARGET_ROOT"
    ;;
  skill)
    TARGET_SKILL="${GEMINI_CONFIG}/skills/sdd-multi-agent-relay"
    mkdir -p "${GEMINI_CONFIG}/skills"
    rm -rf "$TARGET_SKILL"
    cp -R "$SKILL_SRC" "$TARGET_SKILL"
    [[ "$QUIET" == "false" ]] && echo "Installed Skill -> $TARGET_SKILL"
    ;;
  project)
    PROJ_DIR="${PROJECT:-$(pwd)}"
    TARGET_SKILL="${PROJ_DIR}/.agents/skills/sdd-multi-agent-relay"
    mkdir -p "${PROJ_DIR}/.agents/skills"
    rm -rf "$TARGET_SKILL"
    cp -R "$SKILL_SRC" "$TARGET_SKILL"
    [[ "$QUIET" == "false" ]] && echo "Installed Project Skill -> $TARGET_SKILL"
    ;;
  *)
    echo "Invalid mode: $MODE" >&2
    exit 2
    ;;
esac
