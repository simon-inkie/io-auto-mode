/**
 * io-auto-mode — Claude Code PreToolUse hook handler (Bash matcher).
 *
 * Flow:
 *   stdin → hook event JSON → extract Bash command + session info
 *     → read Claude Code transcript tail from disk
 *     → serialise to the core classifier's TranscriptEntry shape
 *     → run classify() — static patterns + Stage 1 (fast LLM) + Stage 2 (thinking)
 *     → map core's Decision (allow/ask/block) → Claude's permissionDecision
 *     → stdout → Claude Code uses it to allow/deny/ask
 *
 * Fail-closed: any uncaught error → deny. Never throws to Claude Code.
 */

// Load API keys from ~/io-data/.env before anything else. Claude Code hooks
// run in a sandboxed env that doesn't inherit the user's shell vars.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
try {
  const envPath = resolve(homedir(), "io-data", ".env");
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const match = line.match(/^([^#]\w*)=(.+)$/);
    if (match && !process.env[match[1]]) {
      process.env[match[1]] = match[2].trim();
    }
  }
} catch { /* .env not found — keys must already be in env */ }

import { classify } from "../../../core/classifier.js";
import { serialiseTranscript } from "../../../core/transcript.js";
import { logDecision, setLogPath } from "../../../core/logger.js";
import { DEFAULT_CONFIG } from "../../../core/types.js";
import type {
  ClassifierConfig,
  ClassifierDecision,
  Decision,
} from "../../../core/types.js";
import { readClaudeTranscript } from "./read-transcript.js";
import { modelCall } from "./model-call.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string };
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
}

function emit(output: HookOutput): never {
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(0);
}

function failClosed(reason: string): never {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `io-auto-mode: ${reason}`,
    },
  });
}

// Core's three-tier `Decision` ('allow' | 'ask' | 'block') maps directly to
// Claude Code's `permissionDecision` ('allow' | 'ask' | 'deny'). Keep the
// mapping explicit so it's obvious at review time.
function mapDecision(d: Decision): "allow" | "ask" | "deny" {
  if (d === "allow") return "allow";
  if (d === "ask") return "ask";
  return "deny";
}

function reasonFrom(result: ClassifierDecision): string {
  const parts = [`stage=${result.stage}`];
  if (result.model) parts.push(`model=${result.model}`);
  parts.push(`${result.durationMs}ms`);
  if (result.reason) parts.push(result.reason);
  return parts.join(" · ");
}

function loadConfig(): ClassifierConfig {
  const candidates = [
    process.env.IO_AUTO_MODE_CONFIG,
    resolve(homedir(), ".io-auto-mode", "config.json"),
    process.env.CLAUDE_PLUGIN_ROOT
      ? resolve(process.env.CLAUDE_PLUGIN_ROOT, "config.json")
      : null,
  ].filter((p): p is string => typeof p === "string" && p.length > 0);

  for (const path of candidates) {
    try {
      const raw = readFileSync(path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ClassifierConfig>;
      return { ...DEFAULT_CONFIG, ...parsed };
    } catch {
      // try next candidate
    }
  }
  return DEFAULT_CONFIG;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  // Route logs to a stable user-wide path so all Claude Code invocations
  // append to the same file regardless of cwd.
  setLogPath(resolve(homedir(), ".io-auto-mode", "auto-mode-log.jsonl"));

  let raw: string;
  try {
    raw = await readStdin();
  } catch (err) {
    return failClosed(`failed to read stdin: ${err}`);
  }

  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch (err) {
    return failClosed(`invalid hook JSON: ${err}`);
  }

  const command = input.tool_input?.command?.trim();
  if (!command) {
    // No command to classify — safer to allow empty/absent than deny. This
    // shouldn't happen for a matched Bash tool call, but belt-and-braces.
    return emit({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "io-auto-mode: empty command",
      },
    });
  }

  const cwd = input.cwd ?? process.cwd();
  const sessionId = input.session_id ?? "";

  const messages = sessionId
    ? readClaudeTranscript(cwd, sessionId)
    : [];
  const transcript = serialiseTranscript(messages);
  const config = loadConfig();

  let result: ClassifierDecision;
  try {
    result = await classify(command, transcript, modelCall, config, {
      isMainSession: true,
      source: "direct",
    });
  } catch (err) {
    return failClosed(`classifier threw: ${err}`);
  }

  try {
    logDecision(command, result, "direct");
  } catch {
    // Log failure is non-fatal; continue with the decision.
  }

  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: mapDecision(result.decision),
      permissionDecisionReason: reasonFrom(result),
    },
  });
}

main().catch((err) => failClosed(`unhandled: ${err}`));
