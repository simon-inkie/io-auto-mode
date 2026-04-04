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
