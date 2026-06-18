#!/bin/bash
# io-auto-mode -- Antigravity (agy) PreToolUse safety classifier entry.
# Reads agy hook JSON on stdin, emits {"allowTool":bool} JSON to stdout.
# Exits 0 on every path (fail-open -- a broken classifier must never hard-brick the agent).

set -u

# AGY_PLUGIN_ROOT is the adapter root. When invoked from a bundled dist
# layout it may be pre-set; when invoked from the repo, derive it from
# this script's location.
: "${AGY_PLUGIN_ROOT:=$(cd "$(dirname "$(realpath "${BASH_SOURCE[0]}")")/.." && pwd)}"
export AGY_PLUGIN_ROOT

# Candidate layouts, probed in order (mirrors the claude-code adapter):
#   1. <root>/dist/pretooluse-classify.js  -- bundled layout (built by scripts/build.mjs)
#   2. <root>/src/pretooluse-classify.ts   -- dev mode (tsx)
for cand in \
  "${AGY_PLUGIN_ROOT}/dist/pretooluse-classify.js"; do
  if [[ -f "$cand" ]]; then exec node "$cand"; fi
done

if [[ -f "${AGY_PLUGIN_ROOT}/src/pretooluse-classify.ts" ]]; then
  exec npx --yes tsx "${AGY_PLUGIN_ROOT}/src/pretooluse-classify.ts"
fi

# Fail-open: allow the tool call if the handler is missing.
echo '{"allowTool":true}'
exit 0
