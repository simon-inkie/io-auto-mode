#!/usr/bin/env node
/**
 * Bundle the Claude Code and Cursor adapters into self-contained dist/
 * directories inside each adapter dir so they can be installed without
 * needing the TypeScript toolchain at install time.
 *
 * Mirrors the greymatter merge-day packaging pattern. The OpenClaw adapter
 * loads from source via load.paths and doesn't need a pre-build step.
 */

import { build } from "esbuild";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { rmSync, mkdirSync, existsSync, cpSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const CC_ROOT = join(ROOT, "adapters/claude-code");
const DIST = join(CC_ROOT, "dist");
const CURSOR_ROOT = join(ROOT, "adapters/cursor");
const CURSOR_DIST = join(CURSOR_ROOT, "dist");

const NODE_BUILTINS = [
  "fs", "fs/promises", "path", "os", "url", "util", "crypto",
  "child_process", "stream", "events", "buffer", "process", "http", "https",
  "net", "tls", "querystring", "zlib", "readline", "assert",
];
const EXTERNALS = [
  ...NODE_BUILTINS,
  ...NODE_BUILTINS.map((n) => `node:${n}`),
];

if (existsSync(DIST)) rmSync(DIST, { recursive: true });
mkdirSync(DIST, { recursive: true });

// Bash classifier (LLM-backed)
await build({
  entryPoints: [join(CC_ROOT, "src/hook.ts")],
  outfile: join(DIST, "hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
});

// File classifier (path-based, no LLM)
await build({
  entryPoints: [join(CC_ROOT, "src/file-hook.ts")],
  outfile: join(DIST, "file-hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
});

// The core classifier reads prompts via `__dirname/../prompts/system.txt`.
cpSync(join(ROOT, "prompts"), join(CC_ROOT, "prompts"), { recursive: true });

console.log(`[build] claude-code bash hook  → ${DIST}/hook.js`);
console.log(`[build] claude-code file hook  → ${DIST}/file-hook.js`);
console.log(`[build] install:  claude --plugin-dir ${CC_ROOT}`);

// ---------------------------------------------------------------------------
// Cursor adapter
// ---------------------------------------------------------------------------

if (existsSync(CURSOR_DIST)) rmSync(CURSOR_DIST, { recursive: true });
mkdirSync(CURSOR_DIST, { recursive: true });

// beforeShellExecution handler
await build({
  entryPoints: [join(CURSOR_ROOT, "src/hook.ts")],
  outfile: join(CURSOR_DIST, "hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
});

// beforeReadFile + preToolUse(Edit|Write) multiplexed handler
await build({
  entryPoints: [join(CURSOR_ROOT, "src/file-hook.ts")],
  outfile: join(CURSOR_DIST, "file-hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
});

// beforeSubmitPrompt handler — captures prompt context for next-call use
await build({
  entryPoints: [join(CURSOR_ROOT, "src/prompt-hook.ts")],
  outfile: join(CURSOR_DIST, "prompt-hook.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: EXTERNALS,
  sourcemap: "inline",
  logLevel: "warning",
});

// Cursor adapter shares the same prompts/ as Claude Code
cpSync(join(ROOT, "prompts"), join(CURSOR_ROOT, "prompts"), { recursive: true });

console.log(`[build] cursor shell hook     → ${CURSOR_DIST}/hook.js`);
console.log(`[build] cursor file hook      → ${CURSOR_DIST}/file-hook.js`);
console.log(`[build] cursor prompt hook    → ${CURSOR_DIST}/prompt-hook.js`);
