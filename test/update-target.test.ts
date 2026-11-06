import { describe, expect, it } from 'vitest';
import {
  decideUpgradeArgs,
  fetchDistTagVersion,
  fetchLatestVersion,
  multipleUpgradeTargetsMessage,
  parseUpdateTarget,
  registryDistTagUrl,
  shouldApplySelfUpdate,
} from '../src/core/update-check.js';

describe('parseUpdateTarget', () => {
  it('defaults to latest when target is empty or omitted', () => {
    expect(parseUpdateTarget()).toEqual({
      raw: '',
      tag: 'latest',
      spec: 'botmux@latest',
      isChannel: true,
      isExplicit: false,
    });
    expect(parseUpdateTarget('')).toEqual({
      raw: '',
      tag: 'latest',
      spec: 'botmux@latest',
      isChannel: true,
      isExplicit: false,
    });
    expect(parseUpdateTarget('   ')).toEqual({
      raw: '',
      tag: 'latest',
      spec: 'botmux@latest',
      isChannel: true,
      isExplicit: false,
    });
  });

  it('recognizes standard release channels with isExplicit: true', () => {
    for (const channel of ['canary', 'beta', 'rc', 'next', 'latest']) {
      expect(parseUpdateTarget(channel)).toEqual({
        raw: channel,
        tag: channel,
        spec: `botmux@${channel}`,
        isChannel: true,
        isExplicit: true,
      });
      expect(parseUpdateTarget(`@${channel}`)).toEqual({
        raw: `@${channel}`,
        tag: channel,
        spec: `botmux@${channel}`,
        isChannel: true,
        isExplicit: true,
      });
      expect(parseUpdateTarget(`--${channel}`)).toEqual({
        raw: `--${channel}`,
        tag: channel,
        spec: `botmux@${channel}`,
        isChannel: true,
        isExplicit: true,
      });
      expect(parseUpdateTarget(`botmux@${channel}`)).toEqual({
        raw: `botmux@${channel}`,
        tag: channel,
        spec: `botmux@${channel}`,
        isChannel: true,
        isExplicit: true,
      });
    }
  });

  it('recognizes explicit semver versions with isExplicit: true', () => {
    expect(parseUpdateTarget('3.28.0')).toEqual({
      raw: '3.28.0',
      tag: '3.28.0',
      spec: 'botmux@3.28.0',
      isChannel: false,
      isExplicit: true,
    });
    expect(parseUpdateTarget('v3.28.0')).toEqual({
      raw: 'v3.28.0',
      tag: '3.28.0',
      spec: 'botmux@3.28.0',
      isChannel: false,
      isExplicit: true,
    });
    expect(parseUpdateTarget('@3.28.0')).toEqual({
      raw: '@3.28.0',
      tag: '3.28.0',
      spec: 'botmux@3.28.0',
      isChannel: false,
      isExplicit: true,
    });
    expect(parseUpdateTarget('botmux@3.28.0')).toEqual({
      raw: 'botmux@3.28.0',
      tag: '3.28.0',
      spec: 'botmux@3.28.0',
      isChannel: false,
      isExplicit: true,
    });
    expect(parseUpdateTarget('3.28.0-canary.1')).toEqual({
      raw: '3.28.0-canary.1',
      tag: '3.28.0-canary.1',
      spec: 'botmux@3.28.0-canary.1',
      isChannel: false,
      isExplicit: true,
    });
  });

  it('rejects invalid targets, URLs, aliases, and file/git specs', () => {
    const invalidTargets = [
      'npm:other-package@1.0.0',
      'https://example.invalid/botmux.tgz',
      'http://example.invalid/botmux.tgz',
      'file:./local-botmux',
      'git+https://github.com/foo/bar.git',
      'other-package@1.0.0',
      '../path/traversal',
      '/absolute/path',
      '^3.0.0',
      '~3.0.0',
      '3.x',
      '3.X',
      'package#branch',
      'tag with space',
      'x',
      'X',
      'vx',
      'vX',
      'v3',
      '3',
      '*',
      'alpha',
      'staging',
    ];
    for (const invalid of invalidTargets) {
      expect(parseUpdateTarget(invalid)).toBeNull();
    }
  });
});

