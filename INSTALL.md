# io-auto-mode — Installation Guide

A hybrid static + LLM exec security classifier for AI coding agents.
Intercepts every shell command and file-tool call before execution and
classifies it as allow / ask / block.

Two adapters are supported:

- [Claude Code](#claude-code) — `PreToolUse` hooks (Bash + Read/Write/Edit)
- [OpenClaw](#openclaw) — `before_tool_call` plugin

Pick whichever runtime you use; both share the same `core/` classifier.

---

## Requirements

- Node.js 22+
- A Google Gemini API key (defaults use `gemini-2.5-flash` for all stages —
  fast, cheap, and accurate enough for classification). You can swap providers
  via config; see Configuration Reference below.
- For the OpenClaw adapter: OpenClaw **2026.4.2+**.

---

## Claude Code

Hooks register at `PreToolUse` for `Bash` (LLM-backed, fail-closed) and
`Read|Write|Edit` (path-based, sub-millisecond). All decisions log to
`~/.io-auto-mode/auto-mode-log.jsonl`.

### Step 1: Clone, install, build

```bash
git clone https://github.com/simon-inkie/io-auto-mode.git
cd io-auto-mode
pnpm install
node scripts/build.mjs
```

The build emits `adapters/claude-code/dist/hook.js` and
`adapters/claude-code/dist/file-hook.js`. The wrapper scripts at
`adapters/claude-code/bin/` will use these by default and fall back to running
the TypeScript directly via `tsx` if you're hacking on the adapter.

### Step 2: Provide your API key

Claude Code hooks run in a sandboxed environment that doesn't inherit your
shell's environment variables. Drop your key into a `.env` file the hook can
read:

```bash
mkdir -p ~/.io-auto-mode
cat > ~/.io-auto-mode/.env <<'EOF'
GEMINI_API_KEY=your-google-gemini-key-here
EOF
chmod 600 ~/.io-auto-mode/.env
```

Anthropic / OpenAI / other provider keys go in the same file if you've
configured those models. The legacy path `~/io-data/.env` is also accepted
for back-compat.

### Step 3: Wire the hooks into `~/.claude/settings.json`

Add the following under `hooks.PreToolUse` in `~/.claude/settings.json`,
substituting `<repo-path>` for the absolute path you cloned to:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "<repo-path>/adapters/claude-code/bin/classify.sh",
            "timeout": 8,
            "async": false
          }
        ]
      },
      {
        "matcher": "Read|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "<repo-path>/adapters/claude-code/bin/classify-file.sh",
            "timeout": 2,
            "async": false
          }
        ]
      }
    ]
  }
}
```

If you already have `PreToolUse` entries for other tools, merge — don't
overwrite. The two `matcher` keys (`Bash` and `Read|Write|Edit`) target
different tool-call types and are independent.

### Step 4: Restart your Claude Code session

Hook config is read at session start. Quit and re-launch `claude`.

### Step 5: Verify

In a Claude Code session, ask the agent to run a benign command (e.g. `ls`).
You should see no prompt — the static-allow pattern fires at sub-millisecond.
Then check the log:

```bash
tail -f ~/.io-auto-mode/auto-mode-log.jsonl
```

You should see one entry per tool call, with `stage`, `decision`, and
`durationMs` fields.

### Optional: configure file zones

By default, the file-hook denies access to `~/.ssh/`, `~/.aws/`, `~/.gnupg/`,
`/etc/`, `/usr/`, etc., and only allows reads/writes inside the project
directory + `/tmp/`. To extend either list, create `~/.io-auto-mode/config.json`:

```json
{
  "fileZones": {
    "allowRead": ["~/git-repos/**"],
    "allowWrite": ["~/scratch/**"]
  }
}
```

Or `<project>/.io-auto-mode.json` for project-scoped overrides. Layers merge
additively; the global deny list cannot be weakened.

---

## OpenClaw

Reference implementation. Plugin loads from source at runtime; no pre-build
step needed.

---

### Step 1: Register your AI provider key

**Do NOT use `openclaw onboard`** — it reruns the full setup wizard.

Use `openclaw models auth login` instead. It picks up existing env vars
automatically and doesn't touch your default model:

```bash
# Google / Gemini (used by default config for all stages)
openclaw models auth login --provider google --method gemini-api-key
```

This will detect an existing `GEMINI_API_KEY` env var and prompt to confirm.
Omit `--set-default` to keep your current default model. If you'd rather route
some stages through Anthropic, OpenAI, etc., register those provider keys too
and set the model strings in config (see Configuration Reference).

---

### Step 2: Add plugin to `openclaw.json`

Add to `plugins.load.paths` so OpenClaw discovers it on startup:

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/io-auto-mode"]
    },
    "entries": {
      "io-auto-mode": {
        "enabled": true,
        "config": {
          "mode": "classify",
          "stage1Model": "google/gemini-2.5-flash",
          "stage1Fallback": "google/gemini-2.5-flash",
          "stage2Model": "google/gemini-2.5-flash",
          "stage2Fallback": "google/gemini-2.5-flash"
        }
      }
    }
  }
}
```

