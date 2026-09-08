/**
 * Guards the claude-code adapter's `reasoningEffort` → `--effort` wiring.
 * Claude's accepted set is low|medium|high|xhigh|max — `ultra` is a
 * codex/traex level Claude answers with `Warning: Unknown --effort value`,
 * so the adapter must filter rather than forward the shared type blindly.
 */
import { describe, it, expect, vi } from 'vitest';

// buildArgs resolves the binary via resolveCommand; return it as-is so the
// emitted flags can be asserted without shelling out.
vi.mock('../src/adapters/cli/registry.js', async (orig) => {
  const actual = await orig<typeof import('../src/adapters/cli/registry.js')>();
  return { ...actual, resolveCommand: (bin: string) => bin };
});

import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import { createSeedAdapter } from '../src/adapters/cli/seed.js';

const BASE = { sessionId: 's1', resume: false } as const;

describe('claude-code adapter buildArgs — reasoningEffort → --effort', () => {
  it('emits --effort for each level Claude Code accepts', () => {
    for (const e of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      const args = createClaudeCodeAdapter('/usr/bin/claude').buildArgs({ ...BASE, reasoningEffort: e });
      const i = args.indexOf('--effort');
      expect(i).toBeGreaterThan(-1);
      expect(args[i + 1]).toBe(e);
    }
  });

  it('drops `ultra` — Claude rejects it (codex/traex-only level)', () => {
    const args = createClaudeCodeAdapter('/usr/bin/claude').buildArgs({ ...BASE, reasoningEffort: 'ultra' });
    expect(args).not.toContain('--effort');
    expect(args.join(' ')).not.toContain('ultra');
  });

  it('omits --effort when no effort is given', () => {
    const args = createClaudeCodeAdapter('/usr/bin/claude').buildArgs({ ...BASE });
    expect(args).not.toContain('--effort');
  });

  it('keeps --model independent of effort', () => {
    const args = createClaudeCodeAdapter('/usr/bin/claude')
      .buildArgs({ ...BASE, model: 'claude-opus-5', reasoningEffort: 'max' });
    const mi = args.indexOf('--model');
    expect(args[mi + 1]).toBe('claude-opus-5');
    const ei = args.indexOf('--effort');
    expect(args[ei + 1]).toBe('max');
  });

  it('does not emit --effort for family variants that never opted in', () => {
    const args = createSeedAdapter('/usr/bin/seed').buildArgs({ ...BASE, reasoningEffort: 'max' });
    expect(args).not.toContain('--effort');
  });
});

// The adapter test above proves the mechanism; this one proves the path. Before
// the config gate learned about claude-code, `reasoningEffort` was normalised to
// undefined while loading bots.json, so the flag could never reach buildArgs no
// matter how correct the adapter was.
describe('claude-code reasoningEffort — reachable from bots.json', () => {
  it('survives config load and reaches buildArgs as --effort', async () => {
    const { parseBotConfigsFromText } = await import('../src/bot-registry.js');
    const [bot] = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'cli_effort_probe',
      larkAppSecret: 'secret',
      cliId: 'claude-code',
      allowedUsers: ['owner@example.com'],
      reasoningEffort: 'xhigh',
    }]));
    expect(bot?.reasoningEffort).toBe('xhigh');

    const args = createClaudeCodeAdapter('/usr/bin/claude')
      .buildArgs({ ...BASE, reasoningEffort: bot!.reasoningEffort });
    const i = args.indexOf('--effort');
    expect(args[i + 1]).toBe('xhigh');
  });

  it('still drops reasoningEffort for a CLI without reasoning support', async () => {
    const { parseBotConfigsFromText } = await import('../src/bot-registry.js');
    const [bot] = parseBotConfigsFromText(JSON.stringify([{
      larkAppId: 'cli_effort_probe2',
      larkAppSecret: 'secret',
      cliId: 'gemini',
      allowedUsers: ['owner@example.com'],
      reasoningEffort: 'xhigh',
    }]));
    expect(bot?.reasoningEffort).toBeUndefined();
  });
});
