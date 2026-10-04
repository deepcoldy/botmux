/**
 * Blocker #2 (2026-07-24 review): the new three-tier `sandboxPaths` must be
 * carried through the WHOLE workflow chain — BotConfig → BotSnapshot
 * (botToSnapshot) → frozen artifact (serialize/parseFrozenBotSnapshots) →
 * worker init fields (workflowSandboxInitFields) — so a workflow worker builds
 * the SAME fs-policy a normal session would. Before the fix only the legacy
 * sandboxHidePaths/sandboxReadonlyPaths crossed the boundary, silently dropping
 * the readWrite tier and any user-declared deny.
 */
import { describe, it, expect } from 'vitest';
import { botToSnapshot, parseFrozenBotSnapshots, serializeFrozenBotSnapshots } from '../src/workflows/v3/bot-resolve.js';
import { workflowSandboxInitFields } from '../src/workflows/shared/sandbox-policy.js';
import { buildFsPolicy, type FsPolicyContext } from '../src/adapters/cli/fs-policy.js';
import type { BotConfig } from '../src/bot-registry.js';

const bot = (extra: Partial<BotConfig> = {}): BotConfig => ({
  larkAppId: 'app_x',
  larkAppSecret: 'secret',
  cliId: 'claude-code',
  sandbox: true,
  sandboxPaths: {
    readWrite: ['/srv/scratch'],
    readOnly: ['/srv/ref'],
    deny: ['/srv/ref/private'],
  },
  ...extra,
} as BotConfig);

describe('blocker #2: sandboxPaths threads through the workflow chain', () => {
  it('botToSnapshot carries the three tiers', () => {
    const snap = botToSnapshot(bot(), '/w');
    expect(snap.sandboxPaths).toEqual({
      readWrite: ['/srv/scratch'],
      readOnly: ['/srv/ref'],
      deny: ['/srv/ref/private'],
    });
  });

  it('serialize → parseFrozenBotSnapshots round-trips sandboxPaths', () => {
    const snap = botToSnapshot(bot(), '/w');
    const frozen = serializeFrozenBotSnapshots(new Map([['app_x', snap]]));
    const roundTrip = parseFrozenBotSnapshots(JSON.parse(JSON.stringify(frozen)));
    expect(roundTrip.get('app_x')!.sandboxPaths).toEqual(snap.sandboxPaths);
  });

  it('parseFrozenBotSnapshots rejects a malformed sandboxPaths', () => {
    expect(() => parseFrozenBotSnapshots({
      app_x: { larkAppId: 'app_x', cliId: 'claude-code', workingDir: '/w', sandboxPaths: { readWrite: [1] } },
    })).toThrow(/sandboxPaths\.readWrite must be a string array/);
    expect(() => parseFrozenBotSnapshots({
      app_x: { larkAppId: 'app_x', cliId: 'claude-code', workingDir: '/w', sandboxPaths: { bogus: [] } },
    })).toThrow(/sandboxPaths has unsupported key/);
  });

  it('workflowSandboxInitFields forwards sandboxPaths to the worker init', () => {
    const snap = botToSnapshot(bot(), '/w');
    const init = workflowSandboxInitFields(snap);
    expect(init.sandbox).toBe(true);
    expect(init.sandboxPaths).toEqual({
      readWrite: ['/srv/scratch'],
      readOnly: ['/srv/ref'],
      deny: ['/srv/ref/private'],
    });
  });

  it('workflowSandboxInitFields omits sandboxPaths for legacy-only bots (worker fallback intact)', () => {
    const legacy = workflowSandboxInitFields({ sandbox: true, sandboxHidePaths: ['/x'], sandboxReadonlyPaths: ['/y'] });
    expect(legacy.sandboxPaths).toBeUndefined();
    expect(legacy.sandboxHidePaths).toEqual(['/x']);
  });

  it('workflow policy == normal-session policy for the same userPaths', () => {
    const snap = botToSnapshot(bot(), '/srv/proj');
    const init = workflowSandboxInitFields(snap);
    const base: Omit<FsPolicyContext, 'userPaths'> = {
      platform: 'linux', homeDir: '/home/u',
      botmuxHome: '/home/u/.botmux', sessionDataDir: '/home/u/.botmux/data',
      sessionId: 's', workingDir: '/srv/proj', currentAppId: 'app_x',
      botHome: '/home/u/.botmux/bots/app_x', redirectedCliData: true, net: true, writeRegexes: [],
    };
    // normal session builds userPaths straight from bot config
    const normal = buildFsPolicy({ ...base, userPaths: bot().sandboxPaths });
    // workflow rebuilds them from the init fields carried across the boundary
    const workflow = buildFsPolicy({ ...base, userPaths: init.sandboxPaths });
    expect(workflow.rules).toEqual(normal.rules);
  });
});


describe('network policy workflow snapshots', () => {
  it('freezes, serializes, restores and forwards the complete network policy', () => {
    const policy = { version: 1 as const, public: { mode: 'allowlist' as const, rules: [{ cidr: '8.8.8.8/32', protocol: 'tcp' as const, ports: [443] }] }, private: { mode: 'block' as const }, dnsServers: ['1.1.1.1'] };
    const snap = botToSnapshot(bot({ sandboxNetworkPolicy: policy }), '/w');
    policy.public.rules[0]!.ports.push(80);
    const frozen = serializeFrozenBotSnapshots(new Map([['app_x', snap]]));
    const restored = parseFrozenBotSnapshots(JSON.parse(JSON.stringify(frozen))).get('app_x')!;
    const init = workflowSandboxInitFields(restored);
    expect(init.sandboxNetworkPolicy).toEqual(snap.sandboxNetworkPolicy);
    expect(init.sandboxNetworkPolicy!.public.rules![0]!.ports).toEqual([443]);
    restored.sandboxNetworkPolicy!.dnsServers!.push('8.8.4.4');
    expect(init.sandboxNetworkPolicy!.dnsServers).toEqual(['1.1.1.1']);
  });
  it('refuses malformed frozen policy rather than restoring unrestricted egress', () => {
    expect(() => parseFrozenBotSnapshots({ app_x: { larkAppId: 'app_x', cliId: 'claude-code', workingDir: '/w', sandboxNetworkPolicy: { version: 1, public: { mode: 'allow' }, private: { mode: 'typo' } } } })).toThrow();
  });
});
