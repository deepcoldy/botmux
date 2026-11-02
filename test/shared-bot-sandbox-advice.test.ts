import { describe, it, expect } from 'vitest';
import {
  ALLOWLIST_SANDBOX_CLI_SUPPORT,
  SANDBOX_CLI_SUPPORT_STATES,
  SHARED_BOT_REASONS,
  allowlistSandboxCliSupport,
  allowlistSandboxVerifiedClis,
  sharedBotSandboxAdvice,
} from '../src/core/shared-bot-sandbox-advice.js';
import { CLI_DISPLAY_NAMES } from '../src/adapters/cli/display-names.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';
import { messages as zhCard } from '../src/i18n/zh.js';
import { messages as enCard } from '../src/i18n/en.js';

const solo = {
  sandboxMode: 'off',
  cliId: 'claude-code',
  oncallChatCount: 0,
  allowedChatGroupsCount: 0,
  defaultOncallEnabled: false,
  allowedUsersCount: 1,
  triggerUserAuthEnabled: false,
};

describe('sharedBotSandboxAdvice', () => {
  it('says nothing for a bot only its owner uses', () => {
    expect(sharedBotSandboxAdvice(solo)).toBeNull();
    expect(sharedBotSandboxAdvice({ ...solo, allowedUsersCount: 0 })).toBeNull();
    // Older daemons report no counts at all.
    expect(sharedBotSandboxAdvice({ ...solo, oncallChatCount: null, allowedUsersCount: undefined, allowedChatGroupsCount: null })).toBeNull();
  });

  it('flags each way other people reach the agent', () => {
    expect(sharedBotSandboxAdvice({ ...solo, oncallChatCount: 2 })?.reasons).toEqual(['oncall']);
    expect(sharedBotSandboxAdvice({ ...solo, defaultOncallEnabled: true })?.reasons).toEqual(['oncall']);
    expect(sharedBotSandboxAdvice({ ...solo, allowedChatGroupsCount: 1 })?.reasons).toEqual(['allowedChatGroups']);
    expect(sharedBotSandboxAdvice({ ...solo, allowedUsersCount: 2 })?.reasons).toEqual(['allowedUsers']);
    expect(sharedBotSandboxAdvice({ ...solo, triggerUserAuthEnabled: true })?.reasons).toEqual(['triggerUserAuth']);
    expect(sharedBotSandboxAdvice({
      ...solo, oncallChatCount: 1, allowedChatGroupsCount: 1, allowedUsersCount: 3, triggerUserAuthEnabled: true,
    })?.reasons)
      .toEqual(['oncall', 'allowedChatGroups', 'allowedUsers', 'triggerUserAuth']);
  });

  it('is silenced only by the allowlist sandbox, not by scratch', () => {
    const shared = { ...solo, oncallChatCount: 1 };
    expect(sharedBotSandboxAdvice({ ...shared, sandboxMode: 'oncall' })).toBeNull();
    expect(sharedBotSandboxAdvice({ ...shared, sandboxMode: 'scratch' })).not.toBeNull();
    expect(sharedBotSandboxAdvice({ ...shared, sandboxMode: undefined })).not.toBeNull();
  });

  it('stays silent when no local file sandbox can wrap the CLI (riff / remote-runner)', () => {
    const shared = { ...solo, oncallChatCount: 2, allowedUsersCount: 5 };
    expect(sharedBotSandboxAdvice({ ...shared, localSandboxApplies: false })).toBeNull();
    // Default / null = old caller without backend info: historical local behaviour.
    expect(sharedBotSandboxAdvice({ ...shared, localSandboxApplies: undefined })).not.toBeNull();
    expect(sharedBotSandboxAdvice({ ...shared, localSandboxApplies: null })).not.toBeNull();
  });

  it('carries whether the bot CLI is known to work under the sandbox', () => {
    const shared = { ...solo, allowedUsersCount: 2 };
    expect(sharedBotSandboxAdvice({ ...shared, cliId: 'claude-code' })?.cliSupport).toBe('verified');
    expect(sharedBotSandboxAdvice({ ...shared, cliId: 'codex-app' })?.cliSupport).toBe('unsupported');
    expect(sharedBotSandboxAdvice({ ...shared, cliId: 'relay' })?.cliSupport).toBe('unverified');
    expect(sharedBotSandboxAdvice({ ...shared, cliId: undefined })?.cliSupport).toBe('unverified');
  });

  it('qualifies codex-app unsupported on Linux only', () => {
    expect(allowlistSandboxCliSupport('codex-app', { platform: 'linux' })).toBe('unsupported');
    // The worker refusal is Linux-only (backendSandboxCompatibilityError);
    // macOS is not gated, but the matrix never ran there either.
    expect(allowlistSandboxCliSupport('codex-app', { platform: 'darwin' })).toBe('unverified');
    expect(allowlistSandboxCliSupport('codex-app', { platform: 'win32' })).toBe('unverified');
    const shared = { ...solo, oncallChatCount: 1 };
    expect(sharedBotSandboxAdvice({ ...shared, cliId: 'codex-app', platform: 'darwin' })?.cliSupport)
      .toBe('unverified');
  });

  it('reports a local-but-sandbox-refusing backend instead of "verified"', () => {
    // herdr / zellij / zmx / orca run locally but the worker gate refuses to
    // spawn them under a file sandbox: "verified, turn it on" would brick every
    // new session.
    const shared = { ...solo, oncallChatCount: 1, cliId: 'claude-code' };
    expect(sharedBotSandboxAdvice({ ...shared, sandboxCapable: false })?.cliSupport)
      .toBe('blocked');
    // null/undefined = old caller: historical "assume capable" behaviour.
    expect(sharedBotSandboxAdvice({ ...shared, sandboxCapable: undefined })?.cliSupport)
      .toBe('verified');
    // The hard codex-app refusal takes precedence; wrapper is moot once the
    // backend blocks the sandbox.
    expect(sharedBotSandboxAdvice({
      ...shared, cliId: 'codex-app', platform: 'linux', sandboxCapable: false,
    })?.cliSupport).toBe('unsupported');
    expect(sharedBotSandboxAdvice({
      ...shared, wrapperCli: 'aiden --', sandboxCapable: false,
    })?.cliSupport).toBe('blocked');
  });

  it('downgrades the verdict when a wrapper or custom runtime changes the launch', () => {
    const shared = { ...solo, oncallChatCount: 1, cliId: 'claude-code' };
    // wrapperCli is dropped by the worker under the sandbox ("wrapperCli ignored").
    expect(sharedBotSandboxAdvice({ ...shared, wrapperCli: 'aiden --' })?.cliSupport).toBe('wrapper');
    expect(sharedBotSandboxAdvice({ ...shared, wrapperCli: '   ' })?.cliSupport).toBe('verified');
    // A hard Linux refusal wins over the wrapper caveat.
    expect(sharedBotSandboxAdvice({
      ...shared, cliId: 'codex-app', platform: 'linux', wrapperCli: 'x',
    })?.cliSupport).toBe('unsupported');
    // Custom runtime was never part of the matrix → unverified, not wrapper.
    expect(sharedBotSandboxAdvice({ ...shared, cliRuntimeConfigured: true })?.cliSupport).toBe('unverified');
    expect(sharedBotSandboxAdvice({
      ...shared, cliId: 'relay', cliRuntimeConfigured: true,
    })?.cliSupport).toBe('unverified');
  });

  it('does not resolve inherited object properties for an unvalidated cliId', () => {
    // bots.json cliId is not validated at load; a plain record index would hand
    // back a built-in object and render as a function in the card.
    expect(allowlistSandboxCliSupport('constructor')).toBe('unverified');
    expect(allowlistSandboxCliSupport('__proto__')).toBe('unverified');
    expect(allowlistSandboxCliSupport('hasOwnProperty')).toBe('unverified');
  });
});

