# io-auto-mode — Installation Guide

A hybrid static + LLM exec security classifier for OpenClaw. Intercepts every
shell command before execution and classifies it as allow / ask / block.

---

## Requirements

- OpenClaw **2026.4.2+**
- Node.js 22+
- A Google Gemini API key (defaults use `gemini-2.5-flash` for all stages —
  fast, cheap, and accurate enough for classification). You can swap providers
  via config; see Configuration Reference below.

---

## Step 1: Register your AI provider key

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

## Step 2: Add plugin to `openclaw.json`

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

## Step 3: Restart gateway

```bash
openclaw gateway restart
```

---

## Step 4: Verify

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
