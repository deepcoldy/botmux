/**
 * Trigger-user CLI authentication — the policy object.
 *
 * These tests pin the two decisions that make the feature safe to ship:
 *
 *   1. **Default off, and off means absent.** A bot without the field takes no
 *      part in credential resolution at all.
 *   2. **No "borrow another person's login" setting exists.** The fallback
 *      accepts only "the bot's own identity" or "fail" — asking for the machine
 *      login is refused with a message saying so, not silently normalized.
 *
 * Plus the asymmetry between the two CLIs: `bytedcli` has no non-human
 * identity, so for it "unauthorized" always means the call cannot run, even
 * when the configured fallback says `bot-identity`.
 *
 * Run:  npx vitest run --project unit test/trigger-user-auth.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  parseTriggerUserAuthConfig,
  triggerUserAuthApplies,
  unauthorizedOutcomeFor,
  TriggerUserAuthConfigError,
  TRIGGER_USER_AUTH_TOOLS,
} from '../src/services/trigger-user-auth.js';

describe('parseTriggerUserAuthConfig', () => {
  it('treats an absent field as "not configured at all"', () => {
    expect(parseTriggerUserAuthConfig(undefined)).toBeNull();
    expect(parseTriggerUserAuthConfig(null)).toBeNull();
  });

  it('defaults to disabled when the object omits `enabled`', () => {
    expect(parseTriggerUserAuthConfig({})).toEqual({
      enabled: false,
      tools: [...TRIGGER_USER_AUTH_TOOLS],
      fallback: 'bot-identity',
    });
  });

  // Enabling without naming tools means the operator asked for the boundary —
  // apply it everywhere rather than nowhere.
  it('enabling without `tools` covers every supported tool', () => {
    const config = parseTriggerUserAuthConfig({ enabled: true });
    expect(config?.tools).toEqual([...TRIGGER_USER_AUTH_TOOLS]);
  });

  it('keeps an explicit single-tool selection and de-duplicates', () => {
    expect(parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'] })?.tools)
      .toEqual(['lark-cli']);
    expect(parseTriggerUserAuthConfig({ enabled: true, tools: ['bytedcli', 'bytedcli'] })?.tools)
      .toEqual(['bytedcli']);
  });

  it('defaults the fallback to the bot\'s own identity', () => {
    expect(parseTriggerUserAuthConfig({ enabled: true })?.fallback).toBe('bot-identity');
  });

  it('accepts fallback: none', () => {
    expect(parseTriggerUserAuthConfig({ enabled: true, fallback: 'none' })?.fallback).toBe('none');
  });

  // The whole point of the feature is to stop using someone else's login, so
  // there must be no config value that asks for it — and the refusal has to say
  // why, or an operator will read it as a typo and keep trying.
  it('refuses a machine-login fallback and explains that it never exists', () => {
    for (const asked of ['device', 'machine', 'runtime', 'device-identity']) {
      let thrown: Error | undefined;
      try { parseTriggerUserAuthConfig({ enabled: true, fallback: asked }); }
      catch (e) { thrown = e as Error; }
      expect(thrown).toBeInstanceOf(TriggerUserAuthConfigError);
      expect(thrown!.message).toContain(asked);
      expect(thrown!.message).toContain('never available');
    }
  });

  // A typo'd tool name must not leave the operator believing a boundary is
  // enforced when it is not.
  it('rejects an unknown tool by name instead of dropping it', () => {
    expect(() => parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli', 'kubectl'] }))
      .toThrow(/kubectl/);
  });

  it('rejects wrong shapes for the field and its members', () => {
    expect(() => parseTriggerUserAuthConfig('yes')).toThrow(TriggerUserAuthConfigError);
    expect(() => parseTriggerUserAuthConfig([])).toThrow(TriggerUserAuthConfigError);
    expect(() => parseTriggerUserAuthConfig({ enabled: 'true' })).toThrow(/enabled/);
    expect(() => parseTriggerUserAuthConfig({ enabled: true, tools: 'lark-cli' })).toThrow(/tools/);
  });
});

describe('triggerUserAuthApplies', () => {
  it('is false when unconfigured or disabled', () => {
    expect(triggerUserAuthApplies(null, 'lark-cli')).toBe(false);
    expect(triggerUserAuthApplies(undefined, 'lark-cli')).toBe(false);
    expect(triggerUserAuthApplies(parseTriggerUserAuthConfig({ enabled: false }), 'lark-cli')).toBe(false);
  });

  it('is scoped to the selected tools', () => {
    const config = parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'] });
    expect(triggerUserAuthApplies(config, 'lark-cli')).toBe(true);
    expect(triggerUserAuthApplies(config, 'bytedcli')).toBe(false);
  });

  it('is inert when enabled with an empty tool list', () => {
    const config = parseTriggerUserAuthConfig({ enabled: true, tools: [] });
    expect(config?.enabled).toBe(true);
    for (const tool of TRIGGER_USER_AUTH_TOOLS) {
      expect(triggerUserAuthApplies(config, tool)).toBe(false);
    }
  });
});

describe('unauthorizedOutcomeFor', () => {
  it('leaves ungoverned tools on their existing behavior', () => {
    expect(unauthorizedOutcomeFor(null, 'bytedcli')).toBe('bot-identity');
    const larkOnly = parseTriggerUserAuthConfig({ enabled: true, tools: ['lark-cli'], fallback: 'none' });
    expect(unauthorizedOutcomeFor(larkOnly, 'bytedcli')).toBe('bot-identity');
  });

  it('lets lark-cli degrade to the bot\'s own identity', () => {
    const config = parseTriggerUserAuthConfig({ enabled: true });
    expect(unauthorizedOutcomeFor(config, 'lark-cli')).toBe('bot-identity');
  });

  // bytedcli offers only SSO personal login: no service account, no AK/SK.
  // Reporting `bot-identity` here would produce a call that fails anyway, with
  // a misleading reason.
  it('fails for bytedcli even under fallback: bot-identity', () => {
    const config = parseTriggerUserAuthConfig({ enabled: true, fallback: 'bot-identity' });
    expect(unauthorizedOutcomeFor(config, 'bytedcli')).toBe('fail');
  });

  it('fails for every governed tool under fallback: none', () => {
    const config = parseTriggerUserAuthConfig({ enabled: true, fallback: 'none' });
    for (const tool of TRIGGER_USER_AUTH_TOOLS) {
      expect(unauthorizedOutcomeFor(config, tool)).toBe('fail');
    }
  });
});