describe('allowlist sandbox CLI support table', () => {
  // The list IS the feature's claim: pin literal ids/order so re-running the
  // matrix has to update this test on purpose (deriving the expectation from
  // the table itself let a fully emptied table stay green).
  const EXPECTED_VERIFIED: readonly string[] = [
    'claude-code', 'codex', 'antigravity', 'opencode', 'pi', 'oh-my-pi', 'grok', 'kimi',
  ];

  it('lists exactly the matrix-verified CLI ids in table order', () => {
    expect(allowlistSandboxVerifiedClis()).toEqual(EXPECTED_VERIFIED);
    expect(EXPECTED_VERIFIED).toHaveLength(8);
  });

  it('names only real CLIs, so the advice can list them by display name', () => {
    for (const id of allowlistSandboxVerifiedClis()) expect(CLI_DISPLAY_NAMES[id]).toBeTruthy();
    expect(allowlistSandboxVerifiedClis()).not.toContain('codex-app');
    expect(ALLOWLIST_SANDBOX_CLI_SUPPORT['codex-app']).toBe('unsupported');
    // Gemini CLI's adapter still ships, but the matrix dropped its row when it
    // stopped being maintained: it must not be vouched for as verified.
    expect(ALLOWLIST_SANDBOX_CLI_SUPPORT).not.toHaveProperty('gemini');
    expect(allowlistSandboxCliSupport('gemini')).toBe('unverified');
    expect(allowlistSandboxCliSupport('not-a-cli')).toBe('unverified');
  });
});

