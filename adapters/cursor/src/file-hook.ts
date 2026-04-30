/**
 * io-auto-mode — Cursor file-tool hook handler.
 *
 * Multiplexes two Cursor hooks onto our shared path-based file classifier:
 *
 *   - `beforeReadFile` — Agent file reads. Schema: `permission: "allow" | "deny"`
 *     (no `ask`!). Maps to file-hook with tool_name = "Read". Core's `ask`
 *     decisions are collapsed to `deny` since Cursor's schema cannot express
 *     ask here. This matches the project's fail-closed posture.
 *
 *   - `preToolUse` — Agent tool calls; we only handle Edit and Write here
 *     (matcher set in hooks.json). Read is in beforeReadFile, Shell is in
 *     beforeShellExecution. Other tool names allow-through silently. Schema:
 *     `permission: "allow" | "deny" | "ask"`.
 *
 * The hook auto-detects which Cursor hook fired by inspecting the input
 * shape (presence of `tool_name` vs `file_path` at the top level), so the
 * same compiled JS handles both via the single `bin/classify-file.sh` entry.
 *
 * Pure path-based classification — no LLM, sub-millisecond. Same zone-merge
 * semantics as the Claude Code file-hook (defaults + global + per-project,
 * all additive; deny list never weakened).
 */

import { readFileSync, realpathSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const HOME = homedir();

interface FileZones {
  deny: string[];
  allowRead: string[];
  allowWrite: string[];
}

const DEFAULT_ZONES: FileZones = {
  deny: [
    "~/.ssh/**",
    "~/.aws/**",
    "~/.gnupg/**",
    "~/.config/gh/hosts.yml",
    "~/.cursor/hooks.json",
    "~/.claude/settings.json",
    "~/io-data/.env",
    "~/.io-auto-mode/.env",
    "/etc/**",
    "/usr/**",
    "/boot/**",
    "/sys/**",
    "/proc/**",
  ],
  allowRead: [
    "${projectDir}/**",
    "~/git-repos/**",
    "~/io-projects/**",
    "/tmp/**",
  ],
  allowWrite: [
    "${projectDir}/**",
    "/tmp/**",
  ],
};

// ---- Cursor input shapes ----

interface CursorBeforeReadFileInput {
  file_path?: string;
  content?: string;
  conversation_id?: string;
  cwd?: string;
}

interface CursorPreToolUseInput {
  tool_name?: string;
  tool_input?: { file_path?: string };
  tool_use_id?: string;
  cwd?: string;
  conversation_id?: string;
}

interface CursorPermissionOutput {
  permission: "allow" | "deny" | "ask";
  user_message?: string;
  agent_message?: string;
}

function emit(output: CursorPermissionOutput): never {
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(0);
}

// ---- Config loading + merge (mirrors Claude Code adapter exactly) ----

function loadJsonSafe<T>(path: string): Partial<T> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<T>;
  } catch {
    return null;
  }
}

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

function mergeZones(base: FileZones, overlay: Partial<FileZones>, immutableDeny: string[]): FileZones {
  const deny = immutableDeny;
  const allowRead = dedup([
    ...base.allowRead,
    ...(overlay.allowRead ?? []),
  ]);
  const allowWrite = dedup([
    ...base.allowWrite,
    ...(overlay.allowWrite ?? []),
  ]);
  return { deny, allowRead, allowWrite };
}

function loadConfig(projectDir: string): FileZones {
  let zones: FileZones = { ...DEFAULT_ZONES };
  let immutableDeny = [...DEFAULT_ZONES.deny];

  const globalPath = join(HOME, ".io-auto-mode", "config.json");
  const globalCfg = loadJsonSafe<{ fileZones?: Partial<FileZones> }>(globalPath);
  if (globalCfg?.fileZones) {
    if (globalCfg.fileZones.deny) {
      immutableDeny = dedup([...immutableDeny, ...globalCfg.fileZones.deny]);
    }
    zones = mergeZones(zones, globalCfg.fileZones, immutableDeny);
  }

  const projectPath = join(projectDir, ".io-auto-mode.json");
  const projectCfg = loadJsonSafe<{ fileZones?: Partial<FileZones> }>(projectPath);
  if (projectCfg?.fileZones) {
    if (projectCfg.fileZones.deny) {
      immutableDeny = dedup([...immutableDeny, ...projectCfg.fileZones.deny]);
    }
    zones = mergeZones(zones, projectCfg.fileZones, immutableDeny);
  }

  return zones;
}

// ---- Path matching ----

function expandPattern(pattern: string, projectDir: string): string {
  return pattern
    .replace(/\$\{projectDir\}/g, projectDir)
    .replace(/^~(?=\/|$)/, HOME);
}

function matchesGlob(filePath: string, pattern: string): boolean {
  const expanded = pattern;
  if (filePath === expanded) return true;
  if (!expanded.includes("*")) {
    return filePath === expanded || filePath.startsWith(expanded + "/");
  }
  const regexBody = expanded
    .split(/(\*\*|\*)/)
    .map((chunk) => {
      if (chunk === "**") return ".*";
      if (chunk === "*") return "[^/]*";
      return chunk.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
    })
    .join("");
  try {
    return new RegExp(`^${regexBody}$`).test(filePath);
  } catch {
    return false;
  }
}

