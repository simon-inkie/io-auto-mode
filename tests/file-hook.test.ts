import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import {
  classify,
  expandPattern,
  matchesGlob,
  matchesAnyPattern,
  mergeZones,
  normalisePath,
  DEFAULT_ZONES,
  type FileZones,
} from '../adapters/claude-code/src/file-hook.js';
import { homedir, tmpdir } from 'node:os';
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

const HOME = homedir();
const PROJECT_DIR = '/home/test/project';

describe('expandPattern: variable + tilde expansion', () => {
  test('expands ${projectDir}', () => {
    assert.equal(
      expandPattern('${projectDir}/**', '/home/test/project'),
      '/home/test/project/**',
    );
  });

  test('expands ~ at start', () => {
    assert.equal(expandPattern('~/.ssh/**', PROJECT_DIR), `${HOME}/.ssh/**`);
  });

  test('does not expand ~ in middle of path', () => {
    assert.equal(expandPattern('/foo/~/bar', PROJECT_DIR), '/foo/~/bar');
  });

  test('handles multiple ${projectDir} occurrences', () => {
    assert.equal(
      expandPattern('${projectDir}-x-${projectDir}-y', '/p'),
      '/p-x-/p-y',
    );
  });
});

describe('matchesGlob: glob semantics', () => {
  test('exact match', () => {
    assert.equal(matchesGlob('/foo/bar', '/foo/bar'), true);
  });

  test('non-glob prefix matches dir contents', () => {
    assert.equal(matchesGlob('/foo/bar/baz', '/foo/bar'), true);
    assert.equal(matchesGlob('/foo/bar', '/foo/bar'), true);
    // Sibling that looks like a prefix but isn't a path-boundary match
    assert.equal(matchesGlob('/foo/bartender', '/foo/bar'), false);
  });

  test('** matches across path segments', () => {
    assert.equal(matchesGlob('/foo/bar/baz/qux.ts', '/foo/**'), true);
    assert.equal(matchesGlob('/foo/bar/baz/qux.ts', '/foo/**/qux.ts'), true);
  });

  test('* matches single segment, not slashes', () => {
    assert.equal(matchesGlob('/foo/bar.ts', '/foo/*.ts'), true);
    assert.equal(matchesGlob('/foo/bar/baz.ts', '/foo/*.ts'), false);
    assert.equal(matchesGlob('/foo/bar/baz.ts', '/foo/*/baz.ts'), true);
  });

  test('mid-path * (regression for f8ebb44)', () => {
    // Bug: glob matcher didn't handle * in the middle of a path.
    // Fix: split on (\*\*|\*) instead of replacing in place.
    assert.equal(
      matchesGlob('/home/simon/.claude/projects/abc/memory/note.md', '/home/simon/.claude/projects/*/memory/*.md'),
      true,
      'mid-path * should match a single segment',
    );
    assert.equal(
      matchesGlob('/home/simon/.claude/projects/abc/def/memory/note.md', '/home/simon/.claude/projects/*/memory/*.md'),
      false,
      'mid-path * should not match across multiple segments',
    );
  });

  test('escapes regex metacharacters in literal portions', () => {
    // Should not interpret . as regex any-char
    assert.equal(matchesGlob('/foo/file.ts', '/foo/file.ts'), true);
    assert.equal(matchesGlob('/foo/fileXts', '/foo/file.ts'), false);
  });
});

describe('matchesAnyPattern: pattern list with expansion', () => {
  test('matches if any pattern matches', () => {
    const patterns = ['~/projects/**', '${projectDir}/build/**'];
    assert.equal(
      matchesAnyPattern(`${HOME}/projects/foo.ts`, patterns, PROJECT_DIR),
      true,
    );
    assert.equal(
      matchesAnyPattern(`${PROJECT_DIR}/build/out.js`, patterns, PROJECT_DIR),
      true,
    );
    assert.equal(
      matchesAnyPattern('/elsewhere/file.txt', patterns, PROJECT_DIR),
      false,
    );
  });
});

