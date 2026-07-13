/**
 * Unit tests for structured-bridge allowlists + file path resolver.
 * Keeps the single-source helpers honest without pulling the worker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  isStructuredBridgeFallbackActive,
  isStructuredBridgeAdoptCli,
  isStructuredBridgeAdoptIdleCli,
  isStructuredBridgeAdoptInputCli,
  STRUCTURED_BRIDGE_ALWAYS_CLI_IDS,
  STRUCTURED_BRIDGE_ADOPT_CLI_IDS,
} from '../src/services/structured-bridge-clis.js';
import { resolveFileBridgePath } from '../src/services/file-bridge-path.js';

describe('structured-bridge-clis', () => {
  it('allowlists include grok; hermes stays out of the adopt-forward list', () => {
    expect(STRUCTURED_BRIDGE_ALWAYS_CLI_IDS).toContain('grok');
    expect(STRUCTURED_BRIDGE_ADOPT_CLI_IDS).toContain('grok');
    expect(STRUCTURED_BRIDGE_ADOPT_CLI_IDS).toContain('cursor');
    // hermes is bridge-ALWAYS but must NOT be adopt-forwarded: it has no
    // adopt transcript branch, and forwarding adoptCliPid would flip its
    // tmux adopt from pane-only to pid liveness (strict parity with the
    // historical worker-pool allowlist — see structured-bridge-clis.ts).
    expect(STRUCTURED_BRIDGE_ALWAYS_CLI_IDS).toContain('hermes');
    expect(STRUCTURED_BRIDGE_ADOPT_CLI_IDS).not.toContain('hermes');
    expect(isStructuredBridgeAdoptCli('hermes')).toBe(false);
    for (const id of STRUCTURED_BRIDGE_ALWAYS_CLI_IDS) {
      if (id === 'hermes') continue;
      expect(STRUCTURED_BRIDGE_ADOPT_CLI_IDS).toContain(id);
    }
  });

  it('fallback treats cursor as adopt-only', () => {
    expect(isStructuredBridgeFallbackActive('cursor')).toBe(false);
    expect(isStructuredBridgeFallbackActive('cursor', true)).toBe(true);
    expect(isStructuredBridgeFallbackActive('grok')).toBe(true);
    expect(isStructuredBridgeFallbackActive('hermes')).toBe(true);
  });

  it('adopt idle/input allowlists match historical worker behaviour', () => {
    expect(isStructuredBridgeAdoptIdleCli('coco')).toBe(true);
    expect(isStructuredBridgeAdoptIdleCli('cursor')).toBe(false);
    expect(isStructuredBridgeAdoptInputCli('mtr')).toBe(true);
    expect(isStructuredBridgeAdoptInputCli('coco')).toBe(false);
    expect(isStructuredBridgeAdoptCli('cursor')).toBe(true);
  });
});

describe('resolveFileBridgePath (grok)', () => {
  const ROOT = join(tmpdir(), `botmux-fbp-${process.pid}`);

  beforeEach(() => {
    process.env.GROK_HOME = ROOT;
    rmSync(ROOT, { recursive: true, force: true });
    mkdirSync(ROOT, { recursive: true });
  });
  afterEach(() => {
    rmSync(ROOT, { recursive: true, force: true });
    delete process.env.GROK_HOME;
  });

  it('resolves grok updates.jsonl by session id + cwd', () => {
    const sid = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
    const cwd = '/tmp/proj';
    const dir = join(ROOT, 'sessions', encodeURIComponent(cwd), sid);
    mkdirSync(dir, { recursive: true });
    const updates = join(dir, 'updates.jsonl');
    writeFileSync(updates, '');
    expect(resolveFileBridgePath('grok', { sessionId: sid, cwd })).toBe(updates);
    expect(resolveFileBridgePath('grok', { sessionId: sid })).toBe(updates); // walk
    expect(resolveFileBridgePath('grok', { sessionId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee', cwd })).toBeUndefined();
  });
});
