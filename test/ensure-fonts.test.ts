import { afterEach, describe, expect, it } from 'bun:test';
import { createFontDownloadAgent } from '../src/setup/ensure-fonts.js';

const PROXY_ENV_KEYS = [
  'npm_config_https_proxy',
  'NPM_CONFIG_HTTPS_PROXY',
  'https_proxy',
  'HTTPS_PROXY',
  'npm_config_proxy',
  'NPM_CONFIG_PROXY',
  'all_proxy',
  'ALL_PROXY',
  'npm_config_no_proxy',
  'NPM_CONFIG_NO_PROXY',
  'no_proxy',
  'NO_PROXY',
] as const;

const originalProxyEnv = Object.fromEntries(PROXY_ENV_KEYS.map(key => [key, process.env[key]]));

function setProxyEnv(values: Partial<Record<(typeof PROXY_ENV_KEYS)[number], string>>): void {
  for (const key of PROXY_ENV_KEYS) delete process.env[key];
  Object.assign(process.env, values);
}

afterEach(() => {
  for (const key of PROXY_ENV_KEYS) {
    const value = originalProxyEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('font download proxy', () => {
  it('uses the configured HTTPS proxy for GitHub font downloads', () => {
    setProxyEnv({
      HTTPS_PROXY: 'http://upper-proxy:8118',
      https_proxy: 'http://lower-proxy:8118',
    });

    const agent = createFontDownloadAgent();
    expect(agent?.getProxyForUrl('https://github.com/notofonts/noto-cjk/raw/font.otf', {}))
      .toBe('http://lower-proxy:8118');
    agent?.destroy();
  });

  it('honors NO_PROXY independently for redirect destinations', () => {
    setProxyEnv({
      HTTPS_PROXY: 'http://proxy.example:8118',
      NO_PROXY: 'github.com',
    });

    const agent = createFontDownloadAgent();
    expect(agent?.getProxyForUrl('https://github.com/notofonts/noto-cjk/raw/font.otf', {})).toBe('');
    expect(agent?.getProxyForUrl('https://objects.githubusercontent.com/font.otf', {}))
      .toBe('http://proxy.example:8118');
    agent?.destroy();
  });

  it('keeps the native HTTPS agent when no proxy is configured', () => {
    setProxyEnv({});
    expect(createFontDownloadAgent()).toBeUndefined();
  });
});
