#!/bin/bash
# io-auto-mode — Claude Code PreToolUse hook for Read/Write/Edit.
# Path-based classification only, no LLM. Should complete in <1ms.

set -u

HANDLER_JS="${CLAUDE_PLUGIN_ROOT}/dist/file-hook.js"
HANDLER_TS="${CLAUDE_PLUGIN_ROOT}/src/file-hook.ts"

if [[ -f "$HANDLER_JS" ]]; then
  exec node "$HANDLER_JS"
elif [[ -f "$HANDLER_TS" ]]; then
  exec npx --yes tsx "$HANDLER_TS"
else
  cat <<'EOF'
{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"io-auto-mode/file: handler not found"}}
EOF
  exit 0
fi
