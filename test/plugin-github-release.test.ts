import './helpers/require-fenced-data-dir.js';
import { execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertAllowedGithubReleaseUrl,
  computeSha256Hex,
  computeSha512Integrity,
  deriveReleaseVersion,
  downloadGithubReleaseAssetToFile,
  fetchGithubReleaseBytes,
  GithubReleaseError,
  isGithubReleaseSpec,
  matchAssetPattern,
  parseGithubReleaseSpec,
  parseSha512IntegrityText,
  resetGithubReleaseTokenCache,
  resolveGithubReleaseAsset,
  resolveOptionalGithubApiToken,
  type GithubReleaseHopResponse,
  type GithubReleaseHopTransport,
} from '../src/core/plugins/github-release.js';
import {
  extractPluginTgz,
  parsePluginTgz,
  readPackageManifestFromTgz,
} from '../src/core/plugins/tar-archive.js';
import {
  installGithubReleaseArchive,
  installGithubReleasePlugin,
  installLocalPlugin,
  installPlugin,
} from '../src/core/plugins/install.js';
import { resolveOfficialPluginPackageSpec } from '../src/core/plugins/init.js';
import * as paths from '../src/core/plugins/paths.js';
import * as registry from '../src/services/plugin-registry-store.js';
import { pluginRecordHash, pluginRegistryRevision, type PluginMutationGuard } from '../src/core/plugins/mutation-guard.js';
import { requestReleaseHop } from '../src/core/release-download.js';
import { buildPluginTgz, buildTarBuffer, buildTgzBuffer } from './helpers/plugin-tar-fixture.js';

function streamFromChunks(chunks: Array<Buffer | Uint8Array>): AsyncIterable<Buffer> & { destroyed: boolean; destroy(): void } {
  const obj = {
    destroyed: false,
    destroy() { obj.destroyed = true; },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        if (obj.destroyed) return;
        yield Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      }
    },
  };
  return obj;
}

function okResponse(
  body: string | Buffer | Array<Buffer>,
  headers: Record<string, string> = {},
): GithubReleaseHopResponse {
  const chunks = Array.isArray(body)
    ? body
    : [typeof body === 'string' ? Buffer.from(body, 'utf8') : body];
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  return {
    kind: 'response',
    statusCode: 200,
    headers: { 'content-length': String(total), ...headers },
    stream: streamFromChunks(chunks),
  };
}

let home = '';
let seq = 0;

function makeLocalPluginSource(id: string, marker = id): string {
  const dir = join(home, `local-src-${seq++}`);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `@test/local-${id}`,
    version: '1.0.0',
    keywords: ['botmux-plugin'],
    botmux: { schemaVersion: 1, id },
  }));
  writeFileSync(join(dir, 'dist', 'marker'), marker);
  return dir;
}

function makeSampleRelease(overrides: {
  repo?: string;
  tag?: string;
  assetName?: string;
  version?: string;
  id?: string;
  packageName?: string;
  marker?: string;
  draft?: boolean;
  prerelease?: boolean;
  includeSha512Asset?: boolean;
  sha512Line?: string;
  apiDigest?: string;
  tarballBytes?: Buffer;
  extraAssets?: Array<{ name: string; browser_download_url: string }>;
  redirectTarget?: string;
} = {}) {
  const repo = overrides.repo ?? 'botmux-ai/botmux-plugin-github';
  const tag = overrides.tag ?? 'v0.1.0';
  const version = overrides.version ?? '0.1.0';
  const id = overrides.id ?? 'github';
  const packageName = overrides.packageName ?? '@botmux-ai/plugin-github';
  const assetName = overrides.assetName ?? `botmux-plugin-github-${version}.tgz`;
  const tarball = overrides.tarballBytes ?? buildPluginTgz(
    {
      name: packageName,
      version,
      description: 'GitHub workflow integration plugin',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id, displayName: 'GitHub' },
    },
    { 'index.js': 'export const ok = true;\n', marker: overrides.marker ?? `gh-${version}` },
  );
  const integrity = computeSha512Integrity(tarball);
  const sha256 = computeSha256Hex(tarball);
  const tgzUrl = `https://github.com/${repo}/releases/download/${tag}/${assetName}`;
  const cdnUrl = overrides.redirectTarget ?? `https://objects.githubusercontent.com/github-production-release-asset/${assetName}`;
  const sha512Url = `https://github.com/${repo}/releases/download/${tag}/${assetName}.sha512`;
  const sha512Text = overrides.sha512Line ?? `${integrity}  ${assetName}\n`;

  const assets: Array<Record<string, unknown>> = [
    {
      name: assetName,
      browser_download_url: tgzUrl,
      size: tarball.length,
      ...(overrides.apiDigest !== undefined ? { digest: overrides.apiDigest } : {}),
    },
    ...(overrides.includeSha512Asset === false ? [] : [{
      name: `${assetName}.sha512`,
      browser_download_url: sha512Url,
      size: Buffer.byteLength(sha512Text, 'utf8'),
    }]),
    ...(overrides.extraAssets ?? []),
  ];

  const releaseJson = {
    tag_name: tag,
    draft: overrides.draft ?? false,
    prerelease: overrides.prerelease ?? false,
    assets,
  };

  const seenRequests: Array<{ url: string; headers: Record<string, string> }> = [];
  const transport: GithubReleaseHopTransport = async (url, headers) => {
    seenRequests.push({ url: url.toString(), headers: { ...headers } });
    const href = url.toString();
    if (
      href === `https://api.github.com/repos/${repo}/releases/latest`
      || href === `https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`
    ) {
      return okResponse(JSON.stringify(releaseJson));
    }
    if (href === sha512Url) {
      return okResponse(sha512Text);
    }
    if (href === tgzUrl) {
      return { kind: 'redirect', statusCode: 302, location: cdnUrl };
    }
    if (href === cdnUrl) {
      return okResponse(tarball);
    }
    return {
      kind: 'response',
      statusCode: 404,
      headers: {},
      stream: streamFromChunks([]),
    };
  };

  return { repo, tag, version, id, packageName, assetName, tarball, integrity, sha256, tgzUrl, cdnUrl, sha512Url, transport, seenRequests };
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'botmux-gh-release-test-'));
  seq = 0;
  vi.stubEnv('HOME', home);
  vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('GITHUB_TOKEN', '');
  vi.stubEnv('GH_TOKEN', '');
  resetGithubReleaseTokenCache();
  mkdirSync(join(home, '.botmux'), { recursive: true });
  expect(paths.pluginsHome()).toBe(join(home, '.botmux', 'plugins'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetGithubReleaseTokenCache();
  rmSync(home, { recursive: true, force: true });
});

