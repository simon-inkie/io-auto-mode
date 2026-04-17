# io-auto-mode — ai-sdk Migration Spec

**Status:** spec, not started
**Date:** 2026-04-17
**Goal:** replace raw `fetch()` model calls with Vercel ai-sdk so every classifier stage becomes provider-agnostic in one line, unlocks local models (Ollama/LM Studio/llama.cpp), and gains streaming + tool-call parity for free.

---

## 1. Why

Current state:
- `adapters/openclaw/src/plugin.ts` — raw `fetch()` to `generativelanguage.googleapis.com` or `api.anthropic.com`, chosen by splitting `"provider/modelId"` on the first `/`.
- `adapters/claude-code/src/model-call.ts` — same pattern, duplicated.
- Adding a new provider = new fetch branch + new request/response shape code in both adapters.
- Local model support = writing an Ollama-specific fetch branch.

Design strength already in place: `core/classifier.ts` doesn't call any HTTP — it takes a `ModelCallFn` injection (`core/types.ts:70`). Adapter owns the HTTP. So swapping the implementation is one-file-per-adapter.

`ai-sdk` collapses the per-provider fetch code into one `generateText({ model, prompt })` call. Every provider it ships (OpenAI, Anthropic, Google, Mistral, xAI, Groq, Cohere, DeepSeek, Azure, Bedrock, Vertex) + the `@ai-sdk/openai-compatible` shim for every OpenAI-compatible endpoint (Ollama, LM Studio, vLLM, llama.cpp, OpenRouter) works the same way.

## 2. Non-goals

- **Not changing the `ModelCallFn` signature.** Core stays untouched. `ModelCallOptions`/return `Promise<string>` is the contract; ai-sdk becomes the implementation detail of the adapter's `modelCallFn`.
- **Not adopting streaming.** Classifier calls are one-shot text. No reason to introduce complexity.
- **Not adopting tool calls.** Stage 2 returns JSON-in-text; parse it ourselves. ai-sdk's `generateObject` might come later but is out of scope.
- **Not a perf play.** Latency is dominated by the LLM, not the SDK.

---

## 3. Proposed shape

### 3.1 New shared core helper

Add `core/model-call-ai-sdk.ts` (new file, opt-in — not wired into existing core exports). Signature mirrors `ModelCallFn` so adapters can drop it in.

```ts
import { generateText, type LanguageModel } from "ai";
import type { ModelCallFn, ModelCallOptions } from "./types.js";

export function createAiSdkModelCall(
  resolveModel: (name: string) => LanguageModel,
): ModelCallFn {
  return async (opts: ModelCallOptions): Promise<string> => {
    const model = resolveModel(opts.model);
    const result = await generateText({
      model,
      system: opts.system,
      messages: opts.messages,
      maxOutputTokens: opts.maxTokens,
      temperature: opts.temperature,
    });
    return result.text;
  };
}
```

`resolveModel` is adapter-provided: it maps the config string (e.g. `"google/gemini-2.5-flash"`, `"ollama/llama3.2"`, `"openrouter/anthropic/claude-haiku-4-5"`) to an ai-sdk `LanguageModel` instance. That keeps the *how-to-route* logic in the adapter layer, consistent with today's `api.runtime.modelAuth.resolveApiKeyForProvider` pattern.

### 3.2 Provider registry

`core/model-registry.ts` — a thin provider-string → ai-sdk factory map. Exposed as a pure function so both adapters reuse it.