describe('shared-bot advice i18n coverage (dynamically built keys)', () => {
  it('every reason and support state has Dashboard and card text in both locales', () => {
    const dashboardZh = createDashboardTranslator('zh');
    const dashboardEn = createDashboardTranslator('en');
    for (const reason of SHARED_BOT_REASONS) {
      const dkey = `botDefaults.sharedSandboxReason.${reason}`;
      expect(dashboardZh(dkey), `missing zh dashboard ${dkey}`).not.toBe(dkey);
      expect(dashboardEn(dkey), `missing en dashboard ${dkey}`).not.toBe(dkey);
      const ckey = `card.config.sandbox_advice.${reason}`;
      expect(zhCard[ckey], `missing zh card ${ckey}`).toBeTruthy();
      expect(enCard[ckey], `missing en card ${ckey}`).toBeTruthy();
    }
    for (const state of SANDBOX_CLI_SUPPORT_STATES) {
      // Every state except 'verified' has a dedicated Dashboard CLI line; the
      // verified line is shared with the state name.
      const dkey = `botDefaults.sharedSandboxCli${state[0].toUpperCase()}${state.slice(1)}`;
      expect(dashboardZh(dkey), `missing zh dashboard ${dkey}`).not.toBe(dkey);
      expect(dashboardEn(dkey), `missing en dashboard ${dkey}`).not.toBe(dkey);
      const ckey = `card.config.sandbox_advice.${state}`;
      expect(zhCard[ckey], `missing zh card ${ckey}`).toBeTruthy();
      expect(enCard[ckey], `missing en card ${ckey}`).toBeTruthy();
    }
  });

  it('ships the static card keys in BOTH locales (en.ts is Record<string,string>, so types do not catch omissions)', () => {
    // Deleting one of these en keys made t() silently fall back to Chinese while
    // the whole suite stayed green: they are never built dynamically.
    const cardKeys = [
      'card.config.sandbox_advice',
      'card.config.sandbox_advice.reasons',
      'card.config.sandbox_advice.action',
      'card.config.sandbox_advice.sep',
      'card.config.sandbox_advice.list_title',
    ];
    for (const key of cardKeys) {
      expect(zhCard[key], `missing zh ${key}`).toBeTruthy();
      expect(enCard[key], `missing en ${key}`).toBeTruthy();
      expect(enCard[key], `en ${key} fell back to the zh text`).not.toBe(zhCard[key]);
    }
    // Dashboard static keys are reached via literal tr() in the component, so the
    // repo-wide structural i18n test covers them; assert the contract here too.
    const dashboardKeys = [
      'botDefaults.sharedSandboxTitle',
      'botDefaults.sharedSandboxAdvice',
      'botDefaults.sharedSandboxReasons',
      'botDefaults.sharedSandboxAction',
      'botDefaults.sharedSandboxVerified',
    ];
    const zhT = createDashboardTranslator('zh');
    const enT = createDashboardTranslator('en');
    for (const key of dashboardKeys) {
      expect(zhT(key)).not.toBe(key);
      expect(enT(key)).not.toBe(key);
      expect(enT(key)).not.toBe(zhT(key));
    }
  });
});