describe('github release spec & integrity parsing', () => {
  it('parses latest and tagged github release specs and rejects invalid syntax', () => {
    expect(isGithubReleaseSpec('github:botmux-ai/botmux-plugin-github')).toBe(true);
    expect(isGithubReleaseSpec('@botmux-ai/plugin-github')).toBe(false);
    expect(parseGithubReleaseSpec('github:botmux-ai/botmux-plugin-github')).toEqual({
      owner: 'botmux-ai', name: 'botmux-plugin-github', repo: 'botmux-ai/botmux-plugin-github',
    });
    expect(parseGithubReleaseSpec('github:botmux-ai/botmux-plugin-github@v0.1.0')).toEqual({
      owner: 'botmux-ai', name: 'botmux-plugin-github', repo: 'botmux-ai/botmux-plugin-github', tag: 'v0.1.0',
    });
    expect(resolveOfficialPluginPackageSpec('github:botmux-ai/botmux-plugin-github@v0.1.0'))
      .toBe('github:botmux-ai/botmux-plugin-github@v0.1.0');
    expect(resolveOfficialPluginPackageSpec('file:/tmp/plugin.tgz')).toBe('file:/tmp/plugin.tgz');

    for (const bad of [
      'github:',
      'github:owner',
      'github:owner/',
      'github:/repo',
      'github:../evil/repo',
      'github:owner/..',
      'github:owner/repo/extra',
      'github:owner/repo@',
      'github:owner/repo@../v1',
      'github:owner/repo@v1?foo=bar',
      'https://github.com/owner/repo',
    ]) {
      expect(() => parseGithubReleaseSpec(bad), bad).toThrow(GithubReleaseError);
    }
  });

  it('parses pure SRI and filename-suffixed .tgz.sha512 lines and rejects mismatches', () => {
    const valid = computeSha512Integrity(Buffer.from('plugin-archive'));
    expect(parseSha512IntegrityText(`${valid}\n`, 'plugin-0.1.0.tgz')).toBe(valid);
    expect(parseSha512IntegrityText(`${valid}  plugin-0.1.0.tgz\n`, 'plugin-0.1.0.tgz')).toBe(valid);
    expect(parseSha512IntegrityText(`${valid} *plugin-0.1.0.tgz`, 'plugin-0.1.0.tgz')).toBe(valid);
    expect(parseSha512IntegrityText(`${valid} ./plugin-0.1.0.tgz`, 'plugin-0.1.0.tgz')).toBe(valid);

    expect(() => parseSha512IntegrityText(`${valid}  other-0.1.0.tgz`, 'plugin-0.1.0.tgz')).toThrow(/filename_mismatch/);
    expect(() => parseSha512IntegrityText(`${valid}\n${valid}\n`, 'plugin-0.1.0.tgz')).toThrow(/lines/);
    expect(() => parseSha512IntegrityText('', 'plugin-0.1.0.tgz')).toThrow(/lines/);
    expect(() => parseSha512IntegrityText('sha256-abc123', 'plugin-0.1.0.tgz')).toThrow(/invalid_sri/);
  });

  it('matches asset patterns safely and derives semantic versions from tags and assets', () => {
    expect(matchAssetPattern('botmux-plugin-github-0.1.0.tgz', 'botmux-plugin-github-*.tgz')).toBe(true);
    expect(matchAssetPattern('other-0.1.0.tgz', 'botmux-plugin-github-*.tgz')).toBe(false);
    expect(deriveReleaseVersion('v0.1.0', 'botmux-plugin-github-0.1.0.tgz')).toBe('0.1.0');
    expect(deriveReleaseVersion('1.2.3-beta.1')).toBe('1.2.3-beta.1');
    expect(deriveReleaseVersion('plugin-v2.0.0')).toBe('2.0.0');
    expect(deriveReleaseVersion('release-latest', 'botmux-plugin-github-0.3.1.tgz')).toBe('0.3.1');
    expect(deriveReleaseVersion('release-latest', 'plugin.tgz')).toBeUndefined();
  });
});

