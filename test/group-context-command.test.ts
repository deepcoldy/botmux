import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseGroupContextSlashCommand,
  runGroupContextSlashCommand,
} from '../src/core/group-context-command.js';
import { getGroupContextSettings } from '../src/services/group-context-settings-store.js';
import { recordGroupContextRecallStatus } from '../src/services/group-context-health.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(overrides: Record<string, unknown> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'botmux-group-context-command-'));
  roots.push(dataDir);
  const getChatMode = vi.fn<() => Promise<'group' | 'topic' | 'p2p' | 'unknown'>>(async () => 'group');
  const readRecallStatus = vi.fn(() => ({
    covered: true,
    reason: 'subscribed',
    updateSubmitted: false,
    checkedAt: 1_800_000_000_000,
    stale: false,
  }));
  return {
    dataDir,
    getChatMode,
    readRecallStatus,
    input: {
      content: '/context-sharing status',
      larkAppId: 'cli_owner_bot',
      chatId: 'oc_team_a',
      senderId: 'ou_owner',
      senderIsBot: false,
      resolvedAllowedUsers: ['ou_owner'],
      ...overrides,
    },
  };
}

describe('/context-sharing command', () => {
  it('accepts exactly on, off, or status', () => {
    expect(parseGroupContextSlashCommand('/context-sharing on')).toEqual({ ok: true, action: 'on' });
    expect(parseGroupContextSlashCommand('/context-sharing OFF')).toEqual({ ok: true, action: 'off' });
    expect(parseGroupContextSlashCommand('/context-sharing status')).toEqual({ ok: true, action: 'status' });
    expect(parseGroupContextSlashCommand('/context-sharing')).toEqual({ ok: false, error: 'usage' });
    expect(parseGroupContextSlashCommand('/context-sharing enable')).toEqual({ ok: false, error: 'usage' });
    expect(parseGroupContextSlashCommand('/context-sharing on now')).toEqual({
      ok: false,
      error: 'unexpected_arguments',
      detail: 'now',
    });
  });

  it('persists on/off and reports status without an active worker', async () => {
    const f = fixture();

    expect(await runGroupContextSlashCommand(
      { ...f.input, content: '/context-sharing status' },
      { dataDir: f.dataDir, getChatMode: f.getChatMode, readRecallStatus: f.readRecallStatus },
    )).toMatchObject({
      kind: 'status',
      settings: { enabled: false },
      recall: { state: 'subscribed', stale: false },
    });

    expect(await runGroupContextSlashCommand(
      { ...f.input, content: '/context-sharing on' },
      { dataDir: f.dataDir, getChatMode: f.getChatMode, readRecallStatus: f.readRecallStatus },
    )).toMatchObject({
      kind: 'updated', enabled: true, changed: true,
      recall: { state: 'subscribed', stale: false },
    });
    expect(getGroupContextSettings('cli_peer_bot', 'oc_team_a', f.dataDir).enabled).toBe(true);

    expect(await runGroupContextSlashCommand(
      { ...f.input, content: '/context-sharing off' },
      { dataDir: f.dataDir, getChatMode: f.getChatMode, readRecallStatus: f.readRecallStatus },
    )).toMatchObject({ kind: 'updated', enabled: false, changed: true });
    expect(getGroupContextSettings('cli_owner_bot', 'oc_team_a', f.dataDir).enabled).toBe(false);
    expect(f.readRecallStatus).toHaveBeenCalledTimes(2);
  });

  it('normalizes recall diagnostics without exposing unbounded service reasons', async () => {
    const cases = [
      [{ covered: false, reason: 'update_submitted', updateSubmitted: true, checkedAt: 1, stale: false }, 'update_submitted'],
      [{ covered: false, reason: 'session_unavailable', updateSubmitted: false, checkedAt: 1, stale: true }, 'session_unavailable'],
      [{ covered: false, reason: 'subscribed', updateSubmitted: false, checkedAt: 1, stale: true }, 'unknown'],
      [{ covered: true, reason: 'x'.repeat(10_000), updateSubmitted: false, checkedAt: 1, stale: false }, 'unknown'],
    ] as const;

    for (const [health, state] of cases) {
      const f = fixture();
      f.readRecallStatus.mockReturnValue(health);
      const result = await runGroupContextSlashCommand(
        { ...f.input, content: '/context-sharing status' },
        { dataDir: f.dataDir, getChatMode: f.getChatMode, readRecallStatus: f.readRecallStatus },
      );
      expect(result).toMatchObject({ kind: 'status', recall: { state, stale: health.stale } });
      expect(JSON.stringify(result).length).toBeLessThan(1_000);
    }
  });

  it('reads persisted recall health through the production service by default', async () => {
    const f = fixture();
    recordGroupContextRecallStatus('cli_owner_bot', {
      covered: true,
      reason: 'subscribed',
      updateSubmitted: false,
    }, f.dataDir);

    expect(await runGroupContextSlashCommand(
      { ...f.input, content: '/context-sharing status' },
      { dataDir: f.dataDir, getChatMode: f.getChatMode },
    )).toMatchObject({ recall: { state: 'subscribed', stale: false } });
  });

  it('does not read recall health while disabling, including an already-disabled group', async () => {
    const f = fixture();
    const result = await runGroupContextSlashCommand(
      { ...f.input, content: '/context-sharing off' },
      { dataDir: f.dataDir, getChatMode: f.getChatMode, readRecallStatus: f.readRecallStatus },
    );
    expect(result).toMatchObject({ kind: 'updated', enabled: false, changed: false });
    expect(f.readRecallStatus).not.toHaveBeenCalled();
  });

  it('keeps settings group-wide across managed apps but isolated between groups', async () => {
    const f = fixture();
    await runGroupContextSlashCommand(
      { ...f.input, content: '/context-sharing on' },
      { dataDir: f.dataDir, getChatMode: f.getChatMode },
    );

    expect(getGroupContextSettings('cli_peer_bot', 'oc_team_a', f.dataDir).enabled).toBe(true);
    expect(getGroupContextSettings('cli_owner_bot', 'oc_team_b', f.dataDir).enabled).toBe(false);
  });

  it('uses a strict resolvedAllowedUsers gate and never lets a bot mutate settings', async () => {
    for (const [overrides, expectedError] of [
      [{ resolvedAllowedUsers: [] }, 'no_owner'],
      [{ senderId: 'ou_talk_grant' }, 'not_admin'],
      [{ senderId: 'ou_owner', senderIsBot: true }, 'not_admin'],
    ]) {
      const f = fixture(overrides as Record<string, unknown>);
      const result = await runGroupContextSlashCommand(
        { ...f.input, content: '/context-sharing on' },
        { dataDir: f.dataDir, getChatMode: f.getChatMode },
      );
      expect(result).toMatchObject({
        kind: 'error',
        error: expectedError,
      });
      expect(getGroupContextSettings('cli_owner_bot', 'oc_team_a', f.dataDir).enabled).toBe(false);
    }
  });

  it('rejects DMs, virtual chat IDs, and an unverifiable chat without writing settings', async () => {
    const virtual = fixture({ chatId: 'api:virtual-session' });
    expect(await runGroupContextSlashCommand(
      { ...virtual.input, content: '/context-sharing on' },
      { dataDir: virtual.dataDir, getChatMode: virtual.getChatMode },
    )).toEqual({ kind: 'error', error: 'invalid_chat' });
    expect(virtual.getChatMode).not.toHaveBeenCalled();

    for (const mode of ['p2p', 'unknown'] as const) {
      const f = fixture();
      f.getChatMode.mockResolvedValue(mode);
      const result = await runGroupContextSlashCommand(
        { ...f.input, content: '/context-sharing on' },
        { dataDir: f.dataDir, getChatMode: f.getChatMode },
      );
      expect(result).toEqual({
        kind: 'error',
        error: mode === 'unknown' ? 'chat_lookup_failed' : 'group_required',
      });
      expect(getGroupContextSettings('cli_owner_bot', 'oc_team_a', f.dataDir).enabled).toBe(false);
    }
  });

  it('allows both regular and topic group chats', async () => {
    const f = fixture();
    f.getChatMode.mockResolvedValue('topic');
    expect(await runGroupContextSlashCommand(
      { ...f.input, content: '/context-sharing on' },
      { dataDir: f.dataDir, getChatMode: f.getChatMode },
    )).toMatchObject({ kind: 'updated', enabled: true });
  });
});
