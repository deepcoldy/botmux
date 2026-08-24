import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  exportBundle,
  parseBundle,
  previewBundleImport,
  applyBundle,
  serializeBundle,
  BundleError,
  BUNDLE_KIND,
} from '../src/skills/customization-bundle.js';
import {
  setPromptOverride,
  setConditionalLine,
  setSkillOverrideBody,
  setSkillDisabled,
  readCustomizationState,
  readSkillOverrideBody,
  invalidateCustomizationCache,
} from '../src/services/customization-store.js';
import { BUILTIN_SKILLS } from '../src/skills/definitions.js';

let tmp: string;
let prevDataDir: string | undefined;
const SKILL = BUILTIN_SKILLS[0].name;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'botmux-bundle-'));
  prevDataDir = process.env.SESSION_DATA_DIR;
  process.env.SESSION_DATA_DIR = tmp;
  invalidateCustomizationCache();
});
afterEach(() => {
  if (prevDataDir === undefined) delete process.env.SESSION_DATA_DIR;
  else process.env.SESSION_DATA_DIR = prevDataDir;
  invalidateCustomizationCache();
  try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('customization bundle', () => {
  it('exports the current state with skill bodies inlined', () => {
    setPromptOverride('zh', 'ai.routing.intro', 'hi');
    setConditionalLine('ai.routing.no_visible_output_ok', true);
    setSkillOverrideBody(SKILL, 'SKILL BODY');
    setSkillDisabled('botmux-orchestrate', true);
    invalidateCustomizationCache();

    const bundle = exportBundle({ name: 'demo' });
    expect(bundle.kind).toBe(BUNDLE_KIND);
    expect(bundle.name).toBe('demo');
    expect(bundle.promptOverrides?.zh?.['ai.routing.intro']).toBe('hi');
    expect(bundle.conditionalLines?.['ai.routing.no_visible_output_ok']).toBe(true);
    // Body is inlined, not a reference.
    expect(bundle.builtinSkills?.[SKILL]?.body).toBe('SKILL BODY');
    expect(bundle.builtinSkills?.['botmux-orchestrate']?.disabled).toBe(true);
  });

  it('round-trips export → serialize → parse → apply into a clean store', () => {
    setPromptOverride('en', 'ai.routing.usage_helpers', 'custom helpers');
    setSkillOverrideBody(SKILL, 'BODY-X');
    invalidateCustomizationCache();
    const json = serializeBundle(exportBundle({ name: 'rt' }));

    // Wipe the store to simulate importing on a fresh machine.
    rmSync(join(tmp, 'customizations'), { recursive: true, force: true });
    invalidateCustomizationCache();
    expect(readCustomizationState()).toEqual({ schemaVersion: 1 });

    const parsed = parseBundle(json);
    const preview = previewBundleImport(parsed);
    expect(preview.summary.adds).toBe(2);
    expect(preview.summary.replaces).toBe(0);

    applyBundle(parsed, 'import');
    invalidateCustomizationCache();
    expect(readCustomizationState().promptOverrides?.en?.['ai.routing.usage_helpers']).toBe('custom helpers');
    expect(readSkillOverrideBody(SKILL)).toBe('BODY-X');
  });

  it('rejects a bundle with a broken placeholder template', () => {
    const bad = JSON.stringify({
      schemaVersion: 1, kind: BUNDLE_KIND,
      promptOverrides: { zh: { 'ai.available_bots.collapsed_line': '只有 {count} 个' } }, // drops {names}
    });
    expect(() => parseBundle(bad)).toThrow(BundleError);
  });

  it('rejects a non-bundle JSON', () => {
    expect(() => parseBundle('{"kind":"something-else"}')).toThrow(/kind/);
    expect(() => parseBundle('not json')).toThrow(/JSON/);
  });

  it('preview marks unchanged vs replace correctly', () => {
    setPromptOverride('zh', 'ai.routing.intro', 'same');
    invalidateCustomizationCache();
    const bundleSame = parseBundle(JSON.stringify({
      schemaVersion: 1, kind: BUNDLE_KIND, promptOverrides: { zh: { 'ai.routing.intro': 'same' } },
    }));
    expect(previewBundleImport(bundleSame).summary.unchanged).toBe(1);

    const bundleDiff = parseBundle(JSON.stringify({
      schemaVersion: 1, kind: BUNDLE_KIND, promptOverrides: { zh: { 'ai.routing.intro': 'different' } },
    }));
    expect(previewBundleImport(bundleDiff).summary.replaces).toBe(1);
  });
});
