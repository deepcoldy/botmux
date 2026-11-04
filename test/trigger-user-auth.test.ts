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
  TriggerUserAuthConfigError,
  TRIGGER_USER_AUTH_TOOLS,
  tokenStoreProtection, credentialSourceOf, delegatesOnMention } from '../src/services/trigger-user-auth.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

describe('parseTriggerUserAuthConfig', () => {
  it('treats an absent field as "not configured at all"', () => {
    expect(parseTriggerUserAuthConfig(undefined)).toBeNull();
    expect(parseTriggerUserAuthConfig(null)).toBeNull();
  });

  it('defaults to disabled when the object omits `enabled`', () => {
    expect(parseTriggerUserAuthConfig({})).toEqual({
      enabled: false,
      credentialSource: 'auto',
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

// An honest report, not a reassurance. Botmux keeps each token 0600, but the
// agent runs as the SAME OS user, so unless the OS stops it the agent can read
// every person's token file directly. Only the allowlist sandbox stops it:
// scratch isolates writes and keeps the disk (other people's tokens and login
// state included) readable.
describe('tokenStoreProtection', () => {
  it('counts only the allowlist sandbox as protecting the token store', () => {
    expect(tokenStoreProtection('oncall')).toEqual({ enforced: true });
    expect(tokenStoreProtection('scratch').enforced).toBe(false);
    expect(tokenStoreProtection('off').enforced).toBe(false);
  });

  it('tells a scratch bot something different from a bot with no sandbox', () => {
    expect(tokenStoreProtection('scratch').advisory).toBeTruthy();
    expect(tokenStoreProtection('off').advisory).toBeTruthy();
    expect(tokenStoreProtection('scratch').advisory).not.toBe(tokenStoreProtection('off').advisory);
  });

  it('points at the Dashboard entry and mode the operator actually sees', () => {
    // Both sides come from real data: the advisory must name the labels the
    // Dashboard renders, or an operator cannot find the switch it describes.
    const tr = createDashboardTranslator('zh');
    for (const mode of ['off', 'scratch'] as const) {
      const advisory = tokenStoreProtection(mode).advisory!;
      for (const label of [tr('nav.botDefaults'), tr('botDefaults.tabSecurity'), tr('botDefaults.sectionSandbox'), tr('botDefaults.sandboxModeOncall')]) {
        expect(advisory, `${mode}: ${label}`).toContain(label);
      }
    }
  });
});

// gitHost / gitTokenExchangeUrl are deployment-specific, so they are configured
// rather than compiled in — which means the parser is the only thing standing
// between a typo and a broken (or unsafe) git setup.
describe('git attribution settings', () => {
  it('accepts a bare hostname and an https endpoint', () => {
    const c = parseTriggerUserAuthConfig({
      enabled: true,
      gitHost: 'code.example.com',
      gitTokenExchangeUrl: 'https://gw.example.com/jwt_to_code_base',
    });
    expect(c?.gitHost).toBe('code.example.com');
    expect(c?.gitTokenExchangeUrl).toBe('https://gw.example.com/jwt_to_code_base');
  });

  it('leaves git alone when unset', () => {
    const c = parseTriggerUserAuthConfig({ enabled: true });
    expect(c?.gitHost).toBeUndefined();
    expect(c?.gitTokenExchangeUrl).toBeUndefined();
  });

  // The host is interpolated into git config keys AND into a shell script, so a
  // value carrying a scheme, path or metacharacter would corrupt both.
  it('rejects a host that is not a bare hostname', () => {
    for (const bad of ['https://code.example.com', 'code.example.com/path', 'a b', 'x;rm -rf /']) {
      expect(() => parseTriggerUserAuthConfig({ enabled: true, gitHost: bad }))
        .toThrow(/gitHost/);
    }
  });

  // This endpoint receives a live ByteCloud JWT; plaintext http would put a
  // credential on the wire.
  it('refuses a non-https exchange endpoint', () => {
    expect(() => parseTriggerUserAuthConfig({
      enabled: true, gitTokenExchangeUrl: 'http://gw.example.com/x',
    })).toThrow(/https/);
    expect(() => parseTriggerUserAuthConfig({
      enabled: true, gitTokenExchangeUrl: 'not-a-url',
    })).toThrow(/absolute URL/);
  });
});

describe('credentialSource', () => {
  it('defaults to auto when absent', () => {
    const cfg = parseTriggerUserAuthConfig({ enabled: true });
    expect(cfg?.credentialSource).toBe('auto');
    expect(credentialSourceOf(cfg)).toBe('auto');
    expect(credentialSourceOf(null)).toBe('auto');
    expect(credentialSourceOf({})).toBe('auto');
  });

  it.each(['auto', 'platform', 'local'] as const)('accepts %s', (source) => {
    expect(parseTriggerUserAuthConfig({ enabled: true, credentialSource: source })?.credentialSource).toBe(source);
  });

  it.each(['device', 'machine', 'owner', 1, true])('rejects %s', (bad) => {
    expect(() => parseTriggerUserAuthConfig({ enabled: true, credentialSource: bad }))
      .toThrow(/credentialSource must be one of auto \| platform \| local/);
  });
});

describe('delegateOnMention', () => {
  it('is on by default and stored only when turned off', () => {
    expect(parseTriggerUserAuthConfig({ enabled: true })).not.toHaveProperty('delegateOnMention');
    expect(parseTriggerUserAuthConfig({ enabled: true, delegateOnMention: true })).not.toHaveProperty('delegateOnMention');
    expect(parseTriggerUserAuthConfig({ enabled: true, delegateOnMention: false })?.delegateOnMention).toBe(false);
    expect(delegatesOnMention(parseTriggerUserAuthConfig({ enabled: true }))).toBe(true);
    expect(delegatesOnMention(parseTriggerUserAuthConfig({ enabled: true, delegateOnMention: false }))).toBe(false);
  });

  it('needs the policy itself: there is no verified sender to hand over otherwise', () => {
    expect(delegatesOnMention(null)).toBe(false);
    expect(delegatesOnMention(parseTriggerUserAuthConfig({ enabled: false }))).toBe(false);
    expect(delegatesOnMention(parseTriggerUserAuthConfig({ enabled: true, tools: [] }))).toBe(false);
  });

  it.each(['yes', 1, {}])('rejects %j', bad => {
    expect(() => parseTriggerUserAuthConfig({ enabled: true, delegateOnMention: bad }))
      .toThrow(/delegateOnMention must be a boolean/);
  });
});
