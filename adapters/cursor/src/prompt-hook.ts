/**
 * io-auto-mode — Cursor `beforeSubmitPrompt` hook handler.
 *
 * Cursor fires this hook after the user hits send, before the request goes
 * to the backend. We use it to capture the user's prompt + attachments and
 * stash them in `~/.io-auto-mode/cache/cursor-prompts/<conversation_id>.json`
 * so the next `beforeShellExecution` (or `preToolUse`) call can read them
 * back as conversation context for the classifier.
 *
 * This is what gives Cursor parity with Claude Code's `transcript_path`
 * pipeline for prompt-injection hardening — same guarantee, different
 * mechanism.
 *
 * This hook NEVER blocks. Its only job is to capture context. Even if the
 * cache write fails, we return `permission: "allow"` and let the user submit
 * their prompt — denying based on a cache failure would be a worse UX than
 * just running with degraded context on the next call.
 */

import { writePrompt } from "./prompt-store.js";

interface CursorBeforeSubmitPromptInput {
  conversation_id?: string;
  generation_id?: string;
  hook_event_name?: string;
  prompt?: string;
  attachments?: Array<{ type: string; file_path: string }>;
  cursor_version?: string;
}

interface CursorAllowOutput {
  permission: "allow";
}

function emit(output: CursorAllowOutput): never {
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(0);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

async function main() {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    return emit({ permission: "allow" }); // fail-open
  }

  let input: CursorBeforeSubmitPromptInput;
  try {
    input = JSON.parse(raw) as CursorBeforeSubmitPromptInput;
  } catch {
    return emit({ permission: "allow" });
  }

  const conversationId = input.conversation_id;
  const prompt = input.prompt;
  if (!conversationId || typeof prompt !== "string") {
    return emit({ permission: "allow" });
  }

  try {
    writePrompt({
      capturedAt: new Date().toISOString(),
      conversationId,
      prompt,
      attachments: Array.isArray(input.attachments) ? input.attachments : [],
    });
  } catch {
    // Non-fatal — see the comment at the top of the file.
  }

  emit({ permission: "allow" });
}

// Resolve symlinks for npm `bin` symlink invocation (see hook.ts comment).
import { realpathSync } from "node:fs";
let mainEntryReal: string;
try {
  mainEntryReal = realpathSync(process.argv[1]);
} catch {
  mainEntryReal = process.argv[1];
}
const isMainModule = import.meta.url === `file://${mainEntryReal}`;
if (isMainModule) {
  main().catch(() => emit({ permission: "allow" }));
}