describe('github release download security boundary', () => {
  it('enforces HTTPS and exact host allowlist on initial URLs and redirects', async () => {
    for (const allowed of [
      'https://api.github.com/repos/a/b/releases/latest',
      'https://github.com/a/b/releases/download/v1.0.0/p.tgz',
      'https://objects.githubusercontent.com/asset/1',
      'https://release-assets.githubusercontent.com/asset/2',
    ]) {
      expect(() => assertAllowedGithubReleaseUrl(allowed)).not.toThrow();
    }
    for (const forbidden of [
      'http://github.com/a/b/releases/download/v1.0.0/p.tgz',
      'https://evil.example.com/p.tgz',
      'https://github.com.evil.com/p.tgz',
      'https://api.github.com:8443/repos/a/b',
      'https://user:pass@api.github.com/repos/a/b',
      'file:///etc/passwd',
    ]) {
      expect(() => assertAllowedGithubReleaseUrl(forbidden), forbidden).toThrow(GithubReleaseError);
    }

    // Redirect to a disallowed domain must fail before issuing a request to that domain.
    const contacted: string[] = [];
    const evilRedirectTransport: GithubReleaseHopTransport = async url => {
      contacted.push(url.hostname);
      return { kind: 'redirect', statusCode: 302, location: 'https://evil.example.com/malicious.tgz' };
    };
    await expect(fetchGithubReleaseBytes('https://github.com/a/b/releases/download/v1/p.tgz', {
      transport: evilRedirectTransport,
      resolveToken: async () => null,
    })).rejects.toMatchObject({ code: 'disallowed_url' });
    expect(contacted).toEqual(['github.com']);

    // Exceeding redirect cap fails closed.
    let hops = 0;
    const loopTransport: GithubReleaseHopTransport = async () => {
      hops++;
      return { kind: 'redirect', statusCode: 302, location: `https://objects.githubusercontent.com/hop-${hops}` };
    };
    await expect(fetchGithubReleaseBytes('https://github.com/a/b/releases/download/v1/p.tgz', {
      transport: loopTransport,
      maxRedirects: 3,
      resolveToken: async () => null,
    })).rejects.toMatchObject({ code: 'too_many_redirects' });
    expect(hops).toBe(4);
  });

  it('scopes Authorization headers strictly to api.github.com and retries anonymously on 401', async () => {
    const sentAuth: Array<{ host: string; auth?: string }> = [];
    let apiAttempts = 0;
    const transport: GithubReleaseHopTransport = async (url, headers) => {
      sentAuth.push({ host: url.hostname, auth: headers.Authorization });
      if (url.hostname === 'api.github.com' && ++apiAttempts === 1) {
        return { kind: 'response', statusCode: 401, headers: {}, stream: streamFromChunks([]) };
      }
      if (url.hostname === 'api.github.com') {
        return { kind: 'redirect', statusCode: 302, location: 'https://objects.githubusercontent.com/body' };
      }
      return okResponse('payload');
    };

    const bytes = await fetchGithubReleaseBytes('https://api.github.com/repos/a/b/releases/latest', {
      allowAuth: true,
      transport,
      resolveToken: async () => 'ghp_super_secret_token_value',
    });
    expect(bytes.toString('utf8')).toBe('payload');
    expect(sentAuth).toEqual([
      { host: 'api.github.com', auth: 'Bearer ghp_super_secret_token_value' },
      { host: 'api.github.com', auth: undefined },
      { host: 'objects.githubusercontent.com', auth: undefined },
    ]);

    // Even when allowAuth succeeds on api.github.com and redirects to CDN, Authorization is stripped.
    const redirectAuth: Array<{ host: string; auth?: string }> = [];
    const redirectTransport: GithubReleaseHopTransport = async (url, headers) => {
      redirectAuth.push({ host: url.hostname, auth: headers.Authorization });
      if (url.hostname === 'api.github.com') {
        return { kind: 'redirect', statusCode: 302, location: 'https://release-assets.githubusercontent.com/bin' };
      }
      return okResponse('ok');
    };
    await fetchGithubReleaseBytes('https://api.github.com/repos/a/b/releases/assets/1', {
      allowAuth: true,
      transport: redirectTransport,
      resolveToken: async () => 'ghp_secret_2',
    });
    expect(redirectAuth).toEqual([
      { host: 'api.github.com', auth: 'Bearer ghp_secret_2' },
      { host: 'release-assets.githubusercontent.com', auth: undefined },
    ]);
  });

  it('enforces size limits via Content-Length and streamed byte count and cleans partial files', async () => {
    const dest = join(home, 'oversize.tgz');
    await expect(downloadGithubReleaseAssetToFile(
      'https://github.com/a/b/releases/download/v1/big.tgz',
      dest,
      {
        maxArchiveBytes: 100,
        resolveToken: async () => null,
        transport: async () => ({
          kind: 'response',
          statusCode: 200,
          headers: { 'content-length': '200' },
          stream: streamFromChunks([Buffer.alloc(200, 1)]),
        }),
      },
    )).rejects.toMatchObject({ code: 'asset_too_large' });
    expect(existsSync(dest)).toBe(false);

    // Lied/missing Content-Length must still be rejected during streaming.
    await expect(downloadGithubReleaseAssetToFile(
      'https://github.com/a/b/releases/download/v1/stream-big.tgz',
      dest,
      {
        maxArchiveBytes: 100,
        resolveToken: async () => null,
        transport: async () => ({
          kind: 'response',
          statusCode: 200,
          headers: {},
          stream: streamFromChunks([Buffer.alloc(60, 1), Buffer.alloc(60, 2)]),
        }),
      },
    )).rejects.toMatchObject({ code: 'asset_too_large' });
    expect(existsSync(dest)).toBe(false);
  });

  it('enforces request timeout abort cleanly', async () => {
    await expect(fetchGithubReleaseBytes('https://api.github.com/repos/a/b/releases/latest', {
      timeoutMs: 30,
      resolveToken: async () => null,
      transport: async (_url, _headers, signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), { once: true });
      }),
    })).rejects.toMatchObject({ code: 'timeout' });
  });

  it('supports standard HTTP proxy hops via requestReleaseHop', async () => {
    const seenProxyTargets: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      seenProxyTargets.push(req.url ?? '');
      if (req.url === 'http://example.invalid/hop-1') {
        res.writeHead(302, { location: 'http://example.invalid/hop-2' });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('proxied-ok');
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as { port: number }).port;
      const proxy = `http://127.0.0.1:${port}`;
      const hop1 = await requestReleaseHop('http://example.invalid/hop-1', proxy, 'botmux-test');
      expect(hop1).toEqual({ kind: 'redirect', statusCode: 302, location: 'http://example.invalid/hop-2' });
      const hop2 = await requestReleaseHop('http://example.invalid/hop-2', proxy, 'botmux-test');
      expect(hop2.kind).toBe('response');
      if (hop2.kind === 'response') {
        const chunks: Buffer[] = [];
        for await (const chunk of hop2.stream) chunks.push(Buffer.from(chunk));
        expect(Buffer.concat(chunks).toString('utf8')).toBe('proxied-ok');
      }
      expect(seenProxyTargets).toEqual(['http://example.invalid/hop-1', 'http://example.invalid/hop-2']);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});

