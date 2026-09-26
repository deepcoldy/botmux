/**
 * Unit tests for the macOS scratch Seatbelt profile builder. Runs on Linux CI
 * (pure string builder — no sandbox-exec / Mac required). The end-to-end
 * symlink-farm + clonefile + confinement behaviour is covered on a Mac by
 * scripts/scratch-sandbox-darwin-probe.mjs.
 */
import { describe, expect, it } from 'vitest';
import { buildMacScratchProfile } from '../src/adapters/backend/scratch-sandbox-darwin.js';

const join = (lines: string[]) => lines.join('\n');
const idx = (p: string, rule: string) => p.indexOf(rule);

describe('buildMacScratchProfile — three-stage credential sealing', () => {
  it('denies all writes and re-opens the scratch clone/tmp/outbox', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/d/s/clone/home', '/d/s/tmp', '/d/s/outbox', '/d/s/shimbin'],
    }));
    expect(p).toContain('(deny file-write*)');
    for (const w of ['/d/s/clone/home', '/d/s/tmp', '/d/s/outbox', '/d/s/shimbin']) {
      expect(p).toContain(`(allow file-write* (subpath "${w}"))`);
      expect(p).toContain(`(allow file-read* (subpath "${w}"))`);
    }
  });

  it('seals the secret root BEFORE the session re-open so a session dir under it survives', () => {
    // Session data dir lives at ~/.botmux/data — the authority root is
    // ~/.botmux (broader), the session grant (~/.botmux/data/sandboxes/s) is
    // deeper and must come after to carve the session back out.
    const p = join(buildMacScratchProfile({
      net: true,
      authorityRootDenies: ['/Users/u/.botmux'],
      writable: ['/Users/u/.botmux/data/sandboxes/s/clone/home', '/Users/u/.botmux/data/sandboxes/s/outbox'],
    }));
    const sealWrite = idx(p, '(deny file-write* (subpath "/Users/u/.botmux")');
    const sealRead = idx(p, '(deny file-read* (subpath "/Users/u/.botmux")');
    const reopen = idx(p, '(allow file-write* (subpath "/Users/u/.botmux/data/sandboxes/s/clone/home")');
    expect(sealWrite).toBeGreaterThan(0);
    expect(sealRead).toBeGreaterThan(0);
    expect(reopen).toBeGreaterThan(sealWrite);
    expect(reopen).toBeGreaterThan(sealRead);
  });

  it('still denies bots.json reads through the farm symlink (final file deny wins)', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      authorityRootDenies: ['/Users/u/.botmux'],
      writable: ['/d/clone/home'],
      fileDenyPaths: ['/Users/u/.botmux/bots.json'],
    }));
    expect(p).toContain('(deny file-read* (subpath "/Users/u/.botmux/bots.json")');
    const fileDeny = idx(p, '(deny file-read* (subpath "/Users/u/.botmux/bots.json")');
    const rootSeal = idx(p, '(deny file-read* (subpath "/Users/u/.botmux")');
    expect(fileDeny).toBeGreaterThan(rootSeal);
  });

  it('write-seals symlink-degraded subtrees (read-native, write EPERM)', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/d/clone/home'],
      fileWriteDenyPaths: ['/Users/u/.gitlog', '/Users/u/Library/Caches/claude-cli-nodejs'],
    }));
    expect(p).toContain('(deny file-write* (subpath "/Users/u/.gitlog")');
    expect(p).toContain('(deny file-write* (subpath "/Users/u/Library/Caches/claude-cli-nodejs")');
    // No read deny for a degraded-but-readable subtree.
    expect(p).not.toContain('(deny file-read* (subpath "/Users/u/.gitlog")');
  });

  it('grants host-real cache/temp areas (Foundation ignores HOME/TMPDIR)', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: [],
      hostWritable: ['/private/tmp', '/private/var/tmp', '/private/var/folders',
        '/Users/u/Library/Caches', '/Users/u/Library/Application Support', '/Users/u/Library/Logs'],
    }));
    expect(p).toContain('(allow file-write* (subpath "/private/tmp")');
    expect(p).toContain('(allow file-write* (subpath "/Users/u/Library/Application Support")');
  });

  it('claude MCP cache write-deny lands after the broad Caches allow', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      hostWritable: ['/Users/u/Library/Caches'],
      fileWriteDenyPaths: ['/Users/u/Library/Caches/claude-cli-nodejs'],
    }));
    expect(idx(p, '(deny file-write* (subpath "/Users/u/Library/Caches/claude-cli-nodejs")'))
      .toBeGreaterThan(idx(p, '(allow file-write* (subpath "/Users/u/Library/Caches")'));
  });

  it('denies networking when net=false', () => {
    expect(join(buildMacScratchProfile({ net: false, writable: [] }))).toContain('(deny network*)');
    expect(join(buildMacScratchProfile({ net: true, writable: [] }))).not.toContain('(deny network*)');
  });

  it('adds literal connect grants for the MCP gateway socket', () => {
    const p = join(buildMacScratchProfile({ net: true, writable: [], mcpSocket: '/d/mcp.sock' }));
    expect(p).toContain('(allow file-write* (literal "/d/mcp.sock")');
    expect(p).toContain('(allow file-read* (literal "/d/mcp.sock")');
  });

  it('escapes quotes/backslashes and ignores non-absolute/garbage entries', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/h/a"b'],
      authorityRootDenies: ['/h/c\\d', 'relative'],
      fileDenyPaths: ['', 'x'],
    }));
    expect(p).toContain('(allow file-write* (subpath "/h/a\\"b")');
    expect(p).toContain('(deny file-write* (subpath "/h/c\\\\d")');
    expect(p).not.toContain('relative');
  });
});
