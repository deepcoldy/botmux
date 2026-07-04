/**
 * Agent preset model: build (secret-free allow-list), serialize, and load
 * (zod-validated) round-trip.
 *
 * The headline guarantee is that buildPreset NEVER leaks a secret even when
 * handed a full bot config, because it copies an explicit allow-list instead of
 * spreading its input.
 *
 * Run: pnpm vitest run test/agent-preset.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  PRESET_VERSION,
  PRESET_GUIDE,
  buildPreset,
  serializePreset,
  loadPreset,
  slugifyForFilename,
  presetFilename,
} from '../src/setup/agent-preset.js';

describe('buildPreset — secret-free allow-list', () => {
  it('drops every non-allow-listed field, even secrets, from a full bot config', () => {
    const preset = buildPreset({
      cliId: 'claude-code',
      model: 'sonnet',
      teamRole: '# 后端 bot\n擅长服务端排查。',
      capability: '后端 bot，擅长服务端排查',
      sourceName: 'backend',
      // Everything below is identity/deployment/secret material and must NOT leak:
      larkAppId: 'cli_xxx_secret_app',
      larkAppSecret: 'super-secret-value',
      allowedUsers: ['alice@example.com'],
      allowedChatGroups: ['oc_team'],
      oncallChats: ['oc_oncall'],
      workingDir: '/Users/alice/projects',
    });

    // Structural guarantee: the object carries ONLY allow-listed keys — no
    // larkAppId / larkAppSecret / allowedUsers / workingDir keys sneak in.
    expect(Object.keys(preset).sort()).toEqual(
      ['botmuxPreset', 'capability', 'cliId', 'guide', 'model', 'sourceName', 'teamRole'].sort(),
    );
    for (const leaked of ['larkAppId', 'larkAppSecret', 'allowedUsers', 'allowedChatGroups', 'oncallChats', 'workingDir']) {
      expect(preset).not.toHaveProperty(leaked);
    }

    // Value guarantee: no secret VALUE leaks into the serialized JSON. (We check
    // values, not key names — the guide text deliberately *names* the excluded
    // fields to warn the recipient, so the field names themselves do appear.)
    const serialized = serializePreset(preset);
    for (const secretValue of [
      'cli_xxx_secret_app',
      'super-secret-value',
      'alice@example.com',
      'oc_team',
      'oc_oncall',
      '/Users/alice/projects',
    ]) {
      expect(serialized).not.toContain(secretValue);
    }
  });

  it('omits optional fields that are empty / null / undefined', () => {
    const preset = buildPreset({ cliId: 'aiden', model: null, teamRole: '', capability: undefined });
    expect(preset).toEqual({
      botmuxPreset: PRESET_VERSION,
      cliId: 'aiden',
      guide: PRESET_GUIDE,
    });
    expect(preset).not.toHaveProperty('model');
    expect(preset).not.toHaveProperty('teamRole');
    expect(preset).not.toHaveProperty('capability');
    expect(preset).not.toHaveProperty('sourceName');
  });
});

describe('buildPreset — version + guide stamping', () => {
  it('always stamps the current version and the embedded guide', () => {
    const preset = buildPreset({ cliId: 'codex' });
    expect(preset.botmuxPreset).toBe(PRESET_VERSION);
    expect(preset.guide).toBe(PRESET_GUIDE);
    expect(preset.guide).toContain('不包含任何凭证');
  });
});

describe('serialize ↔ load round-trip', () => {
  it('loadPreset(serializePreset(x)) deep-equals x', () => {
    const preset = buildPreset({
      cliId: 'gemini',
      model: 'gemini-2.5-pro',
      teamRole: 'PERSONA',
      capability: 'CAP',
      sourceName: 'researcher',
    });
    const loaded = loadPreset(serializePreset(preset));
    expect(loaded).toEqual(preset);
  });

  it('round-trips a minimal preset (no optional fields)', () => {
    const preset = buildPreset({ cliId: 'cursor' });
    expect(loadPreset(serializePreset(preset))).toEqual(preset);
  });
});

describe('slugifyForFilename', () => {
  it('replaces spaces / slashes / illegal chars with a single dash', () => {
    expect(slugifyForFilename('Backend Bot/01')).toBe('Backend-Bot-01');
    expect(slugifyForFilename('a  b\t/\\c')).toBe('a-b-c');
    expect(slugifyForFilename('weird:*?<>|name')).toBe('weird-name');
  });

  it('keeps Unicode letters/digits and _ . -', () => {
    expect(slugifyForFilename('后端_bot.v2-x')).toBe('后端_bot.v2-x');
  });

  it('trims leading/trailing separators and collapses repeats', () => {
    expect(slugifyForFilename('  --foo--  ')).toBe('foo');
    expect(slugifyForFilename('...name...')).toBe('name');
  });

  it('returns empty string when nothing usable remains', () => {
    expect(slugifyForFilename('   ')).toBe('');
    expect(slugifyForFilename('/// \\\\')).toBe('');
  });
});

describe('presetFilename', () => {
  it('prefers the (slugified) name', () => {
    expect(presetFilename('Backend Bot', 'cli_app_1')).toBe('Backend-Bot.botmux-preset.json');
  });

  it('falls back to appId when name is absent', () => {
    expect(presetFilename(undefined, 'cli_app_1')).toBe('cli_app_1.botmux-preset.json');
  });

  it('falls back to appId when name slugs to empty', () => {
    expect(presetFilename('///', 'cli_app_1')).toBe('cli_app_1.botmux-preset.json');
  });

  it('falls back to "bot" when both slug to empty', () => {
    expect(presetFilename('  ', '///')).toBe('bot.botmux-preset.json');
  });

  it('never contains path separators', () => {
    const name = presetFilename('a/b/c', 'cli_x');
    expect(name).not.toContain('/');
    expect(name).not.toContain('\\');
  });
});

describe('loadPreset — rejects bad input', () => {
  it('throws on malformed JSON', () => {
    expect(() => loadPreset('{ not json')).toThrow(/JSON/);
  });

  it('throws on a wrong version', () => {
    const wrong = JSON.stringify({ botmuxPreset: PRESET_VERSION + 1, cliId: 'claude-code', guide: 'g' });
    expect(() => loadPreset(wrong)).toThrow(/botmuxPreset/);
  });

  it('throws when the version marker is missing', () => {
    const noMarker = JSON.stringify({ cliId: 'claude-code', guide: 'g' });
    expect(() => loadPreset(noMarker)).toThrow();
  });

  it('throws when a required field is missing', () => {
    const noCli = JSON.stringify({ botmuxPreset: PRESET_VERSION, guide: 'g' });
    expect(() => loadPreset(noCli)).toThrow();
  });

  it('strips unknown extra keys but keeps the preset valid', () => {
    const withExtra = JSON.stringify({
      botmuxPreset: PRESET_VERSION,
      cliId: 'claude-code',
      guide: 'g',
      somethingFuture: 'ignored',
    });
    const loaded = loadPreset(withExtra);
    expect(loaded).not.toHaveProperty('somethingFuture');
    expect(loaded.cliId).toBe('claude-code');
  });
});
