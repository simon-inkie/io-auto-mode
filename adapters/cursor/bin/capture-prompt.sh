#!/bin/bash
# io-auto-mode — Cursor beforeSubmitPrompt hook entry.
# Captures the user's prompt and stashes it in
# ~/.io-auto-mode/cache/cursor-prompts/<conversation_id>.json so the next
# beforeShellExecution call can use it as classifier context.
#
# This hook never blocks. Always emits permission: allow.

set -u

: "${CURSOR_HOOK_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"

HANDLER_JS="${CURSOR_HOOK_ROOT}/dist/prompt-hook.js"
HANDLER_TS="${CURSOR_HOOK_ROOT}/src/prompt-hook.ts"

if [[ -f "$HANDLER_JS" ]]; then
  exec node "$HANDLER_JS"
elif [[ -f "$HANDLER_TS" ]]; then
  exec npx --yes tsx "$HANDLER_TS"
else
  # Fail open — this hook only captures context. If the handler is missing
  # we lose prompt-injection-hardening parity for one prompt; we never want
  # to block the user from submitting their message because of it.
  cat <<'EOF'
{"permission":"allow"}
EOF
  exit 0
fi
