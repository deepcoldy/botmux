import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveCanvasSkiaNative } from '../scripts/resolve-canvas-native.mjs';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'botmux-canvas-test-'));
  writeFileSync(join(root, 'package.json'), '{}');
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

function installedNative(suffix: string): string {
  const directory = join(root, 'node_modules', '@napi-rs', `canvas-${suffix}`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{}');
  const native = join(directory, `skia.${suffix}.node`);
  writeFileSync(native, 'native fixture');
  return native;
}

function lockedTarball(suffix: string, url = '', includeNative = true): Buffer {
  const directory = join(root, 'package');
  mkdirSync(directory);
  writeFileSync(join(directory, includeNative ? `skia.${suffix}.node` : 'package.json'), 'native fixture');
  const archive = join(root, 'canvas.tgz');
  execFileSync('tar', ['-czf', archive, '-C', root, 'package']);
  const bytes = readFileSync(archive);
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const name = `@napi-rs/canvas-${suffix}`;
  writeFileSync(join(root, 'bun.lock'), JSON.stringify({
    packages: { [name]: [`${name}@0.1.100`, url, {}, integrity] },
  }));
  return bytes;
}

describe('canvas native resolution for the release matrix', () => {
  it.each([
    ['linux', 'x64', 'glibc', 'linux-x64-gnu'],
    ['linux', 'arm64', 'glibc', 'linux-arm64-gnu'],
    ['linux', 'x64', 'musl', 'linux-x64-musl'],
    ['linux', 'arm64', 'musl', 'linux-arm64-musl'],
    ['darwin', 'x64', null, 'darwin-x64'],
    ['darwin', 'arm64', null, 'darwin-arm64'],
  ])('uses the matching installed package for %s-%s-%s', async (platform, arch, libc, suffix) => {
    const expected = realpathSync(installedNative(suffix!));
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    // Bun 的 require.resolve 返回未展开的软链路径，而 expected 取了 realpath；
    // TMPDIR 本身可能是软链（botmux 会话、macOS 默认临时目录），两边都 realpath 再比。
    const resolved = await resolveCanvasSkiaNative(platform, arch, libc, { repoRoot: root, tempRoot: root });
    expect(realpathSync(resolved)).toBe(expected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects unknown Linux libc instead of falling back to the host package', async () => {
    installedNative('linux-x64-gnu');
    await expect(resolveCanvasSkiaNative('linux', 'x64', null, { repoRoot: root })).rejects.toThrow(/libc/);
  });

  it.each([['win32', 'x64'], ['linux', 'arm']])('rejects unsupported target %s-%s', async (platform, arch) => {
    await expect(resolveCanvasSkiaNative(platform, arch, 'glibc', { repoRoot: root })).rejects.toThrow(/Unsupported canvas target/);
  });

  it('does not silently use a different libc package', async () => {
    installedNative('linux-x64-gnu');
    writeFileSync(join(root, 'bun.lock'), '{"packages":{}}');
    await expect(resolveCanvasSkiaNative('linux', 'x64', 'musl', { repoRoot: root })).rejects.toThrow(/canvas-linux-x64-musl.*not pinned/);
  });

  it.each(['', 'https://registry.example.test/canvas.tgz'])('downloads integrity-checked locked bytes with registry field %j', async (url) => {
    const bytes = lockedTarball('linux-arm64-musl', url);
    const fetch = vi.fn().mockResolvedValue(new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    const native = await resolveCanvasSkiaNative('linux', 'arm64', 'musl', { repoRoot: root, tempRoot: root });
    expect(readFileSync(native, 'utf8')).toBe('native fixture');
    expect(fetch).toHaveBeenCalledWith(url || 'https://registry.npmjs.org/@napi-rs/canvas-linux-arm64-musl/-/canvas-linux-arm64-musl-0.1.100.tgz');
  });

  it('preserves the darwin cross-build fallback', async () => {
    const bytes = lockedTarball('darwin-x64', 'https://registry.example.test/darwin.tgz');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
    const native = await resolveCanvasSkiaNative('darwin', 'x64', null, { repoRoot: root, tempRoot: root });
    expect(readFileSync(native, 'utf8')).toBe('native fixture');
  });

  it('fails closed on an integrity mismatch', async () => {
    lockedTarball('linux-x64-gnu');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('tampered')));
    await expect(resolveCanvasSkiaNative('linux', 'x64', 'glibc', { repoRoot: root, tempRoot: root })).rejects.toThrow(/integrity mismatch/);
  });

  it('fails closed on a failed download', async () => {
    lockedTarball('linux-x64-musl');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 503 })));
    await expect(resolveCanvasSkiaNative('linux', 'x64', 'musl', { repoRoot: root, tempRoot: root })).rejects.toThrow(/HTTP 503/);
  });

  it('fails closed when the locked archive lacks its native', async () => {
    const bytes = lockedTarball('linux-x64-musl', '', false);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(bytes)));
    await expect(resolveCanvasSkiaNative('linux', 'x64', 'musl', { repoRoot: root, tempRoot: root })).rejects.toThrow(/has no skia.linux-x64-musl.node/);
  });

  it('embeds canvas for Linux as well as darwin and infers host-build libc from node-pty', () => {
    const build = readFileSync(resolve(import.meta.dirname, '../scripts/build-bun-binary.mjs'), 'utf8');
    expect(build).not.toMatch(/platform === 'darwin' \? await resolveCanvasSkiaNative/);
    expect(build).toMatch(/resolveCanvasSkiaNative\(platform, arch,.*nativeLibc\(ptyNode\)/);
  });
});