function matchesAnyPattern(filePath: string, patterns: string[], projectDir: string): boolean {
  for (const pattern of patterns) {
    const expanded = expandPattern(pattern, projectDir);
    if (matchesGlob(filePath, expanded)) return true;
  }
  return false;
}

function normalisePath(rawPath: string): string {
  let resolved = rawPath.replace(/^~(?=\/|$)/, HOME);
  resolved = resolve(resolved);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // File may not exist yet (Write creates new files) — use resolved path.
  }
  return resolved;
}

// ---- Classification ----

function classify(
  filePath: string,
  toolName: "Read" | "Write",
  projectDir: string,
  zones: FileZones,
): { decision: "allow" | "deny" | "ask"; reason: string } {
  const normalised = normalisePath(filePath);

  if (matchesAnyPattern(normalised, zones.deny, projectDir)) {
    return { decision: "deny", reason: `denied path: ${normalised}` };
  }

  if (toolName === "Read") {
    if (matchesAnyPattern(normalised, zones.allowRead, projectDir)) {
      return { decision: "allow", reason: `allowed read: ${normalised}` };
    }
  } else {
    if (matchesAnyPattern(normalised, zones.allowWrite, projectDir)) {
      return { decision: "allow", reason: `allowed write: ${normalised}` };
    }
  }

  return { decision: "ask", reason: `unknown path, requesting approval: ${normalised}` };
}

// ---- Logging ----

function logFileDecision(
  filePath: string,
  toolName: string,
  decision: string,
  reason: string,
  conversationId?: string,
): void {
  try {
    const logPath = join(HOME, ".io-auto-mode", "auto-mode-log.jsonl");
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      type: "file",
      adapter: "cursor",
      tool: toolName,
      path: filePath,
      decision,
      reason,
      conversationId,
    });
    mkdirSync(join(HOME, ".io-auto-mode"), { recursive: true });
    appendFileSync(logPath, entry + "\n");
  } catch {
    // Non-fatal — keep classification working even if logging dies.
  }
}

// ---- stdin / dispatch ----

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

interface DispatchResult {
  filePath: string | undefined;
  toolName: "Read" | "Write" | null; // null = allow-through (unknown tool)
  cwd: string;
  conversationId: string | undefined;
}

function dispatch(input: unknown): DispatchResult {
  const obj = (input ?? {}) as CursorBeforeReadFileInput & CursorPreToolUseInput;
  const cwd = typeof obj.cwd === "string" ? obj.cwd : process.cwd();
  const conversationId = typeof obj.conversation_id === "string" ? obj.conversation_id : undefined;

  // preToolUse-shaped input has top-level `tool_name`. Match Edit|Write only;
  // Read is handled by beforeReadFile, Shell by beforeShellExecution. Anything
  // else allow-throughs (we return toolName=null and the caller emits allow).
  if (typeof obj.tool_name === "string") {
    const tn = obj.tool_name;
    if (tn === "Edit" || tn === "Write") {
      return {
        filePath: obj.tool_input?.file_path,
        toolName: "Write", // both Edit and Write share the allowWrite zone
        cwd,
        conversationId,
      };
    }
    return { filePath: undefined, toolName: null, cwd, conversationId };
  }

  // beforeReadFile-shaped input has top-level `file_path` (no tool_name).
  if (typeof obj.file_path === "string") {
    return {
      filePath: obj.file_path,
      toolName: "Read",
      cwd,
      conversationId,
    };
  }

  return { filePath: undefined, toolName: null, cwd, conversationId };
}

async function main() {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    return emit({ permission: "allow" });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emit({ permission: "allow" });
  }

  const { filePath, toolName, cwd, conversationId } = dispatch(parsed);

  if (toolName === null || !filePath) {
    // Either an unknown tool (matcher misconfig) or no path provided — fall
    // through to allow rather than block-by-default at this layer.
    return emit({ permission: "allow" });
  }

  const zones = loadConfig(cwd);
  const result = classify(filePath, toolName, cwd, zones);
  logFileDecision(filePath, toolName, result.decision, result.reason, conversationId);

  // beforeReadFile schema is allow|deny only — collapse `ask` → `deny` with
  // the reason in user_message. preToolUse supports all three.
  if (toolName === "Read" && result.decision === "ask") {
    return emit({
      permission: "deny",
      user_message: `io-auto-mode/file: ${result.reason} (collapsed from 'ask' — beforeReadFile does not support ask)`,
    });
  }

  if (result.decision === "allow") {
    return emit({ permission: "allow" });
  }
  if (result.decision === "ask") {
    return emit({
      permission: "ask",
      user_message: `io-auto-mode/file: ${result.reason}`,
    });
  }
  // deny
  return emit({
    permission: "deny",
    user_message: `io-auto-mode/file: ${result.reason}`,
    agent_message: `Blocked by io-auto-mode/file: ${result.reason}. Add the path to allowRead/allowWrite in ~/.io-auto-mode/config.json if you intend this access.`,
  });
}

const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main().catch(() => emit({ permission: "allow" }));
}

// Exports for tests
export {
  classify,
  loadConfig,
  mergeZones,
  matchesGlob,
  expandPattern,
  matchesAnyPattern,
  normalisePath,
  dispatch,
  DEFAULT_ZONES,
};
export type { FileZones, CursorBeforeReadFileInput, CursorPreToolUseInput };
