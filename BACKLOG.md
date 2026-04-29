# io-auto-mode Backlog

## Performance

### Short-circuit classifier for allow-always commands
**Priority:** High  
**Context:** Every exec call runs through the full classifier pipeline (~1.7s with gemini-2.5-flash). If a command is already on the user's allow-always allowlist, this is wasted time and cost — they've explicitly said "I trust this".

**Proposed solution:**
1. On plugin init, read `~/.openclaw/exec-approvals.json` and cache the allowlist
2. Watch the file for changes (chokidar or fs.watch) so new allow-always entries take effect without restart
3. On each `before_tool_call`, hash the incoming command and check against cache first
4. If match → return immediately (allow), skip all classifier stages
5. If no match → run pipeline as normal

**Hash format:** The allowlist uses `=command:<hash>` patterns — need to match OpenClaw's exact hashing algorithm (check exec-approvals source or reverse-engineer from existing entries).

**Benefit:** Zero latency + zero API cost for trusted commands. Only unknown/new commands pay the classification tax.

---

## Correctness

### Add allow-always short-circuit to benchmark fixtures
Once implemented, add fixtures to verify allowlisted commands are correctly short-circuited and logged as `stage: allowlist`.

---

## UX

### Better approval card formatting
Currently truncates command at 100 chars and reason at 140 chars to stay under 256 char limit. Could be improved with smarter truncation (e.g. preserve the end of the command which often has the meaningful part).

---

## Security

### Periodic allowlist audit
Optionally surface a warning if the allowlist has grown very large (e.g. >50 entries) — could indicate drift from intended trust decisions.

---

## Observability

### Capture token usage in `auto-mode-log.jsonl`
**Priority:** Medium
**Context:** Today the log captures `stage`, `decision`, `model`, `durationMs`, and (for Stage 2) `thinking`, but not `inputTokens` / `outputTokens`. That makes cost claims in the README estimative rather than measured. AI SDK migration plans this anyway (`AI-SDK-MIGRATION-SPEC.md` §"Cost telemetry"); pulling it forward as a small standalone change is cheap.

**Scope:**
1. Extend `ModelCallFn` return type from `Promise<string>` to `Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>` — additive, no breaking changes if `usage` is optional.
2. Both adapters (`adapters/openclaw/src/plugin.ts`, `adapters/claude-code/src/model-call.ts`) populate `usage` from the underlying provider response.
3. `core/logger.ts` writes `inputTokens`, `outputTokens`, and a derived `costUSD` (using a small per-model rate table) into each log entry.
4. Update README's Cost section to quote a measured £/day with a source link to a fresh log roll-up.

---

## Platform adapters

### Cursor adapter
**Priority:** Medium
**Context:** Cursor is one of the most-used AI coding environments and has been at the centre of recent agent-deletes-production-database incidents. A Cursor plugin/extension that wires `core/classifier.ts` into Cursor's command-execution path would extend io-auto-mode's protection beyond OpenClaw + Claude Code.

**Open questions:**
1. What hook surface does Cursor expose for intercepting tool / shell calls? Native plugin API, MCP, or process-level shim?
2. Does Cursor pass conversation context to plugins in a form `buildClassifierInput()` can consume, or does it need an adapter-specific transcript shape?
3. File-tool zone classifier: does Cursor's file-edit path call out to a hook, or does it write directly?

**Scope sketch:** new `adapters/cursor/` mirroring `adapters/claude-code/`. Reuse `core/` unchanged. Likely 1-2 days once the hook surface is mapped.
