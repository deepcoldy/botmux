import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { syncNativeGatewayDataDirMark } from '../src/core/native-gateway-session.js';
import {
  readCustomizationState,
  customizationEnabled,
  customizationsRoot,
  setCustomizationEnabled,
  setPromptOverride,
  setConditionalLine,
  setSkillOverrideBody,
  setSkillDisabled,
  resetAllToFactory,
  rollbackToSnapshot,
  listSnapshots,
  replaceState,
  invalidateCustomizationCache,
  CUSTOMIZATION_STORE_READ_ONLY,
  CUSTOMIZATION_SCOPE_HAS_NO_SKILLS,
} from '../src/services/customization-store.js';

/**
 * Two independent customization stores in one process (the Dashboard edits both):
 * the scope-less / `feishu` store and the `wecom` store. Whatever is done to one
 * — writes, the master switch, history, rollback, reset, import — never shows in
 * the other, including through the short-TTL read cache.
 */
let tmp: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'botmux-czscope-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tmp;
  invalidateCustomizationCache();
});
afterEach(() => {
  vi.unstubAllEnvs();
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  invalidateCustomizationCache();
  rmSync(tmp, { recursive: true, force: true });
});

const zh = (scope?: 'feishu' | 'wecom') => readCustomizationState(scope).promptOverrides?.zh ?? {};

