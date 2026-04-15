/**
 * Read a Claude Code session transcript from disk and return the tail as
 * ConversationMessage[] (the shape the core transcript serialiser expects).
 *
 * Claude Code transcripts live at:
 *   ~/.claude/projects/<slug>/<session-id>.jsonl
 *
 * The <slug> is the cwd with every `/` replaced by `-`. Each JSONL line is
 * one event (user, assistant, file-history-snapshot, permission-mode, etc.).
 * We extract only `user` and `assistant` turns, capped to the last N.
 *
 * Design principle #2 (context-aware) — prompt-injection hardening is handled
 * downstream in core/transcript.ts (strips assistant freeform text). We just
 * faithfully surface the raw history.
 *
 * Fails soft: missing file / unparseable JSON → empty array. The classifier
 * then runs with no context rather than blocking.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type {
  ConversationMessage,
  AssistantContentBlock,
} from "../../../core/types.js";

const DEFAULT_TAIL = 20;

interface RawLine {
  type?: string;
  message?: {
    role?: "user" | "assistant";
    content?: string | unknown[];
  };
}

export function transcriptPath(cwd: string, sessionId: string): string {
  const slug = cwd.replace(/\//g, "-");
  return join(homedir(), ".claude", "projects", slug, `${sessionId}.jsonl`);
}

export function readClaudeTranscript(
  cwd: string,
  sessionId: string,
  tail: number = DEFAULT_TAIL,
): ConversationMessage[] {
  const path = transcriptPath(cwd, sessionId);
  if (!existsSync(path)) return [];

  let content: string;
  try {
    content = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const messages: ConversationMessage[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let parsed: RawLine;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }

    if (parsed.type !== "user" && parsed.type !== "assistant") continue;
    const msg = parsed.message;
    if (!msg?.role) continue;

    if (msg.role === "user") {
      const content = normaliseUserContent(msg.content);
      if (content === null) continue;
      messages.push({ role: "user", content, source: "direct" });
    } else if (msg.role === "assistant") {
      const blocks = normaliseAssistantContent(msg.content);
      if (!blocks || blocks.length === 0) continue;
      messages.push({ role: "assistant", content: blocks });
    }
  }

  return messages.slice(-tail);
}

function normaliseUserContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() ? content : null;
  if (Array.isArray(content)) {
    // User turns can contain tool_result blocks; extract any text content
    const parts: string[] = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "type" in block &&
        block.type === "text" &&
        "text" in block &&
        typeof (block as { text: string }).text === "string"
      ) {
        parts.push((block as { text: string }).text);
      }
    }
    const joined = parts.join("\n").trim();
    return joined || null;
  }
  return null;
}

function normaliseAssistantContent(
  content: unknown,
): AssistantContentBlock[] | null {
  if (typeof content === "string") {
    return content.trim() ? [{ type: "text", text: content }] : null;
  }
  if (!Array.isArray(content)) return null;

  const blocks: AssistantContentBlock[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object" || !("type" in block)) continue;
    const b = block as Record<string, unknown>;
    if (b.type === "text" && typeof b.text === "string") {
      blocks.push({ type: "text", text: b.text });
    } else if (b.type === "tool_use" && typeof b.name === "string") {
      blocks.push({
        type: "tool_use",
        name: b.name,
        input: b.input,
      });
    }
  }
  return blocks;
}
