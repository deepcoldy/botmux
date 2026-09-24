import { describe, expect, it } from 'vitest';
import {
  fetchDistTagVersion,
  fetchLatestVersion,
  parseUpdateTarget,
  registryDistTagUrl,
} from '../src/core/update-check.js';

describe('parseUpdateTarget', () => {
  it('defaults to latest when target is empty or omitted', () => {
    expect(parseUpdateTarget()).toEqual({
      raw: '',
      tag: 'latest',
      spec: 'botmux@latest',
      isChannel: true,
    });
    expect(parseUpdateTarget('')).toEqual({
      raw: '',
      tag: 'latest',
      spec: 'botmux@latest',
      isChannel: true,
    });
    expect(parseUpdateTarget('   ')).toEqual({
      raw: '',
      tag: 'latest',
      spec: 'botmux@latest',
      isChannel: true,
    });
  });

  it('recognizes standard release channels', () => {
    for (const channel of ['canary', 'beta', 'rc', 'next', 'latest']) {
      expect(parseUpdateTarget(channel)).toEqual({
        raw: channel,
        tag: channel,
        spec: `botmux@${channel}`,
        isChannel: true,
      });
      expect(parseUpdateTarget(`@${channel}`)).toEqual({
        raw: `@${channel}`,
        tag: channel,
        spec: `botmux@${channel}`,
        isChannel: true,
      });
      expect(parseUpdateTarget(`--${channel}`)).toEqual({
        raw: `--${channel}`,
        tag: channel,
        spec: `botmux@${channel}`,
        isChannel: true,
      });
      expect(parseUpdateTarget(`botmux@${channel}`)).toEqual({
        raw: `botmux@${channel}`,
        tag: channel,
        spec: `botmux@${channel}`,
        isChannel: true,
      });
    }
  });

  it('recognizes explicit semver versions', () => {
    expect(parseUpdateTarget('3.28.0')).toEqual({
      raw: '3.28.0',
      tag: '3.28.0',
      spec: 'botmux@3.28.0',
      isChannel: false,
    });
    expect(parseUpdateTarget('v3.28.0')).toEqual({
      raw: 'v3.28.0',
      tag: '3.28.0',
      spec: 'botmux@3.28.0',
      isChannel: false,
    });
    expect(parseUpdateTarget('@3.28.0')).toEqual({
      raw: '@3.28.0',
      tag: '3.28.0',
      spec: 'botmux@3.28.0',
      isChannel: false,
    });
    expect(parseUpdateTarget('botmux@3.28.0')).toEqual({
      raw: 'botmux@3.28.0',
      tag: '3.28.0',
      spec: 'botmux@3.28.0',
      isChannel: false,
    });
    expect(parseUpdateTarget('3.28.0-canary.1')).toEqual({
      raw: '3.28.0-canary.1',
      tag: '3.28.0-canary.1',
      spec: 'botmux@3.28.0-canary.1',
      isChannel: false,
    });
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