Or use the gateway config patch command:

```bash
openclaw config patch '{"plugins":{"load":{"paths":["/path/to/io-auto-mode"]},"entries":{"io-auto-mode":{"enabled":true,"config":{"mode":"classify"}}}}}'
```

---

### Step 3: Restart gateway

```bash
openclaw gateway restart
```

---

### Step 4: Verify

Check the classifier is running and logging decisions:

```bash
tail -f ~/.openclaw/workspace/memory/auto-mode-log.jsonl
```

Run a test command — you should see a log entry with `stage` and `decision`.

```bash
openclaw plugins list  # should appear as static allow at 0ms
```

---

## Configuration Reference

All options live under `plugins.entries.io-auto-mode.config`:

| Option | Default | Description |
|--------|---------|-------------|
| `mode` | `classify` | `classify` (normal), `yolo` (allow all), `strict` (block unless on allowlist) |
| `stage1Model` | `google/gemini-2.5-flash` | Fast LLM for Stage 1 classification |
| `stage1Fallback` | `google/gemini-2.5-flash` | Fallback if Stage 1 model unavailable |
| `stage2Model` | `google/gemini-2.5-flash` | Thinking LLM for Stage 2 (escalated blocks) |
| `stage2Fallback` | `google/gemini-2.5-flash` | Fallback if Stage 2 model unavailable |
| `userAllowPatterns` | `[]` | Additional regex patterns to always allow |
| `userBlockPatterns` | `[]` | Additional regex patterns to always block |

---

## Behaviour

| Outcome | What happens |
|---------|-------------|
| **allow** | Command runs silently |
| **ask** | Native approval overlay — you decide |
| **block** | Command refused with reason |

When classifier models are unavailable (API down, key missing):
- **Main session** (you present): surfaces as **ask** — you can approve
- **Sub-agents** (unattended): auto **block** — safe default

---

## Troubleshooting

### All exec calls are blocked / getting constant "ask" prompts
Classifier models are unavailable. Check `auto-mode-log.jsonl` for `stage: error` entries.
Fix: ensure provider keys are registered (Step 1).

### Deadlock — can't run any commands
Disable the plugin directly in `openclaw.json` (`enabled: false`) and restart:
```bash
# Run this in your terminal (not via your agent — it's locked out too!)
python3 -c "
import json, os
p = os.path.expanduser('~/.openclaw/openclaw.json')
with open(p) as f: cfg = json.load(f)
cfg['plugins']['entries']['io-auto-mode']['enabled'] = False
with open(p, 'w') as f: json.dump(cfg, f, indent=2)
print('disabled')
" && openclaw gateway restart
```

### Need to temporarily disable classification
Set `mode: "yolo"` in config and restart. All exec calls pass through, no classification.

### Latency is high (>500ms per command)
Extend the static ALLOW patterns in `src/static-patterns.ts` to cover more of
your common commands. Static matches resolve at 0ms before any LLM call.

---

## Decision Log

Every classification is logged to:
```
~/.openclaw/workspace/memory/auto-mode-log.jsonl
```

Each entry includes: timestamp, command, stage (static/stage1/stage2/error),
decision, duration, model used, and chain-of-thought reasoning (Stage 2).
