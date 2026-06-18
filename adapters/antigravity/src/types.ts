/**
 * io-auto-mode Antigravity (agy) adapter -- shared hook event types.
 *
 * agy CLI hook events: PreToolUse fires once per tool call and delivers a
 * camelCase JSON payload on stdin. The hook must emit a camelCase JSON result
 * on stdout and exit 0 (fail-open contract).
 *
 * These types mirror the live agy wire format (verified on agy 1.0.7).
 */

/** Fields common to every agy hook event payload. */
export interface AgyHookInput {
  transcriptPath?: string;
  conversationId?: string;
  workspacePaths?: string[];
}

/**
 * A single tool call as delivered in the agy PreToolUse hook payload.
 * Verified live (agy spike, feat/agy-pretooluse-classifier):
 *   { "name": "run_command", "args": { "CommandLine": "...", "Cwd": "...", "WaitMsBeforeAsync": N } }
 */
export interface AgyToolCall {
  name: string;
  args: Record<string, unknown>;
}

/**
 * Full agy PreToolUse hook input (camelCase JSON on stdin).
 * Extends the common hook fields with the tool call being proposed.
 */
export interface AgyPreToolUseInput extends AgyHookInput {
  toolCall?: AgyToolCall;
  stepIdx?: number;
}

/**
 * PreToolUse hook result emitted on stdout.
 * STRICT: agy unmarshals via protojson on hooks_go_proto.PreToolHookResult.
 * ANY extra field (userMessage, blockReasonMessage, reason, etc.) fails the
 * whole unmarshal at col 20 and defaults to allow. Emit ONLY { allowTool }.
 */
export interface AgyPreToolResult {
  allowTool: boolean;
}
