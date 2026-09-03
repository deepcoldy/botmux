/**
 * The model-fallback notice is pinned to the live streaming card (deliberately
 * not sent as its own message). These tests cover the copy for all three kinds
 * in both locales, the friendly model naming, coexistence with the usage-limit
 * line, and disappearance once the fallback is cleared.
 *
 * Run: npx vitest run --project unit test/card-model-fallback-notice.test.ts
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { buildStreamingCard } from '../src/im/lark/card-builder.js';
import { cardModelFallbackNotice } from '../src/im/lark/md-card.js';
import { globalConfigPath, invalidateGlobalConfigCache } from '../src/global-config.js';
import type { ModelFallbackState } from '../src/types.js';

let cardTestHome: string;
beforeEach(() => {
  cardTestHome = mkdtempSync(join(tmpdir(), 'botmux-card-mfb-'));
  vi.stubEnv('HOME', cardTestHome);
  mkdirSync(dirname(globalConfigPath()), { recursive: true });
  invalidateGlobalConfigCache();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  invalidateGlobalConfigCache();
  rmSync(cardTestHome, { recursive: true, force: true });
});

const REFUSAL: ModelFallbackState = {
  uuid: 'u-refusal',
  kind: 'refusal',
  originalModel: 'claude-fable-5-1[1m]',
  fallbackModel: 'claude-opus-4-8[1m]',
  trigger: 'refusal',
  apiRefusalCategory: 'cyber',
};

/** Same 22 positional args as card-builder-stop-compact.test.ts; usage is 17th. */
function build(opts: {
  status?: string;
  usage?: any;
  locale?: string;
  usageLimit?: any;
} = {}): any {
  return JSON.parse(buildStreamingCard(
    'sess-mfb',
    'om_root_mfb',
    'https://example.com/term',
    'Fallback Task',
    '',
    (opts.status ?? 'working') as any,
    'claude-code' as any,
    'hidden' as any,
    undefined,
    undefined,
    false,
    false,
    opts.locale as any,
    opts.usageLimit,
    undefined,
    false,
    opts.usage,
    undefined,
    undefined,
    undefined,
    undefined,
  ));
}

function markdownContents(card: any): string[] {
  return (card.elements as any[])
    .filter(e => e.tag === 'markdown' && typeof e.content === 'string')
    .map(e => e.content);
}

function noticeIn(card: any): string | undefined {
  return markdownContents(card).find(c => c.includes('/model'));
}

describe('cardModelFallbackNotice: copy', () => {
  it('renders the refusal notice with friendly names, category and switch-back hint (zh)', () => {
    expect(cardModelFallbackNotice(REFUSAL, 'zh')).toBe(
      '⚠️ 安全管控降级：Fable 5.1 → Opus 4.8（cyber）· /model fable 切回',
    );
  });

  it('renders the unavailable notice with the raw trigger as the reason (zh)', () => {
    expect(cardModelFallbackNotice({
      uuid: 'u-unavailable',
      kind: 'unavailable',
      originalModel: 'claude-fable-5-1[1m]',
      fallbackModel: 'claude-opus-4-8[1m]',
      trigger: 'overloaded',
    }, 'zh')).toBe(
      '⚠️ 模型不可用已切换：Fable 5.1 → Opus 4.8（overloaded）· /model fable 切回',
    );
  });

  it('renders the consent notice without a reason (zh)', () => {
    expect(cardModelFallbackNotice({
      uuid: 'u-consent',
      kind: 'consent',
      originalModel: 'claude-fable-5-1[1m]',
      fallbackModel: 'claude-opus-4-8[1m]',
    }, 'zh')).toBe(
      '⚠️ 额度限制已切换：Fable 5.1 → Opus 4.8 · /model fable 切回',
    );
  });

  it('renders English copy for all three kinds', () => {
    const en = (['refusal', 'unavailable', 'consent'] as const)
      .map(kind => cardModelFallbackNotice({ ...REFUSAL, kind }, 'en')!);
    expect(en[0]).toBe(
      '⚠️ Safety fallback: Fable 5.1 → Opus 4.8 (cyber) · /model fable to switch back',
    );
    expect(en[1]).toBe(
      '⚠️ Model unavailable: Fable 5.1 → Opus 4.8 (refusal) · /model fable to switch back',
    );
    expect(en[2]).toBe(
      '⚠️ Quota fallback: Fable 5.1 → Opus 4.8 · /model fable to switch back',
    );
    for (const line of en) expect(line).not.toMatch(/[一-鿿]/);
  });

  it('drops the reason when the record carries none', () => {
    expect(cardModelFallbackNotice({ ...REFUSAL, apiRefusalCategory: undefined }, 'zh'))
      .toBe('⚠️ 安全管控降级：Fable 5.1 → Opus 4.8 · /model fable 切回');
  });

  it('names known Claude models and keeps an unknown id verbatim', () => {
    const label = (originalModel: string, fallbackModel: string) =>
      cardModelFallbackNotice({ ...REFUSAL, kind: 'consent', originalModel, fallbackModel }, 'zh')!;
    expect(label('claude-opus-5', 'claude-haiku-4-5-20251001')).toContain('Opus 5 → Haiku 4.5');
    expect(label('claude-sonnet-5', 'claude-opus-4-8[1m]')).toContain('Sonnet 5 → Opus 4.8');
    expect(label('claude-opus-5', 'claude-opus-5')).toContain('/model opus 切回');
    // Unrecognised id: raw form is kept and the alias falls back to it.
    const custom = label('internal-model-x', 'claude-opus-5');
    expect(custom).toContain('internal-model-x → Opus 5');
    expect(custom).toContain('/model internal-model-x');
  });

  it('truncates an absurdly long model id and escapes markdown control chars', () => {
    const line = cardModelFallbackNotice({
      ...REFUSAL,
      kind: 'consent',
      originalModel: `x*_\`${'y'.repeat(80)}`,
      fallbackModel: 'claude-opus-5',
    }, 'zh')!;
    expect(line).toContain('…');
    expect(line).toContain('x\\*\\_\\`');
    expect(line.length).toBeLessThan(200);
  });

  it('bounds the /model argument of an unrecognised id, like the labels', () => {
    // The alias is transcript-derived too, so leaving it unbounded would blow
    // up the very line the labels are truncated to keep short.
    const line = cardModelFallbackNotice({
      ...REFUSAL,
      kind: 'consent',
      originalModel: 'internal-model-'.repeat(20),
      fallbackModel: 'claude-opus-5',
    }, 'zh')!;
    expect(line.length).toBeLessThan(200);
    expect(line).toContain('…');
    expect(line).not.toContain('internal-model-internal-model-internal-model-');
    // A real-length unrecognised id is still echoed whole and stays actionable.
    expect(cardModelFallbackNotice({
      ...REFUSAL,
      kind: 'consent',
      originalModel: 'claude-3-7-sonnet-20250219',
      fallbackModel: 'claude-opus-5',
    }, 'zh')).toContain('/model claude-3-7-sonnet-20250219');
  });

  it('returns null with no fallback or an incomplete one', () => {
    expect(cardModelFallbackNotice(undefined, 'zh')).toBeNull();
    expect(cardModelFallbackNotice({ ...REFUSAL, fallbackModel: '' }, 'zh')).toBeNull();
  });
});