describe('mergeZones: additive merge with immutable deny', () => {
  test('overlay adds to base allowRead/allowWrite', () => {
    const base: FileZones = { deny: ['/etc/**'], allowRead: ['/a/**'], allowWrite: ['/a/**'] };
    const overlay: Partial<FileZones> = { allowRead: ['/b/**'], allowWrite: ['/b/**'] };
    const merged = mergeZones(base, overlay, ['/etc/**']);
    assert.deepEqual(merged.allowRead, ['/a/**', '/b/**']);
    assert.deepEqual(merged.allowWrite, ['/a/**', '/b/**']);
  });

  test('deduplicates merged zones', () => {
    const base: FileZones = { deny: [], allowRead: ['/a/**'], allowWrite: ['/a/**'] };
    const overlay: Partial<FileZones> = { allowRead: ['/a/**', '/b/**'] };
    const merged = mergeZones(base, overlay, []);
    assert.deepEqual(merged.allowRead, ['/a/**', '/b/**']);
  });

  test('immutableDeny replaces base.deny entirely', () => {
    const base: FileZones = { deny: ['/etc/**'], allowRead: [], allowWrite: [] };
    const overlay: Partial<FileZones> = { deny: ['/sys/**'] };
    // immutableDeny is what the caller passes — it's the contract for "deny list never weakened"
    const merged = mergeZones(base, overlay, ['/etc/**', '/sys/**']);
    assert.deepEqual(merged.deny, ['/etc/**', '/sys/**']);
  });

  test('overlay missing fields preserves base', () => {
    const base: FileZones = { deny: ['/d'], allowRead: ['/r'], allowWrite: ['/w'] };
    const merged = mergeZones(base, {}, ['/d']);
    assert.deepEqual(merged.allowRead, ['/r']);
    assert.deepEqual(merged.allowWrite, ['/w']);
  });
});

describe('classify: deny precedence over allow', () => {
  test('deny pattern wins even when allow matches', () => {
    const zones: FileZones = {
      deny: [`${HOME}/.ssh/**`],
      allowRead: [`${HOME}/**`],
      allowWrite: [`${HOME}/**`],
    };
    const result = classify(`${HOME}/.ssh/id_rsa`, 'Read', PROJECT_DIR, zones);
    assert.equal(result.decision, 'deny');
    assert.match(result.reason, /denied path/);
  });

  test('default deny zones block credential access', () => {
    const result = classify(`${HOME}/.aws/credentials`, 'Read', PROJECT_DIR, DEFAULT_ZONES);
    assert.equal(result.decision, 'deny');
  });
});

describe('classify: tool type drives zone choice', () => {
  const zones: FileZones = {
    deny: [],
    allowRead: ['/safe-read/**'],
    allowWrite: ['/safe-write/**'],
  };

  test('Read tool uses allowRead', () => {
    assert.equal(
      classify('/safe-read/file', 'Read', PROJECT_DIR, zones).decision,
      'allow',
    );
  });

  test('Write tool uses allowWrite (rejects allowRead)', () => {
    assert.equal(
      classify('/safe-read/file', 'Write', PROJECT_DIR, zones).decision,
      'ask',
      'Write should not match allowRead-only paths',
    );
    assert.equal(
      classify('/safe-write/file', 'Write', PROJECT_DIR, zones).decision,
      'allow',
    );
  });

  test('Edit tool uses allowWrite', () => {
    assert.equal(
      classify('/safe-write/file', 'Edit', PROJECT_DIR, zones).decision,
      'allow',
    );
    assert.equal(
      classify('/safe-read/file', 'Edit', PROJECT_DIR, zones).decision,
      'ask',
    );
  });
});

describe('classify: unknown paths → ask', () => {
  test('not in allow list returns ask', () => {
    const zones: FileZones = {
      deny: [],
      allowRead: ['/known/**'],
      allowWrite: ['/known/**'],
    };
    const result = classify('/unknown/file', 'Read', PROJECT_DIR, zones);
    assert.equal(result.decision, 'ask');
    assert.match(result.reason, /unknown path/);
  });
});

