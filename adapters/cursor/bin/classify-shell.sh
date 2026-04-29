#!/bin/bash
# io-auto-mode — Cursor beforeShellExecution hook entry.
# Reads JSON on stdin, delegates to the bundled Node handler, writes a Cursor
# permission JSON to stdout. Exits 0 on every non-catastrophic path so Cursor
# reads our structured decision.

set -u

# CURSOR_HOOK_ROOT is only set when installed as a Cursor managed plugin.
# When invoked directly from hooks.json, derive from this script's location:
# bin/classify-shell.sh → adapter root is one level up.
: "${CURSOR_HOOK_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"

# Prefer the bundled output; fall back to the source TypeScript via tsx for
# iterative dev (symlink install / direct source usage).
HANDLER_JS="${CURSOR_HOOK_ROOT}/dist/hook.js"
HANDLER_TS="${CURSOR_HOOK_ROOT}/src/hook.ts"

if [[ -f "$HANDLER_JS" ]]; then
  exec node "$HANDLER_JS"
elif [[ -f "$HANDLER_TS" ]]; then
  exec npx --yes tsx "$HANDLER_TS"
else
  # Fail closed with a machine-parseable Cursor decision so the agent still
  # gets blocked rather than the action proceeding without classification.
  cat <<'EOF'
{"permission":"deny","user_message":"io-auto-mode: handler not found (neither dist/hook.js nor src/hook.ts)","agent_message":"io-auto-mode handler missing. Reinstall or contact the operator."}
EOF
  exit 0
fi