describe('plugin tar archive safety', () => {
  it('supports standard ustar, PAX long paths and GNU LongLink while rejecting malicious tar entries', () => {
    const manifest = { name: '@test/p', version: '1.0.0', keywords: ['botmux-plugin'], botmux: { schemaVersion: 1, id: 'p' } };
    const longRel = `package/dist/${'nested-segment-'.repeat(8)}index.js`;
    const paxTgz = buildTgzBuffer([
      { path: 'package/package.json', content: JSON.stringify(manifest) },
      { path: 'package/dist/truncated', paxPath: longRel, content: 'export const x = 1;\n' },
    ]);
    expect(readPackageManifestFromTgz(paxTgz)).toEqual(manifest);
    const outDir = join(home, 'extract-pax');
    const pkgDir = extractPluginTgz(paxTgz, outDir);
    expect(readFileSync(join(pkgDir, longRel.slice('package/'.length)), 'utf8')).toBe('export const x = 1;\n');

    const gnuTgz = buildTgzBuffer([
      { path: 'package/package.json', content: JSON.stringify(manifest) },
      { path: 'package/dist/truncated', gnuLongPath: longRel, content: 'export const y = 2;\n' },
    ]);
    const outGnu = join(home, 'extract-gnu');
    const gnuDir = extractPluginTgz(gnuTgz, outGnu);
    expect(readFileSync(join(gnuDir, longRel.slice('package/'.length)), 'utf8')).toBe('export const y = 2;\n');

    // Malicious tarballs must be rejected fail-closed.
    const symlinkTgz = buildTgzBuffer([
      { path: 'package/package.json', content: JSON.stringify(manifest) },
      { path: 'package/dist/link', typeflag: '2', linkname: '/etc/passwd' },
    ]);
    expect(() => parsePluginTgz(symlinkTgz)).toThrow(/unsupported_entry_type/);

    const hardlinkTgz = buildTgzBuffer([
      { path: 'package/package.json', content: JSON.stringify(manifest) },
      { path: 'package/dist/hard', typeflag: '1', linkname: 'package/package.json' },
    ]);
    expect(() => parsePluginTgz(hardlinkTgz)).toThrow(/unsupported_entry_type/);

    const traversalTgz = buildTgzBuffer([
      { path: 'package/package.json', content: JSON.stringify(manifest) },
      { path: 'package/../escape.js', content: 'evil' },
    ]);
    expect(() => parsePluginTgz(traversalTgz)).toThrow(/invalid_path/);

    const outsideTgz = buildTgzBuffer([
      { path: 'other/package.json', content: JSON.stringify(manifest) },
    ]);
    expect(() => parsePluginTgz(outsideTgz)).toThrow(/outside_package/);

    const dupManifestTgz = buildTgzBuffer([
      { path: 'package/package.json', content: JSON.stringify(manifest) },
      { path: 'package/package.json', content: JSON.stringify({ ...manifest, version: '9.9.9' }) },
    ]);
    expect(() => parsePluginTgz(dupManifestTgz)).toThrow(/duplicate_entry/);

    const badChecksumTgz = buildTgzBuffer([
      { path: 'package/package.json', content: JSON.stringify(manifest), corruptChecksum: true },
    ]);
    expect(() => parsePluginTgz(badChecksumTgz)).toThrow(/invalid_checksum/);

    const bomb = gzipSync(Buffer.alloc(2048, 0));
    expect(() => parsePluginTgz(bomb, { maxUncompressedBytes: 512 })).toThrow(/too_large/);

    const rawTar = buildTarBuffer([{ path: 'package/package.json', content: JSON.stringify(manifest) }]);
    const truncatedTgz = gzipSync(rawTar.subarray(0, 700));
    expect(() => parsePluginTgz(truncatedTgz)).toThrow(/truncated/);
  });
});