describe('decideUpgradeArgs', () => {
  const messageOf = (decision: ReturnType<typeof decideUpgradeArgs>): string =>
    decision.kind === 'reject' ? decision.message : '';

  it('rejects more than one target with rc=2, in any flag/positional order', () => {
    for (const args of [['--canary', '--beta'], ['--canary', 'latest'], ['latest', '--canary']]) {
      for (const localDevInstall of [true, false]) {
        const decision = decideUpgradeArgs(args, localDevInstall);
        expect(decision).toEqual({ kind: 'reject', exitCode: 2, message: multipleUpgradeTargetsMessage(args) });
        for (const arg of args) expect(messageOf(decision)).toContain(arg);
      }
    }
  });

  it('rejects URL, protocol, alias, semver range and wildcard specs with rc=2', () => {
    const invalid = [
      'npm:other-package@1.0.0',
      'https://example.invalid/botmux.tgz',
      'file:./local-botmux',
      'git+https://github.com/foo/bar.git',
      'x', 'X', 'vx', 'v3', '3.x',
    ];
    for (const raw of invalid) {
      for (const localDevInstall of [true, false]) {
        const decision = decideUpgradeArgs([raw], localDevInstall);
        expect(decision).toMatchObject({ kind: 'reject', exitCode: 2 });
        expect(messageOf(decision)).toContain(raw);
      }
    }
  });

  it('refuses npm channels and versions on a local git checkout with rc=1 only', () => {
    for (const raw of ['canary', '@canary', '--canary', '3.28.0']) {
      const decision = decideUpgradeArgs([raw], true);
      expect(decision).toMatchObject({ kind: 'reject', exitCode: 1 });
      expect(messageOf(decision)).toContain(raw);
      expect(decideUpgradeArgs([raw], false)).toEqual({ kind: 'proceed', target: parseUpdateTarget(raw) });
    }
  });

  it('lets a local git checkout update to latest, implicitly or explicitly', () => {
    expect(decideUpgradeArgs([], true)).toEqual({ kind: 'proceed', target: parseUpdateTarget() });
    expect(decideUpgradeArgs(['latest'], true)).toEqual({ kind: 'proceed', target: parseUpdateTarget('latest') });
  });

  it('treats a lone `help` positional as a help request', () => {
    expect(decideUpgradeArgs(['help'], true)).toEqual({ kind: 'help' });
    expect(decideUpgradeArgs(['help', 'canary'], false)).toMatchObject({ kind: 'reject', exitCode: 2 });
  });
});

describe('registryDistTagUrl', () => {
  it('constructs correct dist-tag url', () => {
    expect(registryDistTagUrl('https://registry.npmjs.org/', 'canary')).toBe(
      'https://registry.npmjs.org/botmux/canary',
    );
    expect(registryDistTagUrl('https://registry.npmjs.org', 'canary')).toBe(
      'https://registry.npmjs.org/botmux/canary',
    );
    expect(registryDistTagUrl('https://registry.npmjs.org/', '@canary')).toBe(
      'https://registry.npmjs.org/botmux/canary',
    );
    expect(registryDistTagUrl('https://registry.npmjs.org/', '3.28.0')).toBe(
      'https://registry.npmjs.org/botmux/3.28.0',
    );
  });
});

