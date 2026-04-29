import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import {
  classify,
  expandPattern,
  matchesGlob,
  matchesAnyPattern,
  mergeZones,
  normalisePath,
  dispatch,
  DEFAULT_ZONES,
  type FileZones,
} from '../adapters/cursor/src/file-hook.js';
import {
  writePrompt,
  readPrompt,
  type CachedPrompt,
} from '../adapters/cursor/src/prompt-store.js';

// ---------------------------------------------------------------------------
// dispatch() — chooses Read vs Write based on Cursor's input shape
// ---------------------------------------------------------------------------

describe('cursor file-hook dispatch: routing by input shape', () => {
  test('beforeReadFile shape (top-level file_path) → Read', () => {
    const r = dispatch({
      file_path: '/abs/path/foo.ts',
      cwd: '/project',
      conversation_id: 'conv-1',
    });
    assert.equal(r.toolName, 'Read');
    assert.equal(r.filePath, '/abs/path/foo.ts');
    assert.equal(r.cwd, '/project');
    assert.equal(r.conversationId, 'conv-1');
  });

  test('preToolUse with tool_name=Edit → Write zone', () => {
    const r = dispatch({
      tool_name: 'Edit',
      tool_input: { file_path: '/abs/foo.ts' },
      cwd: '/project',
      conversation_id: 'conv-2',
    });
    assert.equal(r.toolName, 'Write');
    assert.equal(r.filePath, '/abs/foo.ts');
  });

  test('preToolUse with tool_name=Write → Write zone', () => {
    const r = dispatch({
      tool_name: 'Write',
      tool_input: { file_path: '/abs/foo.ts' },
      cwd: '/project',
    });
    assert.equal(r.toolName, 'Write');
  });

  test('preToolUse with tool_name=Task → null (allow-through)', () => {
    const r = dispatch({
      tool_name: 'Task',
      tool_input: { file_path: '/abs/foo.ts' },
      cwd: '/project',
    });
    assert.equal(r.toolName, null);
    assert.equal(r.filePath, undefined);
  });

  test('preToolUse with tool_name=Shell → null (Shell is for beforeShellExecution)', () => {
    const r = dispatch({ tool_name: 'Shell', tool_input: {}, cwd: '/p' });
    assert.equal(r.toolName, null);
  });

  test('preToolUse with tool_name=MCP:foo → null (deferred)', () => {
    const r = dispatch({ tool_name: 'MCP:something', tool_input: {}, cwd: '/p' });
    assert.equal(r.toolName, null);
  });

  test('preToolUse with tool_name=Read → null (Read is for beforeReadFile)', () => {
    const r = dispatch({ tool_name: 'Read', tool_input: {}, cwd: '/p' });
    assert.equal(r.toolName, null);
  });

  test('empty input → null', () => {
    const r = dispatch({});
    assert.equal(r.toolName, null);
  });

  test('null/undefined input → null', () => {
    assert.equal(dispatch(null).toolName, null);
    assert.equal(dispatch(undefined).toolName, null);
  });

  test('cwd defaults to process.cwd() when missing', () => {
    const r = dispatch({ file_path: '/abs/path' });
    assert.ok(r.cwd && r.cwd.length > 0, 'cwd should fall back to process.cwd');
  });

  test('preToolUse without tool_input.file_path → undefined filePath', () => {
    const r = dispatch({ tool_name: 'Edit', cwd: '/project' });
    assert.equal(r.toolName, 'Write');
    assert.equal(r.filePath, undefined);
  });
});

// ---------------------------------------------------------------------------
// classify() — same semantics as the Claude Code adapter, since it's the
// same path-zone logic; just verify the behaviour holds on the Cursor side
// ---------------------------------------------------------------------------

describe('cursor file-hook classify: deny precedence', () => {
  test('deny pattern wins even when allow matches', () => {
    const HOME = process.env.HOME ?? '/home/test';
    const zones: FileZones = {
      deny: [`${HOME}/.ssh/**`],
      allowRead: [`${HOME}/**`],
      allowWrite: [`${HOME}/**`],
    };
    const result = classify(`${HOME}/.ssh/id_rsa`, 'Read', '/project', zones);
    assert.equal(result.decision, 'deny');
  });

  test('default deny zones cover .ssh / .aws / .gnupg', () => {
    const HOME = process.env.HOME ?? '/home/test';
    assert.equal(classify(`${HOME}/.ssh/id_rsa`, 'Read', '/p', DEFAULT_ZONES).decision, 'deny');
    assert.equal(classify(`${HOME}/.aws/credentials`, 'Read', '/p', DEFAULT_ZONES).decision, 'deny');
    assert.equal(classify(`${HOME}/.gnupg/secring.gpg`, 'Read', '/p', DEFAULT_ZONES).decision, 'deny');
  });

  test('default deny zones cover ~/.io-auto-mode/.env (api keys)', () => {
    const HOME = process.env.HOME ?? '/home/test';
    assert.equal(
      classify(`${HOME}/.io-auto-mode/.env`, 'Read', '/p', DEFAULT_ZONES).decision,
      'deny',
      '~/.io-auto-mode/.env should be denied — would leak API keys',
    );
  });
});

