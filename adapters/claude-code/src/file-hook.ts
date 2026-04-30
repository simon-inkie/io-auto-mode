/**
 * io-auto-mode — Claude Code PreToolUse hook for Read/Write/Edit tools.
 *
 * Pure path-based classification. No LLM, no transcript, no API calls.
 * Resolves in <1ms for all decisions.
 *
 * Flow:
 *   stdin → hook event JSON → extract file_path + tool_name
 *     → normalise path (resolve ~, .., symlinks)
 *     → check deny zones → deny
 *     → check allow zones (per tool) → allow
 *     → default → ask
 *     → stdout → permissionDecision JSON
 *
 * Config resolution (§4b):
 *   1. Built-in defaults
 *   2. ~/.io-auto-mode/config.json (user global)
 *   3. ${projectDir}/.io-auto-mode.json (project-level, additive only)
 */

import { readFileSync, realpathSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { file_path?: string };
}

export interface FileZones {
  deny: string[];
  allowRead: string[];
  allowWrite: string[];
}

interface HookOutput {
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: "allow" | "deny" | "ask";
    permissionDecisionReason: string;
  };
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const HOME = homedir();

export const DEFAULT_ZONES: FileZones = {
  deny: [
    "~/.ssh/**",
    "~/.aws/**",
    "~/.gnupg/**",
    "~/.config/gh/hosts.yml",
    "~/.claude/settings.json",
    "~/io-data/.env",
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
    "~/.openclaw/workspace/**",
    "~/.the-brain/**",
    "~/.claude/projects/**",
    "~/.claude/settings.local.json",
    "/tmp/**",
  ],
  allowWrite: [
    "${projectDir}/**",
    "/tmp/**",
  ],
};

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

function emit(decision: "allow" | "deny" | "ask", reason: string): never {
  const output: HookOutput = {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: `io-auto-mode/file: ${reason}`,
    },
  };
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Config loading + merge
// ---------------------------------------------------------------------------

function loadJsonSafe<T>(path: string): Partial<T> | null {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as Partial<T>;
  } catch {
    return null;
  }
}

