import { describe, expect, it } from 'vitest';
import { normalizeCodexBrowserConfig } from '../src/core/codex-browser-config.js';

describe('normalizeCodexBrowserConfig', () => {
  it('is disabled by default and supports the concise true form', () => {
    expect(normalizeCodexBrowserConfig(undefined)).toBeUndefined();
    expect(normalizeCodexBrowserConfig(false)).toBeUndefined();
    expect(normalizeCodexBrowserConfig(true)).toEqual({ enabled: true, family: 'chrome' });
  });

  it('normalizes a trusted absolute plugin root', () => {
    expect(normalizeCodexBrowserConfig({
      enabled: true,
      family: 'edge',
      pluginRoot: '/opt/codex/chrome-plugin',
    })).toEqual({
      enabled: true,
      family: 'edge',
      pluginRoot: '/opt/codex/chrome-plugin',
    });
  });

  it('rejects ambiguous or unsafe configuration', () => {
    expect(() => normalizeCodexBrowserConfig({ enabled: false })).toThrow('requires enabled: true');
    expect(() => normalizeCodexBrowserConfig({ enabled: true, family: 'firefox' })).toThrow('chrome');
    expect(() => normalizeCodexBrowserConfig({ enabled: true, pluginRoot: './relative' })).toThrow('absolute');
  });
});