describe('cursor file-hook classify: tool-type → zone routing', () => {
  const zones: FileZones = {
    deny: [],
    allowRead: ['/safe-read/**'],
    allowWrite: ['/safe-write/**'],
  };

  test('Read uses allowRead', () => {
    assert.equal(classify('/safe-read/foo', 'Read', '/p', zones).decision, 'allow');
    assert.equal(classify('/safe-write/foo', 'Read', '/p', zones).decision, 'ask');
  });

  test('Write uses allowWrite', () => {
    assert.equal(classify('/safe-write/foo', 'Write', '/p', zones).decision, 'allow');
    assert.equal(classify('/safe-read/foo', 'Write', '/p', zones).decision, 'ask');
  });
});

describe('cursor file-hook classify: ${projectDir} expansion', () => {
  test('projectDir variable expands and matches', () => {
    const PROJECT = '/home/test/project';
    const zones: FileZones = {
      deny: [],
      allowRead: ['${projectDir}/**'],
      allowWrite: ['${projectDir}/**'],
    };
    assert.equal(
      classify(`${PROJECT}/src/foo.ts`, 'Read', PROJECT, zones).decision,
      'allow',
    );
    assert.equal(
      classify('/elsewhere/bar.ts', 'Read', PROJECT, zones).decision,
      'ask',
    );
  });
});

describe('cursor file-hook glob behaviour', () => {
  test('mid-path *', () => {
    assert.equal(
      matchesGlob('/a/b/c.ts', '/a/*/c.ts'),
      true,
    );
  });

  test('** spans segments', () => {
    assert.equal(matchesGlob('/a/b/c/d.ts', '/a/**'), true);
  });

  test('expandPattern handles ~', () => {
    const HOME = process.env.HOME ?? '/home/test';
    assert.equal(expandPattern('~/foo', '/p'), `${HOME}/foo`);
  });

  test('expandPattern handles ${projectDir}', () => {
    assert.equal(expandPattern('${projectDir}/x', '/p'), '/p/x');
  });
});

// ---------------------------------------------------------------------------
// mergeZones — same additive merge as Claude Code adapter
// ---------------------------------------------------------------------------

describe('cursor file-hook mergeZones: additive + immutable deny', () => {
  test('overlay adds to base allow lists', () => {
    const base: FileZones = { deny: ['/etc/**'], allowRead: ['/a/**'], allowWrite: ['/a/**'] };
    const merged = mergeZones(base, { allowRead: ['/b/**'], allowWrite: ['/b/**'] }, ['/etc/**']);
    assert.deepEqual(merged.allowRead, ['/a/**', '/b/**']);
    assert.deepEqual(merged.allowWrite, ['/a/**', '/b/**']);
  });

  test('immutableDeny passed through', () => {
    const base: FileZones = { deny: ['/etc/**'], allowRead: [], allowWrite: [] };
    const merged = mergeZones(base, { deny: ['/sys/**'] }, ['/etc/**', '/sys/**']);
    assert.deepEqual(merged.deny, ['/etc/**', '/sys/**']);
  });
});

// ---------------------------------------------------------------------------
// Symlink resolution — same publicly-promised guard as Claude Code
// ---------------------------------------------------------------------------

describe('cursor file-hook symlink resolution', () => {
  const TEST_ROOT = join(tmpdir(), `io-auto-mode-cursor-test-${process.pid}`);

  test.before(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(join(TEST_ROOT, 'allowed'), { recursive: true });
    mkdirSync(join(TEST_ROOT, 'secret'), { recursive: true });
    writeFileSync(join(TEST_ROOT, 'secret/password.txt'), 'shh');
    try {
      symlinkSync(
        join(TEST_ROOT, 'secret/password.txt'),
        join(TEST_ROOT, 'allowed/innocent.txt'),
      );
    } catch {
      // skip on platforms without symlink support
    }
  });

  test.after(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test('symlink in allowed zone resolves to denied target → deny', () => {
    const zones: FileZones = {
      deny: [join(TEST_ROOT, 'secret/**')],
      allowRead: [join(TEST_ROOT, 'allowed/**')],
      allowWrite: [join(TEST_ROOT, 'allowed/**')],
    };
    const result = classify(
      join(TEST_ROOT, 'allowed/innocent.txt'),
      'Read',
      TEST_ROOT,
      zones,
    );
    assert.equal(result.decision, 'deny');
  });

  test('normalisePath follows symlinks', () => {
    const symlinkPath = join(TEST_ROOT, 'allowed/innocent.txt');
    const targetPath = join(TEST_ROOT, 'secret/password.txt');
    assert.equal(normalisePath(symlinkPath), targetPath);
  });

  test('normalisePath returns resolved path even when file does not exist', () => {
    const path = join(TEST_ROOT, 'allowed/does-not-exist.txt');
    assert.equal(normalisePath(path), path);
  });
});

