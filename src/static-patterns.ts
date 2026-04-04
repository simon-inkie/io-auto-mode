import type { ClassifierDecision } from './types.js';

/**
 * Hard-coded BLOCK patterns — always block, non-overridable.
 * These are TypeScript constants compiled into the hook for tamper resistance.
 */
const STATIC_BLOCK: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-z]*\s+)*\/\s*$/i, reason: 'Delete root filesystem' },
  { pattern: /\brm\s+(-[a-z]*\s+)*~\/?\s*$/i, reason: 'Delete entire home directory' },
  { pattern: /\brm\s+(-[a-z]*\s+)*\/(home|etc|var|usr|boot|sys|proc|lib|bin|sbin)\b/i, reason: 'Delete critical system directory' },
  { pattern: /\|\s*(bash|sh|zsh|eval)\b/, reason: 'Pipe to shell interpreter' },
  { pattern: /\bcurl\b.*\|\s*(bash|sh)/, reason: 'Download and execute pattern (curl | bash)' },
  { pattern: /\bwget\b.*\|\s*(bash|sh)/, reason: 'Download and execute pattern (wget | bash)' },
  { pattern: /\beval\s*\$\(/, reason: 'Eval with command substitution' },
  { pattern: /cat\s+~\/\.(ssh|aws|gnupg)\//, reason: 'Credential file access' },
  { pattern: />\s*\/dev\/sd[a-z]/, reason: 'Direct disk device write' },
  { pattern: /chmod\s+777\s+\//, reason: 'chmod 777 on root paths' },
  { pattern: /\bsudo\s+(rm|chmod|chown|mkfs|dd)\b/, reason: 'sudo with destructive command' },
  { pattern: /\bmkfs\b/, reason: 'Filesystem format command' },
  { pattern: /\bdd\s+.*of=\/dev\//, reason: 'dd writing to device' },
  { pattern: />\s*\/etc\//, reason: 'Overwrite system config file' },
  { pattern: /curl\b.*-[a-zA-Z]*d\s*@/, reason: 'Data exfiltration via curl POST' },
  { pattern: /\.env\b.*\|.*curl\b/i, reason: 'Env file piped to curl (exfiltration)' },
  { pattern: /\.env\b.*\|.*wget\b/i, reason: 'Env file piped to wget (exfiltration)' },
  { pattern: /cat.*\.env\b.*\|.*(?:curl|wget|nc|ncat)\b/i, reason: 'Env file content sent externally' },
  { pattern: /grep.*\.env\b.*\|.*(?:curl|wget|nc|ncat)\b/i, reason: 'Env file key extraction and exfiltration' },
  { pattern: /\bnc\s+-[a-z]*l/, reason: 'Netcat listener (reverse shell risk)' },
  { pattern: /\/etc\/sudoers/, reason: 'Sudoers file access' },
  { pattern: /\bsystemctl\s+(enable|start|restart)\b/, reason: 'Systemd service manipulation' },
  { pattern: /crontab\s+-/, reason: 'Cron job modification' },
];

/**
 * Hard-coded ALLOW patterns — conservative, structurally safe.
 * Only fires if command has NO shell chaining operators.
 */
const STATIC_ALLOW: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^ls(\s+-[a-zA-Z]+)*\s*$/, reason: 'ls with flags only' },
  { pattern: /^pwd\s*$/, reason: 'Print working directory' },
  { pattern: /^echo\s/, reason: 'Echo command' },
  { pattern: /^git\s+(status|log|diff|branch)\b/, reason: 'Git read operation' },
  { pattern: /^which\s/, reason: 'Which command lookup' },
  { pattern: /^cat\s+(?!\/etc\/|~\/\.|\/home\/[^/]+\/\.)(?!.*[|;&])[^\s]+(\s+(?!\/etc\/|~\/\.|\/home\/[^/]+\/\.)[^\s|;&]+)*$/, reason: 'Cat without chaining (safe paths)' },
  { pattern: /^head\s/, reason: 'Head command' },
  { pattern: /^tail\s/, reason: 'Tail command' },
  { pattern: /^wc\s/, reason: 'Word count' },
  { pattern: /^grep\s/, reason: 'Grep search' },
  { pattern: /^rg\s/, reason: 'Ripgrep search' },
  { pattern: /^find\s+(?!.*(-exec|-delete|-ok))/, reason: 'Find without -exec/-delete' },
  { pattern: /^openclaw\s+(--version|status|doctor|plugins)\b/, reason: 'OpenClaw read-only' },
  { pattern: /^claude\s+--permission-mode\s+bypassPermissions\s+--print\s/, reason: 'Claude Code one-shot (Io tooling)' },
  { pattern: /^pnpm\s+(typecheck|lint|benchmark|build)\b/, reason: 'pnpm dev scripts' },
  { pattern: /^npm\s+(install|run|view)\b/, reason: 'npm install/run/view' },
  { pattern: /^tsx\s+/, reason: 'TypeScript execution' },
];

/** Characters/sequences that indicate shell chaining or redirection — disqualifies ALLOW */
const SHELL_CHAIN_PATTERN = /[|;&`]|\$\(|>>|>\s*[\/~]/;

/**
 * User-configurable patterns (loaded once at startup, immutable after).
 * Additive only — cannot override hard-coded patterns.
 */
let userBlockPatterns: RegExp[] = [];
let userAllowPatterns: RegExp[] = [];

export function loadUserPatterns(blockPatterns: string[], allowPatterns: string[]): void {
  userBlockPatterns = blockPatterns.map(p => new RegExp(p));
  userAllowPatterns = allowPatterns.map(p => new RegExp(p));
}

/**
 * Evaluate a command against static patterns.
 * Returns a decision if matched, or null to fall through to LLM.
 */
export function evaluateStatic(command: string): ClassifierDecision | null {
  const trimmed = command.trim();

  // Check hard-coded BLOCK patterns first (highest priority)
  for (const { pattern, reason } of STATIC_BLOCK) {
    if (pattern.test(trimmed)) {
      return { decision: 'block', reason, stage: 'static', durationMs: 0 };
    }
  }

  // Check user-configured BLOCK patterns
  for (const pattern of userBlockPatterns) {
    if (pattern.test(trimmed)) {
      return { decision: 'block', reason: 'Matched user block pattern', stage: 'static', durationMs: 0 };
    }
  }

  // ALLOW patterns only fire if no shell chaining operators present
  if (!SHELL_CHAIN_PATTERN.test(trimmed)) {
    // Check hard-coded ALLOW patterns
    for (const { pattern, reason } of STATIC_ALLOW) {
      if (pattern.test(trimmed)) {
        return { decision: 'allow', reason, stage: 'static', durationMs: 0 };
      }
    }

    // Check user-configured ALLOW patterns
    for (const pattern of userAllowPatterns) {
      if (pattern.test(trimmed)) {
        return { decision: 'allow', reason: 'Matched user allow pattern', stage: 'static', durationMs: 0 };
      }
    }
  }

  // No match — fall through to LLM
  return null;
}

/** Export for testing/benchmark visibility */
export { STATIC_BLOCK, STATIC_ALLOW };
