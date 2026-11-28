import './helpers/require-fenced-data-dir.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHostPluginMarket, PluginMarketError } from '../src/dashboard/plugin-market.js';
import {
  computeSha512Integrity,
  resetGithubReleaseTokenCache,
  type GithubReleaseHopResponse,
  type GithubReleaseHopTransport,
} from '../src/core/plugins/github-release.js';
import { installPlugin } from '../src/core/plugins/install.js';
import { parsePluginMutationGuard } from '../src/core/plugins/mutation-guard.js';
import * as paths from '../src/core/plugins/paths.js';
import * as registry from '../src/services/plugin-registry-store.js';
import { buildPluginTgz } from './helpers/plugin-tar-fixture.js';

function streamFrom(body: string | Buffer): AsyncIterable<Buffer> & { destroy(): void } {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return {
    destroy() {},
    async *[Symbol.asyncIterator]() { yield buf; },
  };
}

function ok(body: string | Buffer): GithubReleaseHopResponse {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  return { kind: 'response', statusCode: 200, headers: { 'content-length': String(buf.length) }, stream: streamFrom(buf) };
}

let home = '';

const ghCatalogEntry = {
  id: 'github',
  package: '@botmux-ai/plugin-github',
  displayName: 'GitHub',
  description: 'Botmux official GitHub plugin',
  repo: 'https://github.com/botmux-ai/botmux-plugin-github',
  docs: 'https://github.com/botmux-ai/botmux-plugin-github#readme',
  categories: ['vcs'],
  compatibility: { botmux: '>=3.56.0' },
  official: true,
  distribution: {
    type: 'github-release' as const,
    repo: 'botmux-ai/botmux-plugin-github',
    assetPattern: 'botmux-plugin-github-*.tgz',
  },
};

function makeCliRunner(beforeInstall?: (args: string[]) => Promise<void> | void) {
  const calls: string[][] = [];
  const runCli = async (args: string[]) => {
    calls.push(args);
    await beforeInstall?.(args);
    if (args[0] === 'plugin' && args[1] === 'install-verified') {
      const spec = args[2];
      const guardIdx = args.indexOf('--guard-json');
      const guard = parsePluginMutationGuard(guardIdx >= 0 ? args[guardIdx + 1] : undefined);
      await installPlugin(spec, { guard });
      return;
    }
    throw new Error(`Unexpected CLI args: ${args.join(' ')}`);
  };
  return { runCli, calls };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'botmux-market-gh-host-'));
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('GITHUB_TOKEN', '');
  vi.stubEnv('GH_TOKEN', '');
  resetGithubReleaseTokenCache();
  mkdirSync(join(home, '.botmux'), { recursive: true });
  writeFileSync(join(home, '.botmux', '.dashboard-token'), 'owner-token');
  expect(paths.pluginsHome()).toBe(join(home, '.botmux', 'plugins'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  resetGithubReleaseTokenCache();
  rmSync(home, { recursive: true, force: true });
});