// ---------------------------------------------------------------------------
// prompt-store — atomic-rename writes, best-effort reads, fail-open on miss
// ---------------------------------------------------------------------------

describe('cursor prompt-store: cache write/read round-trip', () => {
  const HOME = process.env.HOME ?? '/home/test';
  const CACHE_DIR = join(HOME, '.io-auto-mode', 'cache', 'cursor-prompts');

  // Use unique IDs so concurrent test runs don't clobber each other
  const testId = `test-${process.pid}-${Date.now()}`;
  const conversationId = `${testId}-conv`;

  test.after(() => {
    try {
      rmSync(join(CACHE_DIR, `${conversationId}.json`));
    } catch { /* ignore */ }
  });

  test('write then read returns the cached prompt', () => {
    const payload: CachedPrompt = {
      capturedAt: new Date().toISOString(),
      conversationId,
      prompt: 'add a logging statement to the parser',
      attachments: [{ type: 'file', file_path: '/foo.ts' }],
    };
    writePrompt(payload);
    const got = readPrompt(conversationId);
    assert.ok(got);
    assert.equal(got.prompt, payload.prompt);
    assert.equal(got.conversationId, payload.conversationId);
    assert.equal(got.attachments.length, 1);
  });

  test('read returns null for unknown conversation_id', () => {
    assert.equal(readPrompt('nonexistent-id'), null);
  });

  test('read returns null for empty conversation_id', () => {
    assert.equal(readPrompt(''), null);
  });

  test('read survives malformed cache file (returns null, does not throw)', () => {
    const malformedId = `${testId}-malformed`;
    const path = join(CACHE_DIR, `${malformedId}.json`);
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(path, '{ this is not valid json');
    assert.equal(readPrompt(malformedId), null);
    rmSync(path);
  });

  test('write uses atomic-rename (no .tmp file left behind on success)', () => {
    const id = `${testId}-atomic`;
    writePrompt({
      capturedAt: 'now',
      conversationId: id,
      prompt: 'p',
      attachments: [],
    });
    assert.equal(existsSync(join(CACHE_DIR, `${id}.json`)), true);
    assert.equal(existsSync(join(CACHE_DIR, `${id}.json.tmp`)), false);
    rmSync(join(CACHE_DIR, `${id}.json`));
  });

  test('conversation_id is sanitised for filesystem safety', () => {
    // Path-traversal attempt — should be sanitised, not write to /etc/
    const evil = '../../../etc/passwd';
    writePrompt({
      capturedAt: 'now',
      conversationId: evil,
      prompt: 'attempted traversal',
      attachments: [],
    });
    // The actual file should land inside CACHE_DIR with a sanitised name
    const sanitised = evil.replace(/[^a-zA-Z0-9._-]/g, '_');
    assert.equal(existsSync(join(CACHE_DIR, `${sanitised}.json`)), true);
    // /etc/passwd should not have been clobbered (we don't have permission anyway)
    rmSync(join(CACHE_DIR, `${sanitised}.json`));
  });
});

// ---------------------------------------------------------------------------
// matchesAnyPattern — quick smoke covering the cursor-side use cases
// ---------------------------------------------------------------------------

describe('cursor file-hook matchesAnyPattern', () => {
  test('matches if any pattern matches', () => {
    const patterns = ['~/projects/**', '${projectDir}/build/**'];
    const HOME = process.env.HOME ?? '/home/test';
    const PROJECT = '/home/test/project';
    assert.equal(matchesAnyPattern(`${HOME}/projects/foo.ts`, patterns, PROJECT), true);
    assert.equal(matchesAnyPattern(`${PROJECT}/build/out.js`, patterns, PROJECT), true);
    assert.equal(matchesAnyPattern('/elsewhere/file.txt', patterns, PROJECT), false);
  });
});