describe('classify: ${projectDir} expansion', () => {
  test('projectDir variable expands and matches', () => {
    const zones: FileZones = {
      deny: [],
      allowRead: ['${projectDir}/**'],
      allowWrite: ['${projectDir}/**'],
    };
    const result = classify(
      `${PROJECT_DIR}/src/foo.ts`,
      'Read',
      PROJECT_DIR,
      zones,
    );
    assert.equal(result.decision, 'allow');
  });
});

describe('classify: symlink resolution (security guard)', () => {
  // README publicly promises: "paths are resolved through realpathSync()
  // before pattern-matching, so an attacker can't escape an allowWrite zone
  // via a symlink to a credential file."
  const TEST_ROOT = join(tmpdir(), `io-auto-mode-test-${process.pid}`);

  test.before(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
    mkdirSync(join(TEST_ROOT, 'allowed'), { recursive: true });
    mkdirSync(join(TEST_ROOT, 'secret'), { recursive: true });
    writeFileSync(join(TEST_ROOT, 'secret/password.txt'), 'shh');
    // Create a symlink inside allowed/ that points to secret/password.txt
    try {
      symlinkSync(
        join(TEST_ROOT, 'secret/password.txt'),
        join(TEST_ROOT, 'allowed/innocent.txt'),
      );
    } catch {
      // symlinks may fail on some filesystems (Windows, certain WSL configs);
      // test will skip naturally if the symlink doesn't resolve
    }
  });

  test.after(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  test('symlink in allow zone resolves to denied target → deny', () => {
    const zones: FileZones = {
      deny: [join(TEST_ROOT, 'secret/**')],
      allowRead: [join(TEST_ROOT, 'allowed/**')],
      allowWrite: [join(TEST_ROOT, 'allowed/**')],
    };
    // The symlink path looks innocent; its target is in the deny zone
    const symlinkPath = join(TEST_ROOT, 'allowed/innocent.txt');
    const result = classify(symlinkPath, 'Read', TEST_ROOT, zones);
    assert.equal(
      result.decision,
      'deny',
      'symlink target in deny zone should win over symlink path in allow zone',
    );
  });

  test('normalisePath resolves a symlink to its target', () => {
    const symlinkPath = join(TEST_ROOT, 'allowed/innocent.txt');
    const targetPath = join(TEST_ROOT, 'secret/password.txt');
    const normalised = normalisePath(symlinkPath);
    assert.equal(normalised, targetPath, 'normalisePath should follow symlinks');
  });

  test('normalisePath returns resolved path even when file does not exist', () => {
    // Write tools create new files — realpathSync would throw, but we still
    // need a usable resolved path.
    const newFile = join(TEST_ROOT, 'allowed/does-not-exist-yet.txt');
    const normalised = normalisePath(newFile);
    assert.equal(normalised, newFile, 'non-existent files should still resolve');
  });
});

describe('classify: DEFAULT_ZONES sanity', () => {
  test('default deny includes ssh / aws / gnupg', () => {
    assert.ok(DEFAULT_ZONES.deny.some(p => p.includes('.ssh')));
    assert.ok(DEFAULT_ZONES.deny.some(p => p.includes('.aws')));
    assert.ok(DEFAULT_ZONES.deny.some(p => p.includes('.gnupg')));
  });

  test('default deny includes /etc and /usr', () => {
    assert.ok(DEFAULT_ZONES.deny.some(p => p === '/etc/**'));
    assert.ok(DEFAULT_ZONES.deny.some(p => p === '/usr/**'));
  });

  test('default allowWrite is tighter than allowRead', () => {
    // allowWrite should be a strict subset (or smaller) than allowRead by intent
    assert.ok(
      DEFAULT_ZONES.allowWrite.length < DEFAULT_ZONES.allowRead.length,
      'allowWrite should be tighter than allowRead by default',
    );
  });

  test('default allowRead includes ${projectDir}/**', () => {
    assert.ok(DEFAULT_ZONES.allowRead.includes('${projectDir}/**'));
  });
});