describe('host plugin market with github-release source', () => {
  it('prepares from GitHub Releases API using read-only auth without leaking token, then installs strictly from locked downloadUrl', async () => {
    const token = 'ghp_secret_market_token_do_not_leak';
    const version = '0.3.0';
    const assetName = `botmux-plugin-github-${version}.tgz`;
    const tarball = buildPluginTgz(
      {
        name: ghCatalogEntry.package,
        version,
        description: ghCatalogEntry.description,
        keywords: ['botmux-plugin'],
        botmux: { schemaVersion: 1, id: ghCatalogEntry.id, displayName: ghCatalogEntry.displayName },
      },
      { 'index.js': 'export const ok = true;\n', marker: 'github-market-v0.3.0' },
    );
    const integrity = computeSha512Integrity(tarball);
    const tgzUrl = `https://github.com/botmux-ai/botmux-plugin-github/releases/download/v${version}/${assetName}`;
    const cdnUrl = `https://release-assets.githubusercontent.com/assets/${assetName}`;
    const sha512Url = `https://github.com/botmux-ai/botmux-plugin-github/releases/download/v${version}/${assetName}.sha512`;

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [ghCatalogEntry] })));

    let apiHits = 0;
    const seenAuth: Array<{ host: string; auth?: string }> = [];
    const transport: GithubReleaseHopTransport = async (url, headers) => {
      seenAuth.push({ host: url.hostname, auth: headers.Authorization });
      const href = url.toString();
      if (href === 'https://api.github.com/repos/botmux-ai/botmux-plugin-github/releases/latest') {
        apiHits++;
        return ok(JSON.stringify({
          tag_name: `v${version}`,
          draft: false,
          prerelease: false,
          assets: [
            { name: assetName, browser_download_url: tgzUrl, size: tarball.length },
            { name: `${assetName}.sha512`, browser_download_url: sha512Url, size: 120 },
          ],
        }));
      }
      if (href === sha512Url) return ok(`${integrity}  ${assetName}\n`);
      if (href === tgzUrl) return { kind: 'redirect', statusCode: 302, location: cdnUrl };
      if (href === cdnUrl) return ok(tarball);
      return { kind: 'response', statusCode: 404, headers: {}, stream: streamFrom('') };
    };

    const cli = makeCliRunner();
    const market = createHostPluginMarket(() => false, {
      githubRelease: { transport, resolveToken: async () => token },
      runCli: cli.runCli,
    });

    const plan = await market.prepare('github', 'session-1');
    expect(plan).toMatchObject({
      id: 'github',
      packageName: '@botmux-ai/plugin-github',
      version,
      integrity,
      sourceType: 'github-release',
      downloadUrl: tgzUrl,
      releaseRepo: 'botmux-ai/botmux-plugin-github',
      releaseTag: `v${version}`,
      releaseAsset: assetName,
    });
    expect(JSON.stringify(plan)).not.toContain(token);
    expect(apiHits).toBe(1);

    const digest = createHash('sha256').update('owner-token').digest('hex');
    const installed = await market.install(plan.nonce, true, 'session-1', digest);
    expect(installed).toEqual({ id: 'github', version });
    // Install must download only from locked downloadUrl without re-querying GitHub Releases API.
    expect(apiHits).toBe(1);
    // Token was sent only to api.github.com and never to github.com or CDN.
    expect(seenAuth.filter(h => h.auth !== undefined).every(h => h.host === 'api.github.com')).toBe(true);
    expect(seenAuth.some(h => h.host === 'release-assets.githubusercontent.com' && h.auth === undefined)).toBe(true);

    const record = registry.getInstalledPlugin('github')!;
    expect(record.source).toEqual({
      type: 'github-release',
      repo: 'botmux-ai/botmux-plugin-github',
      tag: `v${version}`,
      asset: assetName,
      integrity,
    });
    expect(record.integrity).toBe(integrity);
    expect(readFileSync(join(paths.pluginRuntimeDir('github'), 'marker'), 'utf8')).toBe('github-market-v0.3.0');
  });

  it('rejects tampered archive download, manifest identity mismatch, disallowed redirect and rate limit without leaking tokens', async () => {
    const token = 'ghp_another_secret_token';
    const version = '0.3.1';
    const assetName = `botmux-plugin-github-${version}.tgz`;
    const validTarball = buildPluginTgz({
      name: ghCatalogEntry.package,
      version,
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: ghCatalogEntry.id },
    });
    const wrongIdTarball = buildPluginTgz({
      name: ghCatalogEntry.package,
      version,
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'hijacked' },
    });
    const tgzUrl = `https://github.com/botmux-ai/botmux-plugin-github/releases/download/v${version}/${assetName}`;
    const sha512Url = `https://github.com/botmux-ai/botmux-plugin-github/releases/download/v${version}/${assetName}.sha512`;

    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [ghCatalogEntry] })));

    // 1. Tampered tarball downloaded at install time (bytes do not match locked sha512) -> 409.
    const validIntegrity = computeSha512Integrity(validTarball);
    const cli = makeCliRunner();
    const tamperedMarket = createHostPluginMarket(() => false, {
      runCli: cli.runCli,
      githubRelease: {
        resolveToken: async () => token,
        transport: async url => {
          const href = url.toString();
          if (href.includes('/releases/latest')) {
            return ok(JSON.stringify({
              tag_name: `v${version}`,
              draft: false,
              prerelease: false,
              assets: [
                { name: assetName, browser_download_url: tgzUrl },
                { name: `${assetName}.sha512`, browser_download_url: sha512Url },
              ],
            }));
          }
          if (href === sha512Url) return ok(`${validIntegrity}  ${assetName}\n`);
          if (href === tgzUrl) return ok(Buffer.from('corrupted tarball bytes'));
          return { kind: 'response', statusCode: 404, headers: {}, stream: streamFrom('') };
        },
      },
    });
    const plan1 = await tamperedMarket.prepare('github', 'owner');
    await expect(tamperedMarket.install(plan1.nonce, true, 'owner')).rejects.toMatchObject({ status: 409 });
    expect(cli.calls).toHaveLength(0);
    expect(existsSync(paths.pluginHome('github'))).toBe(false);

    // 2. Tarball matching sha512 but declaring wrong botmux.id -> 409 before CLI handoff.
    const wrongIdIntegrity = computeSha512Integrity(wrongIdTarball);
    const wrongManifestMarket = createHostPluginMarket(() => false, {
      runCli: cli.runCli,
      githubRelease: {
        resolveToken: async () => token,
        transport: async url => {
          const href = url.toString();
          if (href.includes('/releases/latest')) {
            return ok(JSON.stringify({
              tag_name: `v${version}`,
              draft: false,
              prerelease: false,
              assets: [
                { name: assetName, browser_download_url: tgzUrl },
                { name: `${assetName}.sha512`, browser_download_url: sha512Url },
              ],
            }));
          }
          if (href === sha512Url) return ok(`${wrongIdIntegrity}  ${assetName}\n`);
          if (href === tgzUrl) return ok(wrongIdTarball);
          return { kind: 'response', statusCode: 404, headers: {}, stream: streamFrom('') };
        },
      },
    });
    const plan2 = await wrongManifestMarket.prepare('github', 'owner');
    await expect(wrongManifestMarket.install(plan2.nonce, true, 'owner')).rejects.toMatchObject({ status: 409 });
    expect(cli.calls).toHaveLength(0);

    // 3. Disallowed redirect during download -> 502.
    const redirectMarket = createHostPluginMarket(() => false, {
      runCli: cli.runCli,
      githubRelease: {
        resolveToken: async () => token,
        transport: async url => {
          const href = url.toString();
          if (href.includes('/releases/latest')) {
            return ok(JSON.stringify({
              tag_name: `v${version}`,
              draft: false,
              prerelease: false,
              assets: [
                { name: assetName, browser_download_url: tgzUrl },
                { name: `${assetName}.sha512`, browser_download_url: sha512Url },
              ],
            }));
          }
          if (href === sha512Url) return ok(`${validIntegrity}  ${assetName}\n`);
          if (href === tgzUrl) return { kind: 'redirect', statusCode: 302, location: 'https://evil.invalid/a.tgz' };
          return { kind: 'response', statusCode: 404, headers: {}, stream: streamFrom('') };
        },
      },
    });
    const plan3 = await redirectMarket.prepare('github', 'owner');
    await expect(redirectMarket.install(plan3.nonce, true, 'owner')).rejects.toMatchObject({ status: 502 });

    // 4. Rate limit on prepare maps cleanly to 429 without exposing the token.
    const rateLimitedMarket = createHostPluginMarket(() => false, {
      githubRelease: {
        resolveToken: async () => token,
        transport: async () => ({
          kind: 'response',
          statusCode: 403,
          headers: { 'x-ratelimit-remaining': '0' },
          stream: streamFrom('API rate limit exceeded'),
        }),
      },
    });
    const err = await rateLimitedMarket.prepare('github', 'owner').catch(e => e);
    expect(err).toBeInstanceOf(PluginMarketError);
    expect(err.status).toBe(429);
    expect(err.message).not.toContain(token);
  });

  it('aborts commit if archive bytes are modified between host verification and CLI install-verified handoff', async () => {
    const version = '0.4.0';
    const assetName = `botmux-plugin-github-${version}.tgz`;
    const tarball = buildPluginTgz({
      name: ghCatalogEntry.package,
      version,
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: ghCatalogEntry.id },
    });
    const integrity = computeSha512Integrity(tarball);
    const tgzUrl = `https://github.com/botmux-ai/botmux-plugin-github/releases/download/v${version}/${assetName}`;
    const sha512Url = `https://github.com/botmux-ai/botmux-plugin-github/releases/download/v${version}/${assetName}.sha512`;
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ schemaVersion: 1, plugins: [ghCatalogEntry] })));

    const cli = makeCliRunner(args => {
      // Simulate TOCTOU tampering of the staged archive before install-verified runs.
      const archivePath = args[2].slice('file:'.length);
      writeFileSync(archivePath, Buffer.from('mutated after host check'));
    });

    const market = createHostPluginMarket(() => false, {
      runCli: cli.runCli,
      githubRelease: {
        resolveToken: async () => null,
        transport: async url => {
          const href = url.toString();
          if (href.includes('/releases/latest')) {
            return ok(JSON.stringify({
              tag_name: `v${version}`,
              draft: false,
              prerelease: false,
              assets: [
                { name: assetName, browser_download_url: tgzUrl },
                { name: `${assetName}.sha512`, browser_download_url: sha512Url },
              ],
            }));
          }
          if (href === sha512Url) return ok(`${integrity}\n`);
          if (href === tgzUrl) return ok(tarball);
          return { kind: 'response', statusCode: 404, headers: {}, stream: streamFrom('') };
        },
      },
    });

    const plan = await market.prepare('github', 'owner');
    await expect(market.install(plan.nonce, true, 'owner')).rejects.toThrow(/archive_mismatch/);
    expect(registry.getInstalledPlugin('github')).toBeUndefined();
  });
});