describe('buildStreamingCard: model-fallback notice placement', () => {
  it('adds the notice when the usage snapshot carries a fallback', () => {
    const card = build({ usage: { context: null, tokens: null, modelFallback: REFUSAL }, locale: 'zh' });
    expect(noticeIn(card)).toContain('安全管控降级');
  });

  it('renders nothing once the fallback is cleared', () => {
    const withNotice = build({ usage: { context: null, tokens: null, modelFallback: REFUSAL } });
    const cleared = build({ usage: { context: null, tokens: null } });
    expect(noticeIn(cleared)).toBeUndefined();
    // The notice is a single trailing element; nothing else changes.
    expect(cleared.elements.length).toBe(withNotice.elements.length - 1);
  });

  it('is pinned as the last element, in small grey text, below the action rows', () => {
    const card = build({
      usage: { context: { usedTokens: 1000, windowTokens: 1_000_000, percentUsed: 0.1 }, tokens: { in: 1000, out: 50 }, modelFallback: REFUSAL },
      locale: 'zh',
    });
    const elements = card.elements as any[];
    const last = elements[elements.length - 1];
    expect(last.tag).toBe('markdown');
    expect(last.text_size).toBe('x-small');
    expect(last.content).toMatch(/^<font color='grey'>⚠️ 安全管控降级：.*<\/font>$/);
    // Below the button rows and below the usage line, never above them.
    expect(elements.findIndex(e => e.tag === 'action')).toBeGreaterThanOrEqual(0);
    expect(elements.findIndex(e => e.tag === 'action')).toBeLessThan(elements.length - 1);
    const usageIdx = elements.findIndex(e => typeof e.content === 'string' && e.content.includes('上下文'));
    expect(usageIdx).toBeGreaterThanOrEqual(0);
    expect(usageIdx).toBeLessThan(elements.length - 1);
  });

  it('renders nothing when no usage snapshot is supplied at all', () => {
    expect(noticeIn(build({}))).toBeUndefined();
  });

  it('coexists with the usage-limit notice and stays below it', () => {
    const card = build({
      status: 'limited',
      usageLimit: { retryReady: false, retryLabel: '10:40pm' },
      usage: { context: null, tokens: null, modelFallback: REFUSAL },
      locale: 'zh',
    });
    const contents = markdownContents(card);
    const limitIdx = contents.findIndex(c => c.includes('使用限额'));
    const fallbackIdx = contents.findIndex(c => c.includes('安全管控降级'));
    expect(limitIdx).toBeGreaterThanOrEqual(0);
    expect(fallbackIdx).toBeGreaterThan(limitIdx);
  });

  it('follows the card locale', () => {
    const card = build({ usage: { context: null, tokens: null, modelFallback: REFUSAL }, locale: 'en' });
    expect(noticeIn(card)).toContain('Safety fallback');
  });
});