describe('fetchDistTagVersion and fetchLatestVersion', () => {
  it('returns version when registry responds with valid json', async () => {
    const mockFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '3.21.0-canary.4' }),
    })) as unknown as typeof fetch;

    const version = await fetchDistTagVersion('canary', {
      fetchImpl: mockFetch,
      registry: 'https://registry.npmjs.org/',
    });
    expect(version).toBe('3.21.0-canary.4');
  });

  it('fetchLatestVersion resolves latest dist-tag', async () => {
    let requestedUrl = '';
    const mockFetch = (async (url: string) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ version: '3.29.0' }),
      };
    }) as unknown as typeof fetch;

    const version = await fetchLatestVersion({
      fetchImpl: mockFetch,
      registry: 'https://registry.npmjs.org/',
    });
    expect(version).toBe('3.29.0');
    expect(requestedUrl).toBe('https://registry.npmjs.org/botmux/latest');
  });

  it('returns null on 404 or network failure', async () => {
    const notFoundFetch = (async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    expect(
      await fetchDistTagVersion('nonexistent-tag', {
        fetchImpl: notFoundFetch,
        registry: 'https://registry.npmjs.org/',
      }),
    ).toBeNull();

    const rejectFetch = (async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    expect(
      await fetchDistTagVersion('canary', {
        fetchImpl: rejectFetch,
        registry: 'https://registry.npmjs.org/',
      }),
    ).toBeNull();
  });

  it('returns null when json payload lacks valid semver', async () => {
    const malformedFetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: 'invalid-semver-string' }),
    })) as unknown as typeof fetch;

    expect(
      await fetchDistTagVersion('canary', {
        fetchImpl: malformedFetch,
        registry: 'https://registry.npmjs.org/',
      }),
    ).toBeNull();
  });
});

describe('shouldApplySelfUpdate', () => {
  it('skips update on implicit latest if resolved version is not strictly newer', () => {
    const implicitTarget = parseUpdateTarget()!;
    expect(implicitTarget.isExplicit).toBe(false);

    // Current is equal to latest
    expect(shouldApplySelfUpdate(implicitTarget, '3.28.0', '3.28.0')).toEqual({
      proceed: false,
      reason: 'already_latest',
    });

    // Current is higher than latest (e.g. preview/canary)
    expect(shouldApplySelfUpdate(implicitTarget, '3.28.0', '3.29.0-canary.1')).toEqual({
      proceed: false,
      reason: 'already_latest',
    });
  });

  it('proceeds on implicit latest if resolved version is newer', () => {
    const implicitTarget = parseUpdateTarget()!;
    expect(shouldApplySelfUpdate(implicitTarget, '3.29.0', '3.28.0')).toEqual({
      proceed: true,
    });
  });

  it('allows switching from higher canary back to lower latest when explicitly requested', () => {
    const explicitLatest = parseUpdateTarget('latest')!;
    expect(explicitLatest.isExplicit).toBe(true);

    // Current is on canary (3.29.0-canary.1), latest is 3.28.0: must proceed to replace!
    expect(shouldApplySelfUpdate(explicitLatest, '3.28.0', '3.29.0-canary.1')).toEqual({
      proceed: true,
    });

    // Already on latest 3.28.0: skips with already_at_target
    expect(shouldApplySelfUpdate(explicitLatest, '3.28.0', '3.28.0')).toEqual({
      proceed: false,
      reason: 'already_at_target',
    });
  });

  it('handles explicit canary and explicit version targets', () => {
    const explicitCanary = parseUpdateTarget('canary')!;
    // Switch from stable 3.28.0 to canary 3.29.0-canary.2
    expect(shouldApplySelfUpdate(explicitCanary, '3.29.0-canary.2', '3.28.0')).toEqual({
      proceed: true,
    });
    // Already on that exact canary version
    expect(shouldApplySelfUpdate(explicitCanary, '3.29.0-canary.2', '3.29.0-canary.2')).toEqual({
      proceed: false,
      reason: 'already_at_target',
    });

    const explicitVersion = parseUpdateTarget('3.27.0')!;
    // Specific version replacement
    expect(shouldApplySelfUpdate(explicitVersion, '3.27.0', '3.28.0')).toEqual({
      proceed: true,
    });
    expect(shouldApplySelfUpdate(explicitVersion, '3.27.0', '3.27.0')).toEqual({
      proceed: false,
      reason: 'already_at_target',
    });
  });
});
