/**
 * Unit tests for the macOS scratch Seatbelt profile builder. Runs on Linux CI
 * (pure string builder — no sandbox-exec / Mac required). The end-to-end clone
 * + confinement behaviour is covered on a Mac by
 * scripts/scratch-sandbox-darwin-probe.mjs.
 */
import { describe, expect, it } from 'vitest';
import { buildMacScratchProfile } from '../src/adapters/backend/scratch-sandbox-darwin.js';

const join = (lines: string[]) => lines.join('\n');

describe('buildMacScratchProfile', () => {
  it('denies all writes then carves out exactly the clone/tmp/outbox trees', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/d/sandboxes/s/clone/home', '/d/sandboxes/s/tmp', '/d/sandboxes/s/outbox'],
    }));
    expect(p).toContain('(deny file-write*)');
    expect(p).toContain('(allow file-write* (subpath "/d/sandboxes/s/clone/home"))');
    expect(p).toContain('(allow file-write* (subpath "/d/sandboxes/s/tmp"))');
    expect(p).toContain('(allow file-write* (subpath "/d/sandboxes/s/outbox"))');
  });

  it('grants a project clone tree when supplied', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/h', '/d/sandboxes/s/clone/work'],
    }));
    expect(p).toContain('(allow file-write* (subpath "/d/sandboxes/s/clone/work"))');
  });

  it('denies reads AND writes for explicit deny paths', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/h'],
      denyPaths: ['/Users/u/.ssh', 'relative-ignored', ''],
    }));
    expect(p).toContain('(deny file-read* (subpath "/Users/u/.ssh"))');
    expect(p).toContain('(deny file-write* (subpath "/Users/u/.ssh"))');
    expect(p).not.toContain('relative-ignored');
  });

  it('denies networking when net=false, allows when net=true', () => {
    expect(join(buildMacScratchProfile({ net: false, writable: [] }))).toContain('(deny network*)');
    expect(join(buildMacScratchProfile({ net: true, writable: [] }))).not.toContain('(deny network*)');
  });

  it('adds literal connect grants for the MCP gateway socket', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: [],
      mcpSocket: '/d/mcp.sock',
    }));
    expect(p).toContain('(allow file-write* (literal "/d/mcp.sock"))');
    expect(p).toContain('(allow file-read* (literal "/d/mcp.sock"))');
  });

  it('escapes quotes/backslashes in paths', () => {
    const p = join(buildMacScratchProfile({
      net: true,
      writable: ['/h/a"b'],
      denyPaths: ['/h/c\\d'],
    }));
    expect(p).toContain('(allow file-write* (subpath "/h/a\\"b"))');
    expect(p).toContain('(deny file-write* (subpath "/h/c\\\\d"))');
  });

  it('keeps the compatibility grants CLI + framework subprocesses need', () => {
    const p = join(buildMacScratchProfile({ net: true, writable: [] }));
    for (const g of ['(allow mach*)', '(allow ipc*)', '(allow process*)', '(allow iokit-open)',
      '(allow file-write* (subpath "/private/var/folders"))']) {
      expect(p).toContain(g);
    }
  });
});