```ts
import { google } from "@ai-sdk/google";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export function resolveModel(modelString: string, apiKeys: ApiKeyLookup) {
  const [provider, ...rest] = modelString.split("/");
  const modelId = rest.join("/");

  switch (provider) {
    case "google":
    case "gemini":
      return google(modelId, { apiKey: apiKeys("google") });
    case "anthropic":
      return anthropic(modelId, { apiKey: apiKeys("anthropic") });
    case "openai":
      return openai(modelId, { apiKey: apiKeys("openai") });
    case "ollama":
      return createOpenAICompatible({
        name: "ollama",
        baseURL: process.env.OLLAMA_BASE_URL ?? "http://localhost:11434/v1",
      })(modelId);
    case "lmstudio":
      return createOpenAICompatible({
        name: "lmstudio",
        baseURL: process.env.LMSTUDIO_BASE_URL ?? "http://localhost:1234/v1",
      })(modelId);
    case "openrouter":
      return createOpenAICompatible({
        name: "openrouter",
        baseURL: "https://openrouter.ai/api/v1",
        apiKey: apiKeys("openrouter"),
      })(modelId);
    default:
      throw new Error(`Unknown provider: ${provider}`);
  }
}
```

`ApiKeyLookup = (provider: string) => string | undefined` — adapter-provided. OpenClaw adapter wires it to `api.runtime.modelAuth.resolveApiKeyForProvider`; Claude Code adapter reads from `process.env`.

### 3.3 Adapter wiring

**Claude Code** (`adapters/claude-code/src/hook.ts`) — replace the `import { modelCall } from "./model-call.js"` path with:

```ts
import { createAiSdkModelCall } from "../../../core/model-call-ai-sdk.js";
import { resolveModel } from "../../../core/model-registry.js";

const apiKeys = (p: string) => {
  if (p === "google" || p === "gemini") return process.env.GEMINI_API_KEY;
  if (p === "anthropic") return process.env.ANTHROPIC_API_KEY;
  if (p === "openai") return process.env.OPENAI_API_KEY;
  if (p === "openrouter") return process.env.OPENROUTER_API_KEY;
  return undefined;
};
const modelCall = createAiSdkModelCall((m) => resolveModel(m, apiKeys));
```

**OpenClaw** (`adapters/openclaw/src/plugin.ts`) — `apiKeys` wraps OpenClaw's async `modelAuth.resolveApiKeyForProvider` (will need to be awaited at startup and cached, or wrapped sync via a preloaded map — design decision at implementation time).

Delete `adapters/claude-code/src/model-call.ts` and the provider-specific fetch block in `plugin.ts` once the new path is proven.

---

## 4. Config changes

### 4.1 Expanded default config strings

`core/types.ts::DEFAULT_CONFIG` stays the same — model strings are opaque to core. Users override in `~/.io-auto-mode/config.json`:

```jsonc
{
  "stage1Model": "ollama/llama3.2:3b",
  "stage1Fallback": "google/gemini-2.5-flash",
  "stage2Model": "anthropic/claude-haiku-4-5",
  "stage2Fallback": "openrouter/deepseek/deepseek-r1"
}
```

The format is stable (`provider/modelId`); adapters understand every provider the registry knows.

### 4.2 New env vars

