/**
 * ZCode's model-facing hints must arrive through the channel that actually
 * reaches the model.
 *
 * The interim-progress instruction originally sat in the adapter's static
 * `systemHints` array. Nothing in the repo reads that field — the only path
 * into a prompt is `buildBotmuxShellHints` (session-manager.ts) — so the
 * instruction was silently dead code and ZCode kept going quiet for an entire
 * long turn. These tests pin the working channel so that regression cannot
 * happen quietly again.
 */
import { describe, expect, it } from 'vitest';
import { buildBotmuxShellHints } from '../src/adapters/cli/shared-hints.js';
import { createZcodeAdapter } from '../src/adapters/cli/zcode.js';

describe('ZCode interim progress instruction', () => {
  it.each(['zh', 'en'] as const)('reaches the model through the shell hints (%s, send mode)', locale => {
    const hints = buildBotmuxShellHints(locale, false, 'send', 'zcode').join('\n');
    expect(hints).toContain(locale === 'zh' ? '中途汇报' : 'interim progress');
  });

  it('survives transcript reply-delivery mode too', () => {
    const hints = buildBotmuxShellHints('zh', false, 'transcript', 'zcode').join('\n');
    expect(hints).toContain('中途汇报');
  });

  it('is ZCode-only — other CLIs keep byte-identical hints', () => {
    // Cursor is excluded on purpose: it has its own legitimate background-task
    // note. Every other id must render exactly the no-cliId baseline.
    for (const cliId of ['claude-code', 'codex', 'kimi', 'gemini'] as const) {
      const withCli = buildBotmuxShellHints('zh', false, 'send', cliId).join('\n');
      const baseline = buildBotmuxShellHints('zh', false, 'send').join('\n');
      expect(withCli).toBe(baseline);
    }
  });

  it('the adapter keeps systemHints empty so nobody mistakes it for a model channel', () => {
    // `systemHints` has no consumer; a non-empty array here reads as an
    // instruction that ships and then never arrives.
    expect(createZcodeAdapter(process.execPath).systemHints).toEqual([]);
  });
});