describe('customization store scopes', () => {
  it('a scope-less caller is the feishu store at <dataDir>/customizations; wecom sits beside it', () => {
    setPromptOverride('zh', 'ai.routing.intro', 'FEISHU');
    setPromptOverride('zh', 'ai.routing.hidden_context_defense', 'WECOM', 'wecom');
    expect(customizationsRoot()).toBe(join(tmp, 'customizations'));
    expect(customizationsRoot('feishu')).toBe(join(tmp, 'customizations'));
    expect(customizationsRoot('wecom')).toBe(join(tmp, 'customizations-wecom'));
    expect(readdirSync(tmp).sort()).toEqual(['customizations', 'customizations-wecom']);
    expect(zh()).toEqual({ 'ai.routing.intro': 'FEISHU' });
    expect(zh('feishu')).toEqual({ 'ai.routing.intro': 'FEISHU' });
    expect(zh('wecom')).toEqual({ 'ai.routing.hidden_context_defense': 'WECOM' });
  });

  it('a cached read of one scope never answers a read of the other', () => {
    setPromptOverride('zh', 'k.feishu', 'F');
    setPromptOverride('zh', 'k.wecom', 'W', 'wecom');
    // Both reads land inside the same TTL window, the first one populating the cache.
    expect(zh('feishu')).toEqual({ 'k.feishu': 'F' });
    expect(zh('wecom')).toEqual({ 'k.wecom': 'W' });
    expect(zh('feishu')).toEqual({ 'k.feishu': 'F' });
    // A write to one scope refreshes that scope only; the other keeps serving its own.
    setPromptOverride('zh', 'k.wecom2', 'W2', 'wecom');
    expect(zh('wecom')).toEqual({ 'k.wecom': 'W', 'k.wecom2': 'W2' });
    expect(zh('feishu')).toEqual({ 'k.feishu': 'F' });
  });

  it('keeps the master switches independent', () => {
    setCustomizationEnabled(false, 'wecom');
    expect(customizationEnabled('wecom')).toBe(false);
    expect(customizationEnabled()).toBe(true);
    setCustomizationEnabled(false);
    setCustomizationEnabled(true, 'wecom');
    expect(customizationEnabled()).toBe(false);
    expect(customizationEnabled('wecom')).toBe(true);
  });

  it('keeps history, rollback and reset-to-factory inside their scope', () => {
    setPromptOverride('zh', 'k.f', 'F1');
    setPromptOverride('zh', 'k.w', 'W1', 'wecom');
    setPromptOverride('zh', 'k.w', 'W2', 'wecom');
    const feishuHistory = listSnapshots();
    const wecomHistory = listSnapshots('wecom');
    expect(feishuHistory.map(s => s.label)).toEqual(['set k.f (zh)']);
    expect(wecomHistory.map(s => s.label)).toEqual(['set k.w (zh)', 'set k.w (zh)']);
    // A Feishu snapshot is unknown to the WeCom store.
    expect(() => rollbackToSnapshot(feishuHistory[0].id, 'wecom')).toThrow('snapshot_not_found');
    // Reset WeCom: Feishu keeps its override.
    resetAllToFactory('wecom');
    expect(zh('wecom')).toEqual({});
    expect(zh()).toEqual({ 'k.f': 'F1' });
    // Roll WeCom back to just before the reset; Feishu untouched again.
    const beforeReset = listSnapshots('wecom').find(s => s.label === 'reset all to factory')!;
    rollbackToSnapshot(beforeReset.id, 'wecom');
    expect(zh('wecom')).toEqual({ 'k.w': 'W2' });
    expect(zh()).toEqual({ 'k.f': 'F1' });
    expect(listSnapshots().map(s => s.label)).toEqual(['set k.f (zh)']);
    // And the other way round: resetting Feishu leaves WeCom.
    resetAllToFactory();
    expect(zh()).toEqual({});
    expect(zh('wecom')).toEqual({ 'k.w': 'W2' });
  });

  it('writes one store while the other store\'s lock is held', () => {
    setPromptOverride('zh', 'k.f', 'F');
    // A live holder (this very process) owns the Feishu store's lock.
    writeFileSync(join(customizationsRoot(), 'state.json.lock'), String(process.pid));
    const started = Date.now();
    setPromptOverride('zh', 'k.w', 'W', 'wecom');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(zh('wecom')).toEqual({ 'k.w': 'W' });
    rmSync(join(customizationsRoot(), 'state.json.lock'));
  });

  it('replaces only its own scope on import', () => {
    setPromptOverride('zh', 'k.f', 'F1');
    setConditionalLine('ai.routing.no_visible_output_ok', true);
    replaceState({ schemaVersion: 1, promptOverrides: { en: { 'k.w': 'IMPORTED' } } }, {}, 'import bundle', 'wecom');
    expect(readCustomizationState('wecom').promptOverrides).toEqual({ en: { 'k.w': 'IMPORTED' } });
    expect(readCustomizationState().promptOverrides).toEqual({ zh: { 'k.f': 'F1' } });
    expect(readCustomizationState().conditionalLines).toEqual({ 'ai.routing.no_visible_output_ok': true });
  });

  it('refuses built-in skill overrides in the wecom scope and writes nothing', () => {
    expect(() => setSkillOverrideBody('botmux-send', 'body', 'wecom')).toThrow(CUSTOMIZATION_SCOPE_HAS_NO_SKILLS);
    expect(() => setSkillDisabled('botmux-send', true, 'wecom')).toThrow(CUSTOMIZATION_SCOPE_HAS_NO_SKILLS);
    expect(() => replaceState({ schemaVersion: 1, builtinSkills: { 'botmux-send': { disabled: true } } }, {}, 'import', 'wecom'))
      .toThrow(CUSTOMIZATION_SCOPE_HAS_NO_SKILLS);
    expect(existsSync(customizationsRoot('wecom'))).toBe(false);
    // The Feishu scope still takes them.
    setSkillDisabled('botmux-send', true);
    expect(readCustomizationState().builtinSkills?.['botmux-send']?.disabled).toBe(true);
  });

  it('refuses every mutation, in both scopes, inside a native gateway core', () => {
    // One prior write per scope, so rollback has a real snapshot to aim at.
    setPromptOverride('zh', 'k.f', 'F');
    setPromptOverride('zh', 'k.w', 'W', 'wecom');
    const tree = () => ['customizations', 'customizations-wecom'].flatMap(d => readdirSync(join(tmp, d), { recursive: true }).map(f => `${d}/${f}`)).sort();
    const before = tree();
    const snapshots = { feishu: listSnapshots()[0].id, wecom: listSnapshots('wecom')[0].id };
    vi.stubEnv('BOTMUX_CORE_ONLY', '1');
    vi.stubEnv('BOTMUX_NATIVE_GATEWAY_CORE', '1');
    for (const scope of ['feishu', 'wecom'] as const) {
      const attempts: Array<() => unknown> = [
        () => setCustomizationEnabled(false, scope),
        () => setPromptOverride('zh', 'ai.routing.hidden_context_defense', 'x', scope),
        () => setConditionalLine('ai.routing.no_visible_output_ok', true, scope),
        () => resetAllToFactory(scope),
        () => rollbackToSnapshot(snapshots[scope], scope),
        () => replaceState({ schemaVersion: 1 }, {}, 'import', scope),
      ];
      if (scope === 'feishu') {
        attempts.push(() => setSkillOverrideBody('botmux-send', 'b'), () => setSkillDisabled('botmux-send', true));
      }
      for (const attempt of attempts) expect(attempt).toThrow(CUSTOMIZATION_STORE_READ_ONLY);
    }
    expect(tree()).toEqual(before);
    // Reads keep working.
    expect(zh('wecom')).toEqual({ 'k.w': 'W' });
    // A bare core-only service (no native gateway mark) still writes its own store.
    vi.stubEnv('BOTMUX_NATIVE_GATEWAY_CORE', '');
    setPromptOverride('zh', 'k', 'v');
    expect(zh()).toEqual({ 'k.f': 'F', k: 'v' });
  });

  it('refuses every mutation in a CLI session of a native gateway core (its store carries the mark)', () => {
    const core = join(tmp, 'core-state');
    syncNativeGatewayDataDirMark(core, true);
    // What reaches such a session: its core's store, never the native mark itself.
    vi.stubEnv('SESSION_DATA_DIR', core);
    vi.stubEnv('BOTMUX_CORE_ONLY_DATA_DIR', core);
    for (const scope of ['feishu', 'wecom'] as const) {
      expect(() => setPromptOverride('zh', 'k', 'v', scope)).toThrow(CUSTOMIZATION_STORE_READ_ONLY);
      expect(() => setCustomizationEnabled(false, scope)).toThrow(CUSTOMIZATION_STORE_READ_ONLY);
    }
    expect(readdirSync(core)).toEqual(['.native-gateway-core']);
    // The same session of a bare core-only service (no mark) writes its own store.
    syncNativeGatewayDataDirMark(core, false);
    setPromptOverride('zh', 'k', 'v');
    expect(readCustomizationState().promptOverrides).toEqual({ zh: { k: 'v' } });
  });
});
