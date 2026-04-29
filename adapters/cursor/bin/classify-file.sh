#!/bin/bash
# io-auto-mode — Cursor file-tool hook entry. Multiplexes beforeReadFile
# and preToolUse (Edit|Write matcher) onto the same path-based classifier.
# Should complete in <1ms — no LLM call.

set -u

: "${CURSOR_HOOK_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"

HANDLER_JS="${CURSOR_HOOK_ROOT}/dist/file-hook.js"
HANDLER_TS="${CURSOR_HOOK_ROOT}/src/file-hook.ts"

if [[ -f "$HANDLER_JS" ]]; then
  exec node "$HANDLER_JS"
elif [[ -f "$HANDLER_TS" ]]; then
  exec npx --yes tsx "$HANDLER_TS"
else
  # Fail open for the file classifier — it's a sub-millisecond path-match,
  # so a missing handler is almost certainly a deploy/install problem rather
  # than something the user wants us to stop them on. Aligns with the Claude
  # Code adapter's posture for the same hook.
  cat <<'EOF'
{"permission":"allow","user_message":"io-auto-mode/file: handler not found (allow-through to avoid blocking on install error)"}
EOF
  exit 0
fi
