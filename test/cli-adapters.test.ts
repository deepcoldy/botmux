/**
 * Unit tests for CLI adapters: factory, buildArgs, patterns, properties.
 *
 * Run:  pnpm vitest run test/cli-adapters.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock external dependencies BEFORE importing adapters
// ---------------------------------------------------------------------------

// Mock child_process.execSync so resolveCommand() returns the command as-is.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(() => ''),
}));

import { createCliAdapterSync } from '../src/adapters/cli/registry.js';
import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createAidenAdapter } from '../src/adapters/cli/aiden.js';
import { createCocoAdapter } from '../src/adapters/cli/coco.js';
import { createCodexAdapter } from '../src/adapters/cli/codex.js';
import { createGeminiAdapter } from '../src/adapters/cli/gemini.js';
import { createOpenCodeAdapter } from '../src/adapters/cli/opencode.js';
import type { CliAdapter, CliId } from '../src/adapters/cli/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_CLI_IDS: CliId[] = ['claude-code', 'aiden', 'coco', 'codex', 'gemini', 'opencode'];

// ---------------------------------------------------------------------------
// 1. Factory: createCliAdapterSync
// ---------------------------------------------------------------------------

describe('createCliAdapterSync factory', () => {
  it.each(ALL_CLI_IDS)('returns an adapter for "%s"', (id) => {
    const adapter = createCliAdapterSync(id, `/mock/bin/${id}`);
    expect(adapter).toBeDefined();
    expect(adapter.id).toBe(id);
  });

  it('throws for unknown CLI id', () => {
    expect(() => createCliAdapterSync('unknown-cli' as CliId)).toThrow(/Unknown CLI adapter/);
  });

  it.each(ALL_CLI_IDS)('adapter for "%s" has resolvedBin set', (id) => {
    const adapter = createCliAdapterSync(id, `/opt/${id}`);
    expect(adapter.resolvedBin).toBe(`/opt/${id}`);
  });
});

// ---------------------------------------------------------------------------
// 2. buildArgs
// ---------------------------------------------------------------------------

describe('claude-code buildArgs', () => {
  const adapter = createClaudeCodeAdapter('/usr/bin/claude');

  it('new session passes --session-id and permission flags', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: false });
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-1');
    expect(args).toContain('--dangerously-skip-permissions');
    expect(args).not.toContain('--resume');
  });

  it('resume session passes --resume', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-1', resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-1');
    expect(args).not.toContain('--session-id');
  });

  it('disallows plan mode tools', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const idx = args.indexOf('--disallowed-tools');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(args[idx + 1]).toContain('EnterPlanMode');
    expect(args[idx + 1]).toContain('ExitPlanMode');
  });

  it('ignores initialPrompt (not passed via args)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, initialPrompt: 'hello' });
    expect(args).not.toContain('hello');
    expect(adapter.passesInitialPromptViaArgs).toBeFalsy();
  });
});

describe('aiden buildArgs', () => {
  const adapter = createAidenAdapter('/usr/bin/aiden');

  it('new session does not include --resume or session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-2', resume: false });
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('sess-2');
    expect(args).toContain('--permission-mode');
    expect(args).toContain('agentFull');
  });

  it('resume session passes --resume with session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-2', resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-2');
  });
});

describe('coco buildArgs', () => {
  const adapter = createCocoAdapter('/usr/bin/coco');

  it('new session passes --session-id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-3', resume: false });
    expect(args).toContain('--session-id');
    expect(args).toContain('sess-3');
    expect(args).toContain('--yolo');
  });

  it('resume session passes --resume', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-3', resume: true });
    expect(args).toContain('--resume');
    expect(args).toContain('sess-3');
    expect(args).not.toContain('--session-id');
  });

  it('disallows plan mode tools', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    // CoCo uses repeated --disallowed-tool flags
    const indices = args.reduce<number[]>((acc, v, i) => v === '--disallowed-tool' ? [...acc, i] : acc, []);
    expect(indices.length).toBe(2);
    expect(args[indices[0] + 1]).toBe('EnterPlanMode');
    expect(args[indices[1] + 1]).toBe('ExitPlanMode');
  });
});

describe('codex buildArgs', () => {
  const adapter = createCodexAdapter('/usr/bin/codex');

  it('always returns fixed args regardless of session/resume', () => {
    const args1 = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    const args2 = adapter.buildArgs({ sessionId: 'sess-4', resume: true });
    expect(args1).toEqual(args2);
    expect(args1).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(args1).toContain('--no-alt-screen');
  });

  it('does not include session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-4', resume: false });
    expect(args).not.toContain('sess-4');
  });
});

describe('gemini buildArgs', () => {
  const adapter = createGeminiAdapter('/usr/bin/gemini');

  it('basic args include --yolo', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false });
    expect(args).toContain('--yolo');
    expect(args).not.toContain('-i');
  });

  it('passes initialPrompt via -i flag', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false, initialPrompt: 'do something' });
    expect(args).toContain('-i');
    const idx = args.indexOf('-i');
    expect(args[idx + 1]).toBe('do something');
  });

  it('passesInitialPromptViaArgs is true', () => {
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
  });

  it('does not include session id', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-5', resume: false });
    expect(args).not.toContain('sess-5');
  });
});

describe('opencode buildArgs', () => {
  const adapter = createOpenCodeAdapter('/usr/bin/opencode');

  it('returns empty args for basic case', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-6', resume: false });
    expect(args).toEqual([]);
  });

  it('passes initialPrompt via --prompt flag', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-6', resume: false, initialPrompt: 'hello world' });
    expect(args).toContain('--prompt');
    const idx = args.indexOf('--prompt');
    expect(args[idx + 1]).toBe('hello world');
  });

  it('passesInitialPromptViaArgs is true', () => {
    expect(adapter.passesInitialPromptViaArgs).toBe(true);
  });

  it('does not include session id or resume', () => {
    const args = adapter.buildArgs({ sessionId: 'sess-6', resume: true });
    expect(args).not.toContain('sess-6');
    expect(args).not.toContain('--resume');
  });
});

// ---------------------------------------------------------------------------
// 3. completionPattern and readyPattern
// ---------------------------------------------------------------------------

describe('completionPattern', () => {
  it('claude-code matches "Worked for" completion line', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    const lines = [
      '\u2733 Worked for 12s',
      '\u2733 Crunched for 3m',
      '\u2733 Cogitated for 1h',
      '\u2733 Cooked for 45s',
      '\u2733 Churned for 8s',
      '\u2733 Sauteed for 2s',
      '\u2733 Sautéed for 2s',
      '\u2733 Baked for 29s',
      '\u2733 Brewed for 42s',
    ];
    for (const line of lines) {
      expect(adapter.completionPattern!.test(line), `should match: ${line}`).toBe(true);
    }
  });

  it('claude-code does not match unrelated text', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    expect(adapter.completionPattern!.test('Processing...')).toBe(false);
    expect(adapter.completionPattern!.test('Worked on it')).toBe(false);
  });

  it('aiden has no completionPattern', () => {
    expect(createAidenAdapter('/bin/aiden').completionPattern).toBeUndefined();
  });

  it('coco has no completionPattern', () => {
    expect(createCocoAdapter('/bin/coco').completionPattern).toBeUndefined();
  });

  it('codex has no completionPattern', () => {
    expect(createCodexAdapter('/bin/codex').completionPattern).toBeUndefined();
  });

  it('gemini has no completionPattern', () => {
    expect(createGeminiAdapter('/bin/gemini').completionPattern).toBeUndefined();
  });

  it('opencode has no completionPattern', () => {
    expect(createOpenCodeAdapter('/bin/opencode').completionPattern).toBeUndefined();
  });
});

describe('readyPattern', () => {
  it('claude-code matches prompt indicator', () => {
    const adapter = createClaudeCodeAdapter('/bin/claude');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('❯')).toBe(true);
    expect(adapter.readyPattern!.test('some prefix ❯ suffix')).toBe(true);
  });

  it('coco matches status bar indicator', () => {
    const adapter = createCocoAdapter('/bin/coco');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('⏵⏵')).toBe(true);
    expect(adapter.readyPattern!.test('line with ⏵⏵ status')).toBe(true);
  });

  it('codex matches prompt indicator', () => {
    const adapter = createCodexAdapter('/bin/codex');
    expect(adapter.readyPattern).toBeDefined();
    expect(adapter.readyPattern!.test('›')).toBe(true);
    expect(adapter.readyPattern!.test('97% left')).toBe(true);
  });

  it('aiden has no readyPattern', () => {
    expect(createAidenAdapter('/bin/aiden').readyPattern).toBeUndefined();
  });

  it('gemini has no readyPattern', () => {
    expect(createGeminiAdapter('/bin/gemini').readyPattern).toBeUndefined();
  });

  it('opencode has no readyPattern', () => {
    expect(createOpenCodeAdapter('/bin/opencode').readyPattern).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. systemHints
// ---------------------------------------------------------------------------

describe('systemHints', () => {
  it('claude-code has empty systemHints (uses --append-system-prompt instead)', () => {
    expect(createClaudeCodeAdapter('/bin/claude').systemHints).toEqual([]);
  });

  const nonClaudeAdapters: Array<[string, () => CliAdapter]> = [
    ['aiden', () => createAidenAdapter('/bin/aiden')],
    ['coco', () => createCocoAdapter('/bin/coco')],
    ['codex', () => createCodexAdapter('/bin/codex')],
    ['gemini', () => createGeminiAdapter('/bin/gemini')],
    ['opencode', () => createOpenCodeAdapter('/bin/opencode')],
  ];

  it.each(nonClaudeAdapters)('%s systemHints include botmux send routing guidance', (_name, factory) => {
    const hints = factory().systemHints;
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.some(h => h.includes('botmux send'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. id property
// ---------------------------------------------------------------------------

describe('id property', () => {
  const expected: [CliId, () => CliAdapter][] = [
    ['claude-code', () => createClaudeCodeAdapter('/bin/claude')],
    ['aiden', () => createAidenAdapter('/bin/aiden')],
    ['coco', () => createCocoAdapter('/bin/coco')],
    ['codex', () => createCodexAdapter('/bin/codex')],
    ['gemini', () => createGeminiAdapter('/bin/gemini')],
    ['opencode', () => createOpenCodeAdapter('/bin/opencode')],
  ];

  it.each(expected)('adapter id is "%s"', (expectedId, factory) => {
    expect(factory().id).toBe(expectedId);
  });
});

// ---------------------------------------------------------------------------
// 6. altScreen property
// ---------------------------------------------------------------------------

describe('altScreen property', () => {
  it('gemini uses alt screen', () => {
    expect(createGeminiAdapter('/bin/gemini').altScreen).toBe(true);
  });

  it('opencode uses alt screen', () => {
    expect(createOpenCodeAdapter('/bin/opencode').altScreen).toBe(true);
  });

  it('claude-code does not use alt screen', () => {
    expect(createClaudeCodeAdapter('/bin/claude').altScreen).toBe(false);
  });

  it('aiden does not use alt screen', () => {
    expect(createAidenAdapter('/bin/aiden').altScreen).toBe(false);
  });

  it('coco does not use alt screen', () => {
    expect(createCocoAdapter('/bin/coco').altScreen).toBe(false);
  });

  it('codex does not use alt screen', () => {
    expect(createCodexAdapter('/bin/codex').altScreen).toBe(false);
  });
});
