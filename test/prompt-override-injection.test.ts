import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildBotmuxSystemPromptText, buildBotmuxShellHints } from '../src/adapters/cli/shared-hints.js';
import { registerPromptOverrideResolver } from '../src/skills/effective-builtins.js';
import { setPromptOverrideResolver, t } from '../src/i18n/index.js';
import {
  setPromptOverride,
  setCustomizationEnabled,
  resetAllToFactory,
  invalidateCustomizationCache,
} from '../src/services/customization-store.js';

let tmp: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'botmux-promptov-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tmp;
  invalidateCustomizationCache();
});

afterEach(() => {
  // Detach the resolver so it can't leak into other test files sharing i18n.
  setPromptOverrideResolver(undefined);
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  invalidateCustomizationCache();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('prompt-override resolver wired into t() (RED LINE)', () => {
  it('produces byte-identical routing/shell prompts before the resolver is registered', () => {
    // Baseline captured with NO resolver at all (pre-feature behavior).
    const sysBaseZh = buildBotmuxSystemPromptText({ locale: 'zh', botName: 'Bot', botOpenId: 'ou_x' });
    const sysBaseEn = buildBotmuxSystemPromptText({ locale: 'en', botName: 'Bot', botOpenId: 'ou_x' });
    const shellBaseZh = buildBotmuxShellHints('zh');

    // Registering the resolver with an EMPTY store must not change any bytes.
    registerPromptOverrideResolver();
    invalidateCustomizationCache();
    expect(buildBotmuxSystemPromptText({ locale: 'zh', botName: 'Bot', botOpenId: 'ou_x' })).toBe(sysBaseZh);
    expect(buildBotmuxSystemPromptText({ locale: 'en', botName: 'Bot', botOpenId: 'ou_x' })).toBe(sysBaseEn);
    expect(buildBotmuxShellHints('zh')).toEqual(shellBaseZh);
  });

  it('applies a routing-intro override only for the targeted locale', () => {
    registerPromptOverrideResolver();
    const enBaseline = t('ai.routing.intro', undefined, 'en');

    setPromptOverride('zh', 'ai.routing.intro', '【自定义】用 botmux send 回复');
    invalidateCustomizationCache();

    const zhPrompt = buildBotmuxSystemPromptText({ locale: 'zh', botName: 'Bot', botOpenId: 'ou_x' });
    expect(zhPrompt).toContain('【自定义】用 botmux send 回复');
    // English is untouched.
    expect(t('ai.routing.intro', undefined, 'en')).toBe(enBaseline);
  });

  it('master off reverts t() to the shipped string even with an override on disk', () => {
    registerPromptOverrideResolver();
    const shipped = t('ai.routing.intro', undefined, 'zh');

    setPromptOverride('zh', 'ai.routing.intro', 'OVERRIDDEN');
    invalidateCustomizationCache();
    expect(t('ai.routing.intro', undefined, 'zh')).toBe('OVERRIDDEN');

    setCustomizationEnabled(false);
    invalidateCustomizationCache();
    expect(t('ai.routing.intro', undefined, 'zh')).toBe(shipped);
  });

  it('reset-all returns t() to shipped strings', () => {
    registerPromptOverrideResolver();
    const shipped = t('ai.routing.usage_helpers', undefined, 'zh');
    setPromptOverride('zh', 'ai.routing.usage_helpers', 'custom helpers');
    invalidateCustomizationCache();
    expect(t('ai.routing.usage_helpers', undefined, 'zh')).toBe('custom helpers');

    resetAllToFactory();
    invalidateCustomizationCache();
    expect(t('ai.routing.usage_helpers', undefined, 'zh')).toBe(shipped);
  });

  it('a faulty resolver never breaks t() (falls through to shipped)', () => {
    setPromptOverrideResolver(() => { throw new Error('boom'); });
    // Must not throw; returns the shipped dictionary value.
    expect(() => t('ai.routing.intro', undefined, 'zh')).not.toThrow();
    expect(t('ai.routing.intro', undefined, 'zh')).toContain('botmux send');
  });
});