| Var | Purpose |
|---|---|
| `OLLAMA_BASE_URL` | override local Ollama host (default `http://localhost:11434/v1`) |
| `LMSTUDIO_BASE_URL` | override LM Studio host (default `http://localhost:1234/v1`) |
| `OPENROUTER_API_KEY` | OpenRouter key |
| `OPENAI_API_KEY` | for openai/* models |

Existing `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` unchanged.

---

## 5. Package changes

`package.json` additions:

```jsonc
"dependencies": {
  "ai": "^4.x",
  "@ai-sdk/google": "^1.x",
  "@ai-sdk/anthropic": "^1.x",
  "@ai-sdk/openai": "^1.x",
  "@ai-sdk/openai-compatible": "^1.x",
  "openclaw": "^2026.4.2"
}
```

Tree-shake note: esbuild bundles only the adapters referenced at runtime. The @ai-sdk/* packages each gate their HTTP client behind the `createX()` factory, so unused providers don't inflate the bundle meaningfully.

---

## 6. Local-model validation matrix

Once wired, sanity-check each backend with a short fixture conversation through `benchmarks/runner.ts`:

| Stage | Model under test | Expected latency | Notes |
|---|---|---|---|
| Stage 1 | `ollama/llama3.2:3b` | < 500ms on M-series / RTX | Fast path — good enough for obvious allows |
| Stage 1 | `ollama/qwen2.5-coder:7b` | ~1s | Better command understanding |
| Stage 2 | `ollama/deepseek-r1:8b` | 3-5s | Thinking model, JSON output |
| Stage 2 | `lmstudio/gpt-oss-20b` | varies | User's local 20B test |
| Fallback | `google/gemini-2.5-flash` | 200-400ms | Unchanged, cloud safety net |

The validation gate: classifier decisions match the cloud-model baseline on `benchmarks/fixtures/` ± 1-2 edge cases. Don't chase 100% parity on small local models.

---

## 7. Implementation phases

| Phase | Task | Est. |
|---|---|---|
| 0 | Add `ai` + `@ai-sdk/*` deps; create `core/model-call-ai-sdk.ts` + `core/model-registry.ts`; unit tests with a mock provider. | 1-1.5h |
| 1 | Wire Claude Code adapter to the new path; parallel-run (both paths alive, flag-gated by `process.env.IO_AUTO_MODE_USE_AI_SDK=1`); benchmark against existing for 1-2 days. | 1h |
| 2 | Wire OpenClaw adapter the same way, including async key resolution. | 1.5h |
| 3 | Flip the flag on by default; delete the raw-fetch path; rebuild both dist/ trees; reinstall. | 30m |
| 4 | Local-model pass: install Ollama, pull llama3.2 + deepseek-r1, update `~/.io-auto-mode/config.json` to route Stage 1 locally, run benchmarks, compare decision parity. | 2-3h |
| 5 | OpenRouter trial: sign up, fund $5, point Stage 2 at `openrouter/deepseek/deepseek-r1`, compare cost/latency vs direct Gemini. | 1h |
| 6 | Update `INSTALL.md`, `CLAUDE-CODE-PORT-SPEC.md`, this spec — mark complete. | 30m |

**Total: ~7-10h.** One sitting, or two half-days.

---

## 8. Success criteria

1. `IO_AUTO_MODE_USE_AI_SDK=1` flag-flip works end-to-end without behaviour regression on fixture benchmarks.
2. At least one local model (Ollama) handles Stage 1 classification for safe patterns without fallback to cloud.
3. Zero changes to `core/classifier.ts` or `core/static-patterns.ts` — the migration is adapter-local.
4. `dist/` bundle sizes grow by < 2MB (ai-sdk is tree-shakeable).
5. OpenRouter access proven as a viable Stage 2 fallback at < 50% Gemini cost for comparable latency.

---

## 9. Open questions

- **Async key resolution in OpenClaw adapter.** Current code awaits `resolveApiKeyForProvider` inside the fetch handler. With ai-sdk, the key needs to be available when the `LanguageModel` is constructed. Options: (a) resolve all keys at plugin init and cache, (b) wrap `resolveModel` as async and adjust `ModelCallFn`. (a) is simpler.
- **Reasoning content for thinking models.** DeepSeek-R1 on Ollama emits reasoning in `<think>` tags. ai-sdk's `providerMetadata.reasoning` may or may not capture this — needs a quick probe before committing to DeepSeek for Stage 2.
- **Cost telemetry.** OpenClaw's `auto-mode-log.jsonl` currently logs `stage, model, durationMs`. ai-sdk gives us `usage.{inputTokens,outputTokens}` — worth plumbing through to the log so we can compare actual spend per provider.

---

## 10. Related

- Spec for MCP hook: `MCP-HOOK-SPEC.md` (independent, can ship in parallel)
- Spec for Claude Code port: `CLAUDE-CODE-PORT-SPEC.md` (done)
- Injection point for this migration: `core/types.ts:70` (`ModelCallFn`) — unchanged
