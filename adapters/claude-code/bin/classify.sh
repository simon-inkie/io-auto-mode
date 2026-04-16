#!/bin/bash
# io-auto-mode — Claude Code PreToolUse hook entry.
# Reads JSON on stdin, delegates to the bundled Node handler, writes decision
# JSON to stdout. Exits 0 on every non-catastrophic path so Claude Code reads
# our structured decision; fatal errors surface via exit 2 (fail closed).

set -u

# CLAUDE_PLUGIN_ROOT is only set when installed as a Claude Code plugin.
# When invoked directly from settings.json, derive root from this script's
# location: bin/classify.sh → plugin root is one level up.
: "${CLAUDE_PLUGIN_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"

# Prefer the bundled output; fall back to the source TypeScript via tsx for
# iterative dev (symlink install / --plugin-dir usage).
HANDLER_JS="${CLAUDE_PLUGIN_ROOT}/dist/hook.js"
HANDLER_TS="${CLAUDE_PLUGIN_ROOT}/src/hook.ts"

if [[ -f "$HANDLER_JS" ]]; then
  exec node "$HANDLER_JS"
elif [[ -f "$HANDLER_TS" ]]; then
  exec npx --yes tsx "$HANDLER_TS"
else
  # Fail closed with a machine-parseable decision so Claude still blocks.
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"io-auto-mode: handler not found (neither dist/hook.js nor src/hook.ts)"}}
EOF
  exit 0
fi