export function mergeZones(base: FileZones, overlay: Partial<FileZones>, immutableDeny: string[]): FileZones {
  const deny = immutableDeny; // global deny is NEVER weakened
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

function dedup(arr: string[]): string[] {
  return [...new Set(arr)];
}

export function loadConfig(projectDir: string): FileZones {
  // Layer 1: defaults
  let zones: FileZones = { ...DEFAULT_ZONES };
  let immutableDeny = [...DEFAULT_ZONES.deny];

  // Layer 2: user global
  const globalPath = join(HOME, ".io-auto-mode", "config.json");
  const globalCfg = loadJsonSafe<{ fileZones?: Partial<FileZones> }>(globalPath);
  if (globalCfg?.fileZones) {
    // User can extend deny — those become immutable too
    if (globalCfg.fileZones.deny) {
      immutableDeny = dedup([...immutableDeny, ...globalCfg.fileZones.deny]);
    }
    zones = mergeZones(zones, globalCfg.fileZones, immutableDeny);
  }

  // Layer 3: project-level (additive only, cannot weaken deny)
  const projectPath = join(projectDir, ".io-auto-mode.json");
  const projectCfg = loadJsonSafe<{ fileZones?: Partial<FileZones> }>(projectPath);
  if (projectCfg?.fileZones) {
    // Project deny additions are noted but don't weaken existing
    if (projectCfg.fileZones.deny) {
      immutableDeny = dedup([...immutableDeny, ...projectCfg.fileZones.deny]);
    }
    zones = mergeZones(zones, projectCfg.fileZones, immutableDeny);
  }

  return zones;
}

// ---------------------------------------------------------------------------
// Path matching
// ---------------------------------------------------------------------------

export function expandPattern(pattern: string, projectDir: string): string {
  return pattern
    .replace(/\$\{projectDir\}/g, projectDir)
    .replace(/^~(?=\/|$)/, HOME);
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  const expanded = pattern;

  // Exact match
  if (filePath === expanded) return true;

  // Prefix match for dirs without glob
  if (!expanded.includes("*")) {
    return filePath === expanded || filePath.startsWith(expanded + "/");
  }

  // Convert the pattern to a regex:
  //   **   → .*                (any number of segments, including slashes)
  //   *    → [^/]*             (single segment, no slashes)
  //   rest → escaped literal
  // This covers exact match, */suffix, /**/ prefix, mid-path *, and combos
  // like /home/simon/.claude/projects/*/memory/*.md.
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

export function matchesAnyPattern(filePath: string, patterns: string[], projectDir: string): boolean {
  for (const pattern of patterns) {
    const expanded = expandPattern(pattern, projectDir);
    if (matchesGlob(filePath, expanded)) return true;
  }
  return false;
}

export function normalisePath(rawPath: string): string {
  // Expand ~ and resolve relative paths
  let resolved = rawPath.replace(/^~(?=\/|$)/, HOME);
  resolved = resolve(resolved);

  // Follow symlinks to catch symlink-to-credential tricks
  try {
    resolved = realpathSync(resolved);
  } catch {
    // File may not exist yet (Write creates new files) — use resolved path
  }

  return resolved;
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

export function classify(
  filePath: string,
  toolName: string,
  projectDir: string,
  zones: FileZones,
): { decision: "allow" | "deny" | "ask"; reason: string } {
  const normalised = normalisePath(filePath);

  // Deny always wins
  if (matchesAnyPattern(normalised, zones.deny, projectDir)) {
    return { decision: "deny", reason: `denied path: ${normalised}` };
  }

  // Allow zones depend on tool type
  if (toolName === "Read") {
    if (matchesAnyPattern(normalised, zones.allowRead, projectDir)) {
      return { decision: "allow", reason: `allowed read: ${normalised}` };
    }
  } else {
    // Write + Edit use the tighter allowWrite zone
    if (matchesAnyPattern(normalised, zones.allowWrite, projectDir)) {
      return { decision: "allow", reason: `allowed write: ${normalised}` };
    }
  }

  // Everything else → ask
  return { decision: "ask", reason: `unknown path, requesting approval: ${normalised}` };
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function logFileDecision(
  filePath: string,
  toolName: string,
  decision: string,
  reason: string,
): void {
  try {
    const logPath = join(HOME, ".io-auto-mode", "auto-mode-log.jsonl");
    const entry = JSON.stringify({
      ts: new Date().toISOString(),
      type: "file",
      adapter: "claude-code",
      tool: toolName,
      path: filePath,
      decision,
      reason,
    });
    mkdirSync(join(HOME, ".io-auto-mode"), { recursive: true });
    appendFileSync(logPath, entry + "\n");
  } catch {
    // Non-fatal — keep classification working even if logging dies.
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  let raw: string;
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    raw = Buffer.concat(chunks).toString("utf-8");
  } catch (err) {
    return emit("ask", `failed to read stdin: ${err}`);
  }

  let input: HookInput;
  try {
    input = JSON.parse(raw) as HookInput;
  } catch (err) {
    return emit("ask", `invalid hook JSON: ${err}`);
  }

  const filePath = input.tool_input?.file_path?.trim();
  if (!filePath) {
    return emit("allow", "no file_path in tool_input");
  }

  const toolName = input.tool_name ?? "Read";
  const projectDir = input.cwd ?? process.cwd();
  const zones = loadConfig(projectDir);

  const result = classify(filePath, toolName, projectDir, zones);
  logFileDecision(filePath, toolName, result.decision, result.reason);
  emit(result.decision, result.reason);
}

// Only run main() when invoked as the entry point — not when imported by tests.
// Resolve symlinks so this works when invoked via an npm `bin` symlink (where
// process.argv[1] is the symlink path but import.meta.url resolves to target).
let mainEntryReal: string;
try {
  mainEntryReal = realpathSync(process.argv[1]);
} catch {
  mainEntryReal = process.argv[1];
}
const isMainModule = import.meta.url === `file://${mainEntryReal}`;
if (isMainModule) {
  main().catch((err) => emit("ask", `unhandled: ${err}`));
}
