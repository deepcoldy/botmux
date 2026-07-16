import { Buffer } from 'node:buffer';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CODEX_APP_CONTEXT_CHUNK_BYTES,
  addCodexAppContext,
  chunkCodexAppContext,
  withCodexAppContext,
} from '../src/utils/codex-app-context.js';

describe('Codex App additional context chunking', () => {
  it('preserves long Chinese and emoji content without exceeding the byte ceiling', () => {
    const source = '经营洞察📈'.repeat(700);
    const chunks = chunkCodexAppContext(source);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(source);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, 'utf8')).toBeLessThanOrEqual(CODEX_APP_CONTEXT_CHUNK_BYTES);
    }
  });

  it('uses fixed suffixed keys and preserves context kind', () => {
    const target: Record<string, { kind: 'application' | 'untrusted'; value: string }> = {};
    addCodexAppContext(target, 'botmux_role', '中'.repeat(1_000), 'application');
    expect(Object.keys(target)).toEqual(['botmux_role_0001', 'botmux_role_0002', 'botmux_role_0003', 'botmux_role_0004']);
    expect(Object.values(target).map(entry => entry.value).join('')).toBe('中'.repeat(1_000));
    expect(Object.values(target).every(entry => entry.kind === 'application')).toBe(true);
  });

  it('preserves 10+ chunks after app-server lexicographic key ordering', () => {
    const source = '上下文'.repeat(CODEX_APP_CONTEXT_CHUNK_BYTES * 5);
    const target: Record<string, { kind: 'application' | 'untrusted'; value: string }> = {};
    addCodexAppContext(target, 'botmux_long', source, 'application');

    const keys = Object.keys(target).sort();
    expect(keys.length).toBeGreaterThan(12);
    expect(keys[8]).toMatch(/_0009$/);
    expect(keys[9]).toMatch(/_0010$/);
    expect(keys.map(key => target[key].value).join('')).toBe(source);
  });

  it('adds a deferred catalog without mutating the original sidecar', () => {
    const original = { text: 'hello', additionalContext: { botmux_sender: { kind: 'untrusted' as const, value: 'Alice' } } };
    const next = withCodexAppContext(original, 'botmux_plugin_skills', '技'.repeat(1_000), 'application');
    expect(original.additionalContext).toEqual({ botmux_sender: { kind: 'untrusted', value: 'Alice' } });
    expect(Object.values(next.additionalContext ?? {}).filter(entry => entry.kind === 'application').length).toBeGreaterThan(1);
  });

  it('keeps fresh-generation Skill catalogs synchronized into the init sidecar', () => {
    const worker = readFileSync(new URL('../src/worker.ts', import.meta.url), 'utf8');
    const refreshStart = worker.indexOf('function refreshCliPluginGeneration');
    const refreshEnd = worker.indexOf('/** v2 read isolation', refreshStart);
    const refresh = worker.slice(refreshStart, refreshEnd);
    expect(refresh).toContain('cfg.prompt = generation.prompt');
    expect(refresh).toContain('cfg.promptCodexAppInput = withCodexAppContext');
    expect(refresh).toContain("'botmux_plugin_skills'");
    expect(refresh.indexOf('cfg.promptCodexAppInput = withCodexAppContext'))
      .toBeGreaterThan(refresh.indexOf('cfg.prompt = generation.prompt'));
  });
});
