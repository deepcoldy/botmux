/**
 * Unit tests for the macOS scratch Seatbelt profile builder. Runs on Linux CI
 * (pure string builder — no sandbox-exec / Mac required). The end-to-end
 * symlink-farm + clonefile + confinement behaviour is covered on a Mac by
 * scripts/scratch-sandbox-darwin-probe.mjs.
 */
import { describe, expect, it } from 'vitest';
import { buildMacScratchProfile } from '../src/adapters/backend/scratch-sandbox-darwin.js';

const join = (lines: string[]) => lines.join('\n');

describe('buildMacScratchProfile', () => {
  it('denies all writes then carves out the scratch trees', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/d/sandboxes/s/clone/home', '/d/sandboxes/s/tmp', '/d/sandboxes/s/outbox'],
    }));
    expect(p).toContain('(deny file-write*)');
    expect(p).toContain('(allow file-write* (subpath "/d/sandboxes/s/clone/home"))');
    expect(p).toContain('(allow file-write* (subpath "/d/sandboxes/s/tmp"))');
    expect(p).toContain('(allow file-write* (subpath "/d/sandboxes/s/outbox"))');
  });

  it('grants host-real cache/temp areas (Foundation ignores HOME/TMPDIR)', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/h'],
      hostWritable: ['/private/tmp', '/private/var/tmp', '/private/var/folders',
        '/Users/u/Library/Caches', '/Users/u/Library/Application Support', '/Users/u/Library/Logs'],
    }));
    expect(p).toContain('(allow file-write* (subpath "/private/tmp"))');
    expect(p).toContain('(allow file-write* (subpath "/Users/u/Library/Application Support"))');
  });

  it('emits real-host credential denies READ+write AFTER grants so they win (also via symlink farm)', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/d/clone/home'],
      hostWritable: ['/Users/u/Library/Caches'],
      realDenyPaths: ['/Users/u/.botmux/bots.json', 'relative-ignored', ''],
    }));
    expect(p).toContain('(deny file-read* (subpath "/Users/u/.botmux/bots.json"))');
    expect(p).toContain('(deny file-write* (subpath "/Users/u/.botmux/bots.json"))');
    expect(p).not.toContain('relative-ignored');
    // Deny must appear after the broad Caches allow (last-match semantics).
    const denyIdx = p.indexOf('(deny file-write* (subpath "/Users/u/.botmux/bots.json")');
    const cacheIdx = p.indexOf('(allow file-write* (subpath "/Users/u/Library/Caches")');
    expect(denyIdx).toBeGreaterThan(cacheIdx);
  });

  it('denies Claude MCP traffic cache after the broad Caches grant', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: [],
      hostWritable: ['/Users/u/Library/Caches'],
      realDenyPaths: ['/Users/u/Library/Caches/claude-cli-nodejs'],
    }));
    const specific = p.indexOf('(deny file-write* (subpath "/Users/u/Library/Caches/claude-cli-nodejs")');
    const broad = p.indexOf('(allow file-write* (subpath "/Users/u/Library/Caches")');
    expect(specific).toBeGreaterThan(broad);
  });

  it('denies networking when net=false', () => {
    expect(join(buildMacScratchProfile({ net: false, writable: [] }))).toContain('(deny network*)');
    expect(join(buildMacScratchProfile({ net: true, writable: [] }))).not.toContain('(deny network*)');
  });

  it('adds literal connect grants for the MCP gateway socket', () => {
    const p = join(buildMacScratchProfile({ net: true, writable: [], mcpSocket: '/d/mcp.sock' }));
    expect(p).toContain('(allow file-write* (literal "/d/mcp.sock"))');
    expect(p).toContain('(allow file-read* (literal "/d/mcp.sock"))');
  });

  it('escapes quotes/backslashes in paths', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/h/a"b'],
      realDenyPaths: ['/h/c\\d'],
    }));
    expect(p).toContain('(allow file-write* (subpath "/h/a\\"b"))');
    expect(p).toContain('(deny file-write* (subpath "/h/c\\\\d"))');
  });

  it('keeps the compatibility grants CLI + framework subprocesses need', () => {
    const p = join(buildMacScratchProfile({ net: true, writable: [] }));
    for (const g of ['(allow mach*)', '(allow ipc*)', '(allow process*)', '(allow iokit-open)']) {
      expect(p).toContain(g);
    }
  });
});
