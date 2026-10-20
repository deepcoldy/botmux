import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  groupContextRecallGap,
  readGroupContextRecallStatus,
  recordGroupContextRecallStatus,
  ensureGroupContextRecallHealth,
} from '../src/services/group-context-health.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dataDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'botmux-group-context-health-'));
  roots.push(root);
  return root;
}

describe('group context recall health', () => {
  it('coalesces subscription checks and caches verified configuration without model work', async () => {
    const dir = dataDir();
    const check = vi.fn(async () => ({ covered: true, reason: 'subscribed', updateSubmitted: false }));
    await Promise.all([ensureGroupContextRecallHealth('cli_app', check, dir), ensureGroupContextRecallHealth('cli_app', check, dir)]);
    await ensureGroupContextRecallHealth('cli_app', check, dir);
    expect(check).toHaveBeenCalledTimes(1);
    expect(readGroupContextRecallStatus('cli_app', dir).covered).toBe(true);
  });

  it('persists a check failure as an observable gap without rejecting the user turn', async () => {
    const dir = dataDir();
    await expect(ensureGroupContextRecallHealth('cli_app', async () => { throw new Error('platform unavailable'); }, dir)).resolves.toBeUndefined();
    expect(readGroupContextRecallStatus('cli_app', dir)).toMatchObject({ covered: false, reason: 'error' });
  });
  it('fails closed when no status has been recorded', () => {
    const dir = dataDir();
    expect(readGroupContextRecallStatus('cli_app', dir)).toEqual({
      covered: false,
      reason: 'unknown',
      updateSubmitted: false,
      checkedAt: 0,
      stale: true,
    });
    expect(groupContextRecallGap('cli_app', dir)).toBeDefined();
  });

  it('records only a confirmed existing subscription as covered', () => {
    const dir = dataDir();
    recordGroupContextRecallStatus('cli_app', {
      covered: true,
      reason: 'subscribed',
      updateSubmitted: false,
      detail: 'https://private.example/session',
    } as Parameters<typeof recordGroupContextRecallStatus>[1], dir);

    expect(readGroupContextRecallStatus('cli_app', dir)).toMatchObject({
      covered: true,
      reason: 'subscribed',
      updateSubmitted: false,
      stale: false,
    });
    expect(groupContextRecallGap('cli_app', dir)).toBeUndefined();
    const healthDir = join(dir, 'group-context-health');
    const files = readdirSync(healthDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    const path = join(healthDir, files[0]!);
    const raw = readFileSync(path, 'utf8');
    expect(raw).not.toContain('cli_app');
    expect(raw).not.toContain('private.example');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('treats a submitted update as pending publication and uncovered', () => {
    const dir = dataDir();
    recordGroupContextRecallStatus('cli_app', {
      covered: true,
      reason: 'update_submitted',
      updateSubmitted: true,
    }, dir);
    expect(readGroupContextRecallStatus('cli_app', dir)).toMatchObject({
      covered: false,
      reason: 'update_submitted',
      updateSubmitted: true,
      stale: false,
    });
    expect(groupContextRecallGap('cli_app', dir)).toContain('pending');
  });

  it('normalizes unknown reasons and unsafe app IDs without lossy filenames', () => {
    const dir = dataDir();
    recordGroupContextRecallStatus('../cli/app?x', {
      covered: true,
      reason: 'future_reason',
      updateSubmitted: false,
    }, dir);
    expect(readGroupContextRecallStatus('../cli/app?x', dir)).toMatchObject({
      covered: false,
      reason: 'unknown',
      updateSubmitted: false,
    });
    expect(readdirSync(join(dir, 'group-context-health'))[0]).toMatch(/^[a-f0-9]{64}\.json$/);
  });

  it('marks records older than 24 hours stale and uncovered', () => {
    const dir = dataDir();
    recordGroupContextRecallStatus('cli_app', {
      covered: true,
      reason: 'subscribed',
      updateSubmitted: false,
    }, dir);
    const path = join(dir, 'group-context-health', readdirSync(join(dir, 'group-context-health'))[0]!);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, JSON.stringify({ ...stored, checkedAt: Date.now() - 24 * 60 * 60 * 1000 - 1 }));

    expect(readGroupContextRecallStatus('cli_app', dir)).toMatchObject({
      covered: false,
      reason: 'subscribed',
      stale: true,
    });
    expect(groupContextRecallGap('cli_app', dir)).toContain('stale');
  });

  it('fails closed on malformed data and never throws from recording', () => {
    const dir = dataDir();
    recordGroupContextRecallStatus('cli_app', {
      covered: false,
      reason: 'error',
      updateSubmitted: false,
    }, dir);
    const path = join(dir, 'group-context-health', readdirSync(join(dir, 'group-context-health'))[0]!);
    writeFileSync(path, '{broken');
    expect(readGroupContextRecallStatus('cli_app', dir)).toMatchObject({ covered: false, reason: 'unknown', stale: true });

    const blocked = join(dir, 'not-a-directory');
    writeFileSync(blocked, 'x');
    expect(() => recordGroupContextRecallStatus('cli_app', {
      covered: true,
      reason: 'subscribed',
      updateSubmitted: false,
    }, blocked)).not.toThrow();
  });
});
