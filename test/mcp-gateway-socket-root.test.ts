import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  pinSessionMcpGatewaySocketRoot,
  sessionMcpGatewaySocketPath,
  sessionMcpGatewaySocketRoot,
  startSessionMcpGatewayHost,
} from '../src/core/plugins/mcp/host.js';

// spawnCli repoints the worker's TMPDIR at the per-session scratch tree
// (#1592). The Gateway socket must not follow it: that tree is deep enough to
// push g.sock past macOS's 104-byte sun_path limit (listen EINVAL). The worker
// pins the inherited root first, exactly as done here.
// The pinned root is an explicit short directory rather than the runner's
// tmpdir(), which may itself be a deep session scratch (tests run from a bot
// session shell) and would fail the length assertion for an unrelated reason.
// Skipped where /tmp is unavailable.
const shortRoot = existsSync('/tmp') ? mkdtempSync('/tmp/bmcp-root-') : undefined;

describe.skipIf(!shortRoot)('MCP Gateway socket root survives the session TMPDIR repoint', () => {
  const inheritedTmp = process.env.TMPDIR;
  if (shortRoot) pinSessionMcpGatewaySocketRoot(shortRoot);
  const cleanup: string[] = [];
  afterEach(() => {
    if (inheritedTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = inheritedTmp;
    for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true });
  });
  afterAll(() => { if (shortRoot) rmSync(shortRoot, { recursive: true, force: true }); });

  function repointTmpdirToSessionScratch(): string {
    const root = mkdtempSync(join(tmpdir(), 'bmcp-root-test-'));
    cleanup.push(root);
    const scratch = join(root, 'session-tmp', '72200e4b60660fe9', '6c255026-e993-495d-80ec-85d2c3c440dc');
    mkdirSync(scratch, { recursive: true });
    process.env.TMPDIR = scratch;
    return scratch;
  }

  it('keeps the socket under the root captured before TMPDIR moved', () => {
    const root = sessionMcpGatewaySocketRoot();
    const scratch = repointTmpdirToSessionScratch();
    const socketPath = sessionMcpGatewaySocketPath('6c255026-e993-495d-80ec-85d2c3c440dc', '/tmp/botmux-data');
    expect(socketPath.startsWith(`${root}/bmcp-`)).toBe(true);
    expect(socketPath.startsWith(scratch)).toBe(false);
  });

  it('binds after TMPDIR points at the session scratch tree', async () => {
    repointTmpdirToSessionScratch();
    const dataDir = mkdtempSync(join(sessionMcpGatewaySocketRoot(), 'bmcp-data-test-'));
    cleanup.push(dataDir);
    const host = await startSessionMcpGatewayHost({
      sessionId: `socket-root-${process.pid}`,
      dataDir,
      onError: () => {},
    });
    try {
      expect(Buffer.byteLength(host.socketPath)).toBeLessThan(104);
    } finally {
      await host.close();
    }
  });
});
