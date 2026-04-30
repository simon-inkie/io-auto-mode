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
**Context:** Today the log captures `stage`, `decision`, `model`, `durationMs`, and (for Stage 2) `thinking`, but not `inputTokens` / `outputTokens`. That makes cost claims in the README estimative rather than measured. AI SDK migration plans this anyway (`specs/ai-sdk-migration.md` §"Cost telemetry"); pulling it forward as a small standalone change is cheap.

**Scope:**
1. Extend `ModelCallFn` return type from `Promise<string>` to `Promise<{ text: string; usage?: { inputTokens: number; outputTokens: number } }>` — additive, no breaking changes if `usage` is optional.
2. Both adapters (`adapters/openclaw/src/plugin.ts`, `adapters/claude-code/src/model-call.ts`) populate `usage` from the underlying provider response.
3. `core/logger.ts` writes `inputTokens`, `outputTokens`, and a derived `costUSD` (using a small per-model rate table) into each log entry.
4. Update README's Cost section to quote a measured £/day with a source link to a fresh log roll-up.

---

## Platform adapters

### Cursor Tab hooks (`beforeTabFileRead` / `afterFileEdit`)
**Priority:** Medium (after v0.1.0 lands and we have user feedback)
**Context:** Cursor's autonomous Tab inline-completion runs without a human in the loop, fires per-keystroke, and uses a different hook surface than Agent (`beforeTabFileRead`, `afterFileEdit`). Arguably *higher*-stakes than Agent coverage, but doubles the integration surface and the per-keystroke latency budget is tight.
**Scope sketch:** new `bin/classify-tab-file.sh` + adapter routing + per-keystroke perf measurement before shipping. Most hooks here are `allow|deny`-only (same constraint as `beforeReadFile`).

### Cursor adapter — hot-reload smoke test
**Priority:** Low
**Context:** Spec §10 / §12 flagged hot-reload-vs-restart behaviour as a wildcard time-sink. v0.1.x ships with INSTALL.md saying "restart Cursor". A live smoke test would let us confirm whether `~/.cursor/hooks.json` edits pick up without restart, and update INSTALL with the truthful answer.

### DRY up `model-call.ts` across adapters
**Priority:** Low
**Context:** Both `adapters/claude-code/src/model-call.ts` and `adapters/cursor/src/model-call.ts` are byte-identical (~80 LOC of provider-API call code). It only does `fetch()` calls — no platform-specific dependency — so it belongs in `core/`. Move + import-rewrite is ~10 minutes; deferred only because the duplication is harmless and it's worth doing alongside the AI SDK migration when both adapters' model-call shapes change anyway.

---

## Packaging

### ~~Move `openclaw` out of root `dependencies`~~ ✅ Done
Resolved 2026-04-30 as part of npm publish prep (commit landing alongside
this BACKLOG update). `openclaw` moved to `peerDependenciesMeta.openclaw =
{optional: true}`. Claude-Code/Cursor install footprint dropped from
**348MB → 404KB** (99.88%). OpenClaw users now `pnpm add openclaw`
explicitly per the new note in INSTALL.md §OpenClaw.
