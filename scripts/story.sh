#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export STORY_RUNTIME_DIR="${STORY_RUNTIME_DIR:-$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies}"
export STORY_SKILL_DIR="${STORY_SKILL_DIR:-$HOME/.codex/plugins/cache/openai-primary-runtime/presentations/26.909.12148/skills/presentations}"
story_node="$STORY_RUNTIME_DIR/node/bin/node"
story_python="$STORY_RUNTIME_DIR/python/bin/python3"
export RUNTIME_NODE="$story_node"
export RUNTIME_NODE_MODULES="$STORY_RUNTIME_DIR/node/node_modules"
export RUNTIME_PYTHON="$story_python"

case "${1:-help}" in
  build|check|cinema|check-cinema) ;;
  *)
    echo 'Usage: ./scripts/story.sh build | cinema | check [artifact-directory] | check-cinema [artifact-directory]'
    echo 'build creates a private copy in .build; check reads the approved export by default.'
    exit 0 ;;
esac
for dependency in "$story_node" "$story_python" "$STORY_SKILL_DIR/container_tools/artifact_tool_utils.mjs"; do
  if [[ ! -e "$dependency" ]]; then
    echo "Missing dependency: $dependency. See docs/presentation-build.md." >&2
    exit 1
  fi
done

if [[ "$1" == cinema ]]; then
  if [[ $# -ne 1 ]]; then echo 'cinema does not take an output directory.' >&2; exit 1; fi
  "$story_node" "$project_root/scripts/build-cinema.mjs"
elif [[ "$1" == check-cinema ]]; then
  "$story_python" "$project_root/scripts/check-cinema.py" "${2:-$project_root/output/trailer-cinema}"
elif [[ "$1" == build ]]; then
  if [[ $# -ne 1 ]]; then echo 'build does not take an output directory.' >&2; exit 1; fi
  "$story_node" "$project_root/scripts/build-story.mjs"
else
  "$story_python" "$project_root/scripts/check-story.py" "${2:-$project_root/output/trailer}"
fi
