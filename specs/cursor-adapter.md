# Cursor Adapter Spec

**Status:** spec, not started
**Date:** 2026-04-29
**Owner:** Doctor Two (platform-side implementation)
**Goal:** Add a Cursor adapter alongside Claude Code and OpenClaw, so io-auto-mode protects Cursor's Agent (and optionally Tab) tool-execution paths via Cursor's native hooks system.

---

## 0. Why now

Cursor was the runtime behind the most public agent-deletes-database incident referenced in the README backstory. Their hooks system gives a clean integration point that didn't exist when v0.1.0 was scoped. Adding Cursor extends the project from "Claude Code + OpenClaw" to "all three major agentic-dev runtimes" — the right surface for the launch narrative.

Reference: <https://cursor.com/docs/hooks>

---

## 1. Cursor hook surface (relevant subset)

| Cursor hook | Fires on | Maps to |
|---|---|---|
| `beforeShellExecution` | Agent shell command, pre-exec | Bash classifier |
| `beforeReadFile` | Agent file read, pre-exec | File-hook (Read) |
| `preToolUse` (matched on Edit/Write tool names) | Agent file write/edit, pre-exec | File-hook (Write/Edit) |
| `beforeMCPExecution` | Agent MCP tool call, pre-exec | MCP classifier (deferred) |
| `beforeTabFileRead` | Tab inline-completion file read | File-hook (Read) — separate policy possible |
| `afterFileEdit` | Agent file edit, **post-hoc** | Audit only — too late to prevent |

**In scope for v0.1.x:** rows 1-3 (Agent shell + Agent file read + Agent file write/edit).
**Deferred:** rows 4-6.

---

## 2. Architecture

Mirrors the Claude Code adapter exactly. Three files in `adapters/cursor/src/`:

- `hook.ts` — `beforeShellExecution` handler. Reads stdin, builds a `TranscriptEntry`-shaped context (using `transcript_path` env var if available), runs `core/classifier.classify()`, maps decision to Cursor's `{permission, user_message, agent_message}` JSON.
- `file-hook.ts` — handles both `beforeReadFile` and `preToolUse` (matched on Edit/Write). Path-based zone classifier; same shape as Claude Code's `file-hook.ts`. Tool-name routing (Read → `allowRead`; Edit/Write → `allowWrite`).
- `read-transcript.ts` — best-effort transcript reader for Cursor's `transcript_path`. Falls back to empty context if missing.

Two bin wrappers in `adapters/cursor/bin/`:

- `classify-shell.sh` — invokes `dist/hook.js` (or `src/hook.ts` via `tsx` in dev).
- `classify-file.sh` — invokes `dist/file-hook.js`.

Both follow the same shape as the Claude Code adapter's wrappers: derive `CURSOR_HOOK_ROOT` from `BASH_SOURCE`; prefer bundled output; fall back to source.

**Code reuse:** zero changes to `core/`. Adapter is purely glue: stdin parsing → core call → stdout shaping.

---

## 3. Schema mappings

### `beforeShellExecution` → core classifier

Cursor input:
```json
{
  "command": "<full terminal command>",
  "cwd": "<current working directory>",
  "sandbox": false
}
```

