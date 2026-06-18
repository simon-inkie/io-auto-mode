/**
 * Tests for the Antigravity (agy) PreToolUse classifier.
 *
 * Exercises the exported run() function directly -- no subprocess or LLM calls.
 * All classify() paths that would hit a model are for run_command; safe
 * no-model paths (allow-tools, unknown-tool, empty CommandLine) are tested here.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { run } from '../adapters/antigravity/src/pretooluse-classify.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(toolName: string, args: Record<string, unknown> = {}, conversationId = 'test-conv'): string {
  return JSON.stringify({
    conversationId,
    toolCall: { name: toolName, args },
    workspacePaths: ['/tmp'],
  });
}

// ---------------------------------------------------------------------------
// Infra / parse errors -- fail-open
// ---------------------------------------------------------------------------

describe('antigravity-classify: infra errors fail-open', () => {
  test('empty string returns allowTool:true', async () => {
    const result = await run('');
    assert.equal(result.allowTool, true);
  });

  test('invalid JSON returns allowTool:true', async () => {
    const result = await run('not valid json {{{');
    assert.equal(result.allowTool, true);
  });

  test('null body returns allowTool:true', async () => {
    const result = await run('null');
    // null parsed -> toolCall undefined -> ALLOW_TOOLS miss -> unknown-tool -> allow
    assert.equal(result.allowTool, true);
  });
});

// ---------------------------------------------------------------------------
// Read-only / agy-internal tools -- always allow
// ---------------------------------------------------------------------------

describe('antigravity-classify: read-only tools always allow', () => {
  const readOnlyTools = [
    'view_file',
    'list_dir',
    'read_url_content',
    'search_web',
    'grep_search',
    'codebase_search',
    'find_filepath',
  ];

  for (const tool of readOnlyTools) {
    test(`${tool} returns allowTool:true`, async () => {
      const result = await run(makeInput(tool));
      assert.equal(result.allowTool, true, `${tool} should always be allowed`);
    });
  }
});

describe('antigravity-classify: agy-internal tools always allow', () => {
  const internalTools = [
    'ask_permission',
    'ask_question',
    'list_permissions',
    'invoke_subagent',
  ];

  for (const tool of internalTools) {
    test(`${tool} returns allowTool:true`, async () => {
      const result = await run(makeInput(tool));
      assert.equal(result.allowTool, true, `${tool} should always be allowed`);
    });
  }
});

// ---------------------------------------------------------------------------
// run_command with empty / missing CommandLine -- allow
// ---------------------------------------------------------------------------

describe('antigravity-classify: run_command with empty CommandLine fails-open', () => {
  test('empty CommandLine string returns allowTool:true', async () => {
    const result = await run(makeInput('run_command', { CommandLine: '' }));
    assert.equal(result.allowTool, true);
  });

  test('whitespace-only CommandLine returns allowTool:true', async () => {
    const result = await run(makeInput('run_command', { CommandLine: '   ' }));
    assert.equal(result.allowTool, true);
  });

  test('missing CommandLine field returns allowTool:true', async () => {
    const result = await run(makeInput('run_command', {}));
    assert.equal(result.allowTool, true);
  });
});

// ---------------------------------------------------------------------------
// Unknown tools -- allow + log (no classify call)
// ---------------------------------------------------------------------------

describe('antigravity-classify: unknown tools allow + log', () => {
  test('unrecognised tool name returns allowTool:true', async () => {
    const result = await run(makeInput('some_future_tool'));
    assert.equal(result.allowTool, true);
  });

  test('empty tool name returns allowTool:true', async () => {
    const result = await run(JSON.stringify({ conversationId: 'c', workspacePaths: [] }));
    // no toolCall -> toolName="" -> not in ALLOW_TOOLS -> not run_command -> unknown -> allow
    assert.equal(result.allowTool, true);
  });
});

// ---------------------------------------------------------------------------
// Output shape contract -- MUST be exactly { allowTool: boolean }
// ---------------------------------------------------------------------------

describe('antigravity-classify: output shape is exactly {allowTool:bool}', () => {
  test('allowTool:true result has no extra fields', async () => {
    const result = await run(makeInput('view_file'));
    const keys = Object.keys(result);
    assert.deepEqual(keys, ['allowTool'], 'must emit only allowTool');
    assert.equal(typeof result.allowTool, 'boolean');
  });

  test('fail-open on parse error has no extra fields', async () => {
    const result = await run('bad json');
    const keys = Object.keys(result);
    assert.deepEqual(keys, ['allowTool'], 'fail-open must emit only allowTool');
  });
});