describe('github release installation & lifecycle integration', () => {
  it('installs a verified GitHub Release plugin and records full provenance', async () => {
    const rel = makeSampleRelease({ apiDigest: undefined });
    const result = await installPlugin(`github:${rel.repo}`, {
      githubRelease: { transport: rel.transport, resolveToken: async () => null },
    });

    expect(result.record.id).toBe('github');
    expect(result.record.packageName).toBe('@botmux-ai/plugin-github');
    expect(result.record.version).toBe('0.1.0');
    expect(result.record.integrity).toBe(rel.integrity);
    expect(result.record.source).toEqual({
      type: 'github-release',
      repo: rel.repo,
      tag: 'v0.1.0',
      asset: rel.assetName,
      integrity: rel.integrity,
    });
    expect(readFileSync(join(paths.pluginRuntimeDir('github'), 'marker'), 'utf8')).toBe('gh-0.1.0');
    // Temp staging/download directories must be cleaned up.
    expect(readdirSync(paths.pluginsHome()).filter(name => name.startsWith('.'))).toEqual([]);
  });

  it('installs a specific tag with auxiliary sha256 digest cross-check', async () => {
    const rel = makeSampleRelease({ tag: 'v0.2.0', version: '0.2.0', marker: 'gh-0.2.0' });
    const withDigest = makeSampleRelease({
      tag: 'v0.2.0',
      version: '0.2.0',
      tarballBytes: rel.tarball,
      apiDigest: `sha256:${rel.sha256}`,
    });

    const result = await installGithubReleasePlugin(`github:${withDigest.repo}@v0.2.0`, {
      githubRelease: { transport: withDigest.transport, resolveToken: async () => null },
    });
    expect(result.record.version).toBe('0.2.0');
    expect(result.record.source).toMatchObject({ type: 'github-release', tag: 'v0.2.0' });

    // Mismatched auxiliary sha256 digest must fail closed.
    const badDigest = makeSampleRelease({
      tag: 'v0.2.1',
      version: '0.2.1',
      tarballBytes: rel.tarball,
      apiDigest: `sha256:${'0'.repeat(64)}`,
    });
    await expect(installGithubReleasePlugin(`github:${badDigest.repo}@v0.2.1`, {
      githubRelease: { transport: badDigest.transport, resolveToken: async () => null },
    })).rejects.toMatchObject({ code: 'sha256_mismatch' });
    expect(registry.getInstalledPlugin('github')?.version).toBe('0.2.0');
  });

  it('refuses missing .tgz.sha512, draft/prerelease latest, sha512 mismatch, bad redirects and manifest mismatches', async () => {
    // 1. Missing .tgz.sha512 -> never install unverified tarball.
    const noSha = makeSampleRelease({ includeSha512Asset: false });
    await expect(installGithubReleasePlugin(`github:${noSha.repo}`, {
      githubRelease: { transport: noSha.transport, resolveToken: async () => null },
    })).rejects.toMatchObject({ code: 'integrity_asset_not_found' });

    // 2. Draft or prerelease returned for latest -> rejected.
    const draft = makeSampleRelease({ draft: true });
    await expect(resolveGithubReleaseAsset({ repo: draft.repo }, {
      transport: draft.transport, resolveToken: async () => null,
    })).rejects.toMatchObject({ code: 'release_not_published' });

    const pre = makeSampleRelease({ prerelease: true });
    await expect(resolveGithubReleaseAsset({ repo: pre.repo }, {
      transport: pre.transport, resolveToken: async () => null,
    })).rejects.toMatchObject({ code: 'release_not_published' });

    // 3. sha512 mismatch -> rejected and temp dirs cleaned.
    const wrongHash = computeSha512Integrity(Buffer.from('different bytes'));
    const badSha = makeSampleRelease({ sha512Line: `${wrongHash}  botmux-plugin-github-0.1.0.tgz` });
    await expect(installGithubReleasePlugin(`github:${badSha.repo}`, {
      githubRelease: { transport: badSha.transport, resolveToken: async () => null },
    })).rejects.toMatchObject({ code: 'integrity_mismatch' });

    // 4. Non-allowlisted redirect -> rejected.
    const evilRedirect = makeSampleRelease({ redirectTarget: 'https://attacker.invalid/evil.tgz' });
    await expect(installGithubReleasePlugin(`github:${evilRedirect.repo}`, {
      githubRelease: { transport: evilRedirect.transport, resolveToken: async () => null },
    })).rejects.toMatchObject({ code: 'disallowed_url' });

    // 5. Release tag version disagrees with package.json version -> rejected.
    const versionMismatch = makeSampleRelease({ tag: 'v0.1.0', version: '9.9.9', assetName: 'botmux-plugin-github-0.1.0.tgz' });
    await expect(installGithubReleasePlugin(`github:${versionMismatch.repo}`, {
      githubRelease: { transport: versionMismatch.transport, resolveToken: async () => null },
    })).rejects.toMatchObject({ code: 'manifest_mismatch' });

    // 6. --link is rejected for GitHub Release installs.
    await expect(installPlugin(`github:${noSha.repo}`, { link: true })).rejects.toThrow(/link_not_supported/);

    expect(registry.listInstalledPlugins()).toEqual([]);
    expect(readdirSync(paths.pluginsHome()).filter(name => name.startsWith('.'))).toEqual([]);
  });

  it('enforces PluginMutationGuard (id/name/version, archive integrity, TOCTOU, authority) on install-verified', async () => {
    const rel = makeSampleRelease();
    const archivePath = join(home, rel.assetName);
    writeFileSync(archivePath, rel.tarball);
    writeFileSync(join(home, '.botmux', '.dashboard-token'), 'active-token');

    const baseGuard = (): PluginMutationGuard => ({
      id: 'github',
      packageName: '@botmux-ai/plugin-github',
      version: '0.1.0',
      expectedState: null,
      expectedRevision: pluginRegistryRevision(),
      integrity: rel.integrity,
      authorityDigest: createHash('sha256').update('active-token').digest('hex'),
      source: { type: 'github-release', repo: rel.repo, tag: rel.tag, asset: rel.assetName },
    });

    // Wrong id / name / version in guard must reject before creating plugin home.
    for (const bad of [
      { id: 'other' },
      { packageName: '@other/plugin-github' },
      { version: '2.0.0' },
    ]) {
      await expect(installPlugin(`file:${archivePath}`, {
        guard: { ...baseGuard(), ...bad },
      })).rejects.toThrow(/manifest_mismatch/);
    }
    expect(existsSync(paths.pluginHome('github'))).toBe(false);

    // Revoked authority token must reject.
    await expect(installPlugin(`file:${archivePath}`, {
      guard: { ...baseGuard(), authorityDigest: createHash('sha256').update('old-token').digest('hex') },
    })).rejects.toThrow(/authority_revoked/);

    // Tampered archive on disk must reject before extraction.
    const tamperedPath = join(home, 'tampered.tgz');
    writeFileSync(tamperedPath, Buffer.from('tampered bytes'));
    await expect(installPlugin(`file:${tamperedPath}`, { guard: baseGuard() }))
      .rejects.toThrow(/archive_mismatch/);

    // Valid guarded install-verified succeeds and records github-release provenance.
    const installed = await installPlugin(`file:${archivePath}`, { guard: baseGuard() });
    expect(installed.record.source).toEqual({
      type: 'github-release',
      repo: rel.repo,
      tag: rel.tag,
      asset: rel.assetName,
      integrity: rel.integrity,
    });

    // Stale expectedState (null when plugin is now installed) must reject.
    await expect(installPlugin(`file:${archivePath}`, {
      guard: { ...baseGuard(), expectedRevision: pluginRegistryRevision() },
    })).rejects.toThrow(/confirmation_superseded/);
  });

  it('stays compatible with legacy local/npm records and cleanupRetiredPluginHomes', async () => {
    // Seed a legacy npm record and a local record alongside a github-release plugin.
    const localSrc = makeLocalPluginSource('local-one', 'local-v1');
    installLocalPlugin(localSrc);

    const legacyNpmRuntime = paths.pluginRuntimeDir('legacy-npm');
    mkdirSync(legacyNpmRuntime, { recursive: true });
    writeFileSync(join(legacyNpmRuntime, 'marker'), 'npm-v1');
    registry.upsertInstalledPlugin({
      id: 'legacy-npm',
      packageName: '@test/legacy-npm',
      version: '1.0.0',
      source: { type: 'npm', spec: '@test/legacy-npm@1.0.0' },
      manifest: { schemaVersion: 1, id: 'legacy-npm' },
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Install a github-release plugin first, then create a retired home for a different unregistered plugin.
    const ghRel = makeSampleRelease();
    await installGithubReleasePlugin(`github:${ghRel.repo}`, {
      githubRelease: { transport: ghRel.transport, resolveToken: async () => null },
    });

    const retiredForNew = `${paths.pluginHome('reinstalled')}.removed-123-456`;
    mkdirSync(retiredForNew, { recursive: true });
    writeFileSync(join(retiredForNew, 'stale'), 'old');

    // Installing another plugin via local or github-release must still collect retired homes
    // even when a github-release plugin is present in the registry!
    const reinstallRel = makeSampleRelease({
      id: 'reinstalled',
      packageName: '@botmux-ai/plugin-reinstalled',
      assetName: 'botmux-plugin-reinstalled-0.1.0.tgz',
      marker: 'reinstalled-v1',
    });
    const archive = join(home, reinstallRel.assetName);
    writeFileSync(archive, reinstallRel.tarball);
    installGithubReleaseArchive(archive, {
      repo: reinstallRel.repo,
      tag: reinstallRel.tag,
      asset: reinstallRel.assetName,
      integrity: reinstallRel.integrity,
      expectedVersion: '0.1.0',
    });

    expect(existsSync(retiredForNew)).toBe(false);
    expect(registry.getInstalledPlugin('local-one')?.source.type).toBe('local');
    expect(registry.getInstalledPlugin('legacy-npm')?.source.type).toBe('npm');
    expect(registry.getInstalledPlugin('github')?.source.type).toBe('github-release');
    expect(registry.getInstalledPlugin('reinstalled')?.source.type).toBe('github-release');
  });

  it('installs a real OS-packed tar.gz archive and rolls back runtime cleanly when registry commit fails', () => {
    // Pack a real package/ tree with system tar so parser parity with real tarballs is proven.
    const packRoot = join(home, 'real-pack');
    mkdirSync(join(packRoot, 'package', 'dist'), { recursive: true });
    writeFileSync(join(packRoot, 'package', 'package.json'), JSON.stringify({
      name: '@botmux-ai/plugin-real-tar',
      version: '0.5.0',
      keywords: ['botmux-plugin'],
      botmux: { schemaVersion: 1, id: 'real-tar', displayName: 'Real Tar' },
    }));
    writeFileSync(join(packRoot, 'package', 'dist', 'marker'), 'real-tar-v0.5.0');
    const tgzPath = join(home, 'botmux-plugin-real-tar-0.5.0.tgz');
    execFileSync('tar', ['-czf', tgzPath, '-C', packRoot, 'package']);

    const tgzBytes = readFileSync(tgzPath);
    const integrity = computeSha512Integrity(tgzBytes);
    const installed = installGithubReleaseArchive(tgzPath, {
      repo: 'botmux-ai/botmux-plugin-real-tar',
      tag: 'v0.5.0',
      asset: 'botmux-plugin-real-tar-0.5.0.tgz',
      integrity,
      expectedVersion: '0.5.0',
    });
    expect(installed.record.source).toEqual({
      type: 'github-release',
      repo: 'botmux-ai/botmux-plugin-real-tar',
      tag: 'v0.5.0',
      asset: 'botmux-plugin-real-tar-0.5.0.tgz',
      integrity,
    });
    expect(readFileSync(join(paths.pluginRuntimeDir('real-tar'), 'marker'), 'utf8')).toBe('real-tar-v0.5.0');

    // Simulate a failed update when the plugin's background service is marked running -> refuses & keeps v0.5.0.
    const svcPkg = buildPluginTgz(
      {
        name: '@botmux-ai/plugin-svc-gh',
        version: '0.1.0',
        keywords: ['botmux-plugin'],
        botmux: { schemaVersion: 1, id: 'svc-gh', service: { mode: 'manual' } },
      },
      { 'service/index.js': 'export {};\n', marker: 'svc-v1' },
    );
    const svcPath = join(home, 'svc-gh-0.1.0.tgz');
    writeFileSync(svcPath, svcPkg);
    installGithubReleaseArchive(svcPath, {
      repo: 'botmux-ai/botmux-plugin-svc-gh',
      tag: 'v0.1.0',
      asset: 'svc-gh-0.1.0.tgz',
      integrity: computeSha512Integrity(svcPkg),
      expectedVersion: '0.1.0',
    });
    const desiredPath = join(home, '.botmux', 'plugin-supervisor', 'desired.json');
    mkdirSync(join(home, '.botmux', 'plugin-supervisor'), { recursive: true });
    writeFileSync(desiredPath, JSON.stringify({
      revision: 'running',
      target: 'svc-gh',
      services: { 'svc-gh': { running: true, spec: { name: 'botmux-plugin-svc-gh', external: { command: '/never-executed' } } } },
    }));
    const svcV2 = buildPluginTgz(
      {
        name: '@botmux-ai/plugin-svc-gh',
        version: '0.2.0',
        keywords: ['botmux-plugin'],
        botmux: { schemaVersion: 1, id: 'svc-gh', service: { mode: 'manual' } },
      },
      { 'service/index.js': 'export {};\n', marker: 'svc-v2' },
    );
    const svcV2Path = join(home, 'svc-gh-0.2.0.tgz');
    writeFileSync(svcV2Path, svcV2);
    expect(() => installGithubReleaseArchive(svcV2Path, {
      repo: 'botmux-ai/botmux-plugin-svc-gh',
      tag: 'v0.2.0',
      asset: 'svc-gh-0.2.0.tgz',
      integrity: computeSha512Integrity(svcV2),
      expectedVersion: '0.2.0',
    })).toThrow(/plugin_service_running/);
    expect(readFileSync(join(paths.pluginRuntimeDir('svc-gh'), 'marker'), 'utf8')).toBe('svc-v1');

    // Rollback check: when atomic registry rename fails (directory at registry path -> EISDIR even as root),
    // previous runtime is restored intact.
    rmSync(desiredPath, { force: true });
    const registryBackup = readFileSync(paths.pluginRegistryPath(), 'utf8');
    rmSync(paths.pluginRegistryPath(), { force: true });
    mkdirSync(paths.pluginRegistryPath());
    try {
      expect(() => installGithubReleaseArchive(svcV2Path, {
        repo: 'botmux-ai/botmux-plugin-svc-gh',
        tag: 'v0.2.0',
        asset: 'svc-gh-0.2.0.tgz',
        integrity: computeSha512Integrity(svcV2),
        expectedVersion: '0.2.0',
      })).toThrow();
      expect(readFileSync(join(paths.pluginRuntimeDir('svc-gh'), 'marker'), 'utf8')).toBe('svc-v1');
    } finally {
      rmSync(paths.pluginRegistryPath(), { recursive: true, force: true });
      writeFileSync(paths.pluginRegistryPath(), registryBackup);
    }
  });

  it('resolves optional GitHub API token from env first and falls back to gh auth token cleanly', async () => {
    const ghSpy = vi.fn(async () => 'gho_from_cli');
    expect(await resolveOptionalGithubApiToken({
      readEnvHeaders: () => ({ Authorization: 'Bearer ghp_from_env' }),
      readGhToken: ghSpy,
    })).toBe('ghp_from_env');
    expect(ghSpy).not.toHaveBeenCalled();

    expect(await resolveOptionalGithubApiToken({
      readEnvHeaders: () => ({}),
      readGhToken: ghSpy,
    })).toBe('gho_from_cli');
    expect(ghSpy).toHaveBeenCalledTimes(1);

    expect(await resolveOptionalGithubApiToken({
      readEnvHeaders: () => ({}),
      readGhToken: async () => { throw new Error('gh not installed'); },
    })).toBeNull();
  });
});
