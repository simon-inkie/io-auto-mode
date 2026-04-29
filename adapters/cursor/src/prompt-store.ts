/**
 * Tiny on-disk cache for the most recent user prompt per Cursor conversation.
 *
 * Cursor fires `beforeSubmitPrompt` once per user message and
 * `beforeShellExecution` zero-or-more times after — but each runs in its own
 * Node process, so they can't share memory. We persist the prompt keyed by
 * `conversation_id` and let the shell hook read it back on the next call.
 *
 * Atomic-rename writes; best-effort reads. Fail-open everywhere — a missing or
 * malformed cache file means the classifier runs with empty conversation
 * context (same fall-through as the Claude Code adapter when transcript_path
 * is unavailable). It is never appropriate to block a tool call because the
 * cache layer broke.
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CACHE_DIR = join(homedir(), ".io-auto-mode", "cache", "cursor-prompts");

interface Attachment {
  type: string;
  file_path: string;
}

export interface CachedPrompt {
  capturedAt: string;       // ISO 8601
  conversationId: string;
  prompt: string;
  attachments: Attachment[];
}

function cachePath(conversationId: string): string {
  // Sanitise: conversation IDs are typically UUIDs, but be defensive against
  // path-traversal in case Cursor changes the format. Strip anything that
  // isn't safe for a filename.
  const safe = conversationId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return join(CACHE_DIR, `${safe}.json`);
}

export function writePrompt(payload: CachedPrompt): void {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    // If we can't create the dir, the write below will fail — that's fine,
    // caller handles fail-open.
  }

  const finalPath = cachePath(payload.conversationId);
  const tmpPath = `${finalPath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(payload), "utf-8");
  // Atomic rename — readers either see the old file or the new file, never a
  // half-written one.
  renameSync(tmpPath, finalPath);
}

export function readPrompt(conversationId: string): CachedPrompt | null {
  if (!conversationId) return null;
  const path = cachePath(conversationId);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<CachedPrompt>;
    if (
      typeof parsed.prompt === "string" &&
      typeof parsed.conversationId === "string"
    ) {
      return {
        capturedAt: parsed.capturedAt ?? "",
        conversationId: parsed.conversationId,
        prompt: parsed.prompt,
        attachments: Array.isArray(parsed.attachments) ? parsed.attachments : [],
      };
    }
    return null;
  } catch {
    return null;
  }
}