Maps to: `classify(command, transcript, modelCall, config, { isMainSession: !sandbox })`. The `sandbox` field tells us whether Cursor is already running this in a containerised sandbox; if true we can be slightly more permissive at Stage 2 (matches the Claude Code adapter's main-session-vs-subagent distinction).

Output mapping (from `core` decision to Cursor):

| `core` decision | Cursor `permission` | `user_message` | `agent_message` |
|---|---|---|---|
| `allow` | `allow` | (omitted) | (omitted) |
| `block` | `deny` | `<reason from core>` | `Blocked by io-auto-mode: <reason>. Reword your task or escalate to the user.` |
| `ask` | `ask` | `<reason from core>` | (omitted — Cursor surfaces ask to the user, not the agent) |

### `beforeReadFile` → file-hook

Cursor input:
```json
{
  "file_path": "<absolute path>",
  "content": "<file contents>",
  "attachments": [{"type": "file | rule", "file_path": "<absolute path>"}]
}
```

Map to file-hook with `tool_name = "Read"`. Output: `{permission: allow|deny, user_message}`. We ignore `content` and `attachments` for v0.1.x (path-based decisions only); future versions could inspect attachments to extend deny zones (e.g. "this file references a .env path even if reading is allowed").

### `preToolUse` (Edit/Write) → file-hook

Cursor input:
```json
{
  "tool_name": "Edit",
  "tool_input": {"file_path": "/abs/path", "..." : "..."},
  "tool_use_id": "abc123",
  "cwd": "/project"
}
```

Match on `tool_name ∈ {Edit, Write}` (the hook also fires for unrelated tool calls; we allow-through any tool we don't recognise rather than block-by-default at this layer). Use `cwd` for `${projectDir}` expansion.

---

## 4. Configuration (user-facing)

User adds to `~/.cursor/hooks.json` (user-level) or `<project>/.cursor/hooks.json` (project-level):

```json
{
  "version": 1,
  "hooks": {
    "beforeShellExecution": [
      {
        "command": "<repo-path>/adapters/cursor/bin/classify-shell.sh",
        "timeout": 8,
        "failClosed": true
      }
    ],
    "beforeReadFile": [
      {
        "command": "<repo-path>/adapters/cursor/bin/classify-file.sh",
        "timeout": 2,
        "failClosed": false
      }
    ],
    "preToolUse": [
      {
        "command": "<repo-path>/adapters/cursor/bin/classify-file.sh",
        "matcher": "Edit|Write",
        "timeout": 2,
        "failClosed": false
      }
    ]
  }
}
```

`failClosed: true` for shell because that's the high-stakes path. The file classifier is fail-open by default (parity with the Claude Code adapter).

API keys live in `~/.io-auto-mode/.env` (same convention as the Claude Code adapter).

---

## 5. Build pipeline

Extend `scripts/build.mjs` with a `cursor` target. Two `esbuild.build()` calls mirroring the Claude Code adapter:

- `adapters/cursor/src/hook.ts` → `adapters/cursor/dist/hook.js`
- `adapters/cursor/src/file-hook.ts` → `adapters/cursor/dist/file-hook.js`

Output paths get `adapters/cursor/dist/` added to `.gitignore` (same pattern as the Claude Code adapter's `dist/`).

---

## 6. Tests

`tests/cursor-hook.test.ts` — pure schema-mapping tests, since the heavy lifting (classifier pipeline, zone matching) is already covered by Tier 1:

- **Input parsing:** `beforeShellExecution` JSON → core args; `beforeReadFile` JSON → file-hook args; `preToolUse` JSON → file-hook args (with `tool_name` routing).
- **Output mapping:** core `allow|block|ask` → Cursor `{permission, user_message, agent_message}`.
- **Matcher routing:** `preToolUse` with `tool_name ∈ {Edit, Write}` hits file-hook; other tool names allow-through silently.
- **Transcript path:** `transcript_path` env var resolved correctly; missing path degrades gracefully to empty context.
- **Sandbox flag:** `sandbox: true` propagates to `isMainSession: false`.

Target: ~30-50 test cases. Picked up automatically by the existing `tsx --test tests/*.test.ts` glob.

---

## 7. INSTALL.md updates

Add `## Cursor` section between `## Claude Code` and `## OpenClaw`. Mirror the Claude Code section structure:

1. **Step 1: Clone, install, build** (same as Claude Code).
2. **Step 2: Provide your API key** (same `~/.io-auto-mode/.env`).
3. **Step 3: Wire the hooks into `~/.cursor/hooks.json`** (full snippet from §4 above).
4. **Step 4: Restart Cursor** (note: hot-reload may pick up changes without restart, but document the safe option).
5. **Step 5: Verify** (`tail -f ~/.io-auto-mode/auto-mode-log.jsonl`, run a test command, see entries land).
6. **Optional: Tab hook setup** (forward-reference to a v0.2 follow-up).

---

## 8. README updates

- File tree: add `adapters/cursor/   Cursor hooks adapter (Agent: shell + file)`.
- Add `## Quick start (Cursor)` sibling to OpenClaw + Claude Code quick starts.
- Roadmap: change `[ ] Cursor adapter` → `[x] Cursor adapter (beforeShellExecution + beforeReadFile + preToolUse)`.
- Tagline / repo description: re-include "Cursor" once the adapter ships.

---

## 9. Implementation phases

| Phase | Scope | Est. |
|---|---|---|
| 1 | `adapters/cursor/src/` — three TypeScript files mirroring claude-code | 1h |
| 2 | `adapters/cursor/bin/` wrapper scripts; build pipeline integration | 30m |
| 3 | `tests/cursor-hook.test.ts` — schema mapping tests | 30m |
| 4 | INSTALL.md `## Cursor` section + README updates + roadmap tick | 30m |
| 5 | Manual smoke test in a real Cursor session if possible; otherwise document as a follow-up TODO | 30m |

**Total:** ~3 hours.

Recommend three commits:
1. `feat(cursor): adapter src + bin wrappers` (phase 1-2 minus tests)
2. `feat(cursor): build pipeline + tests` (phase 2 build + phase 3)
3. `docs(cursor): INSTALL section + README updates` (phase 4)

---

## 10. Acceptance criteria

- A Cursor user can copy the hooks.json snippet from INSTALL.md, restart Cursor, and have classifier decisions appear in `~/.io-auto-mode/auto-mode-log.jsonl`.
- `pnpm test` passes including new cursor-hook tests.
- `pnpm typecheck` clean.
- Zero new runtime dependencies; same `core/` classifier, same `~/.io-auto-mode/config.json` zone config (no Cursor-specific config bifurcation).
- Smoke-tested in at least one real Cursor session, OR a TODO is filed in `BACKLOG.md` with reproduction steps.

---

## 11. Out of scope (deferred)

- **`beforeMCPExecution`** — gated on the planned MCP tool classifier (`[ ]` in the roadmap). Cursor's hook surface is ready when we are.
- **`beforeTabFileRead` / `afterTabFileEdit`** — Tab is autonomous inline completion. Arguably *higher* stakes than Agent (no human in the loop, fires per-keystroke), but doubles the integration surface and the schemas differ (Tab may fire many times per second). Worth a follow-up once we have user feedback on whether Tab coverage is a real ask, and whether the classifier latency budget can absorb that frequency.
- **`subagentStart` / `subagentStop`** — interesting for "audit which subagents fire" but not core to permission classification.
- **`stop` / `sessionStart` / `sessionEnd`** — lifecycle hooks; nothing for a permission classifier to do here.
- **Enterprise-distributed configs** — Cursor supports MDM-distributed `hooks.json` at OS-level paths. Out of scope for OSS v0.1.x; relevant if someone deploys io-auto-mode across a fleet.

---

## 12. Open questions

1. **Hot-reload vs restart.** Cursor's docs imply hooks.json changes might require restart, but it's not explicit. Test both flows and document the truthful path.
2. **`transcript_path` availability.** Cursor only sets this if transcript logging is enabled in the user's settings. We need to handle "no transcript" gracefully — Stage 1 will run with no conversation context, which means slightly more conservative blocks. Acceptable for v0.1.x; document as a known limitation.
3. **`failClosed: true` semantics.** Cursor's docs say `failClosed: true` blocks the action on hook failure. Our `core/classifier.ts` already fails closed on every error path (returns `block` or `ask` as appropriate). The Cursor `failClosed` is a belt-and-braces guard for genuine hook-runtime failures (Node crashes, missing dist, etc.). Verify the interaction during the smoke test.
4. **Loop limit.** Cursor's `loop_limit` (default 5) caps how many times an agent can retry after a denial. For Stage 2 ASK, we'd want this set sensibly so the agent doesn't burn through the budget on a single ambiguous command. Default may be fine; revisit after live use.
