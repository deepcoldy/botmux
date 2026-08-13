import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildRestartBootstrapRequiredText,
  readRestartFailureFrom,
  recordAndNotifyRestartBootstrapFailure,
} from '../src/cli/restart-failure-notification.js';

const T0 = Date.parse('2026-08-13T03:00:00.000Z');

describe('restart bootstrap failure notification', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'botmux-restart-failure-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('persists pending state before delivery and records a successful same-app DM', async () => {
    const observations: string[] = [];
    const result = await recordAndNotifyRestartBootstrapFailure({
      dataDir: dir,
      bots: [
        { larkAppId: 'cli_api_only', larkAppSecret: '', apiOnly: true },
        { larkAppId: 'cli_sender', larkAppSecret: 'secret', allowedUsers: ['owner@example.com'] },
      ],
      unsafeDaemonNames: ['botmux-b', 'botmux-a', 'botmux-a'],
      detail: 'old PM2 policy',
      restartIntent: {
        kind: 'update', oldVersion: '3.12.0', newVersion: '3.13.0', at: new Date(T0).toISOString(),
      },
      now: T0,
      resolveOwner: async bot => {
        observations.push(`resolve:${bot.larkAppId}`);
        return bot.larkAppId === 'cli_sender' ? 'ou_sender_scope_owner' : undefined;
      },
      sendText: async (target, text) => {
        const onDisk = readRestartFailureFrom(dir);
        observations.push(`send:${target.larkAppId}:${target.ownerOpenId}:${onDisk?.notification.status}`);
        expect(text).toContain('botmux restart --bootstrap-shutdown-protocol --yes');
        expect(text).toContain('v3.12.0 → v3.13.0');
        return 'om_notice';
      },
    });

    expect(observations).toEqual([
      'resolve:cli_sender',
      'send:cli_sender:ou_sender_scope_owner:pending',
    ]);
    expect(result.unsafeDaemonNames).toEqual(['botmux-a', 'botmux-b']);
    expect(result.notification).toMatchObject({
      status: 'sent',
      attempts: 1,
      larkAppId: 'cli_sender',
      ownerOpenId: 'ou_sender_scope_owner',
      messageId: 'om_notice',
    });
    expect(readRestartFailureFrom(dir)).toEqual(result);
  });

  it('never copies an owner resolved for one application into another', async () => {
    const resolvedApps: string[] = [];
    const sent: Array<{ larkAppId: string; ownerOpenId: string }> = [];
    const result = await recordAndNotifyRestartBootstrapFailure({
      dataDir: dir,
      bots: [
        { larkAppId: 'cli_first', larkAppSecret: 'one', allowedUsers: ['on_stable'] },
        { larkAppId: 'cli_second', larkAppSecret: 'two', allowedUsers: ['on_stable'] },
      ],
      unsafeDaemonNames: ['botmux-local'],
      detail: 'old PM2 policy',
      now: T0,
      resolveOwner: async bot => {
        resolvedApps.push(bot.larkAppId);
        return bot.larkAppId === 'cli_second' ? 'ou_second_app_owner' : undefined;
      },
      sendText: async (target) => {
        sent.push(target);
        return 'om_second';
      },
    });

    expect(resolvedApps).toEqual(['cli_first', 'cli_second']);
    expect(sent).toEqual([{ larkAppId: 'cli_second', ownerOpenId: 'ou_second_app_owner' }]);
    expect(result.notification.status).toBe('sent');
  });

  it('keeps delivery failure durable and never marks it sent', async () => {
    const result = await recordAndNotifyRestartBootstrapFailure({
      dataDir: dir,
      bots: [{ larkAppId: 'cli_sender', larkAppSecret: 'secret', ownerOpenId: 'ou_owner' }],
      unsafeDaemonNames: ['botmux-local'],
      detail: 'old PM2 policy',
      now: T0,
      resolveOwner: async () => 'ou_owner',
      sendText: async () => { throw new Error('network down'); },
    });

    expect(result.notification).toMatchObject({
      status: 'failed',
      attempts: 1,
      larkAppId: 'cli_sender',
      ownerOpenId: 'ou_owner',
      error: 'network down',
    });
    expect(readRestartFailureFrom(dir)?.notification.status).toBe('failed');
  });

  it('records a diagnostic skip when no app can resolve an owner', async () => {
    const send = vi.fn();
    const result = await recordAndNotifyRestartBootstrapFailure({
      dataDir: dir,
      bots: [{ larkAppId: 'cli_sender', larkAppSecret: 'secret', allowedUsers: [] }],
      unsafeDaemonNames: [],
      detail: 'old PM2 policy',
      now: T0,
      resolveOwner: async () => undefined,
      sendText: send,
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.notification).toMatchObject({
      status: 'skipped',
      attempts: 0,
      error: 'no transport-enabled bot with a resolvable owner',
    });
  });

  it('formats the operator action without leaking credentials', () => {
    const text = buildRestartBootstrapRequiredText({
      schemaVersion: 1,
      failureId: 'f',
      code: 'bootstrap_shutdown_protocol_required',
      at: new Date(T0).toISOString(),
      operation: 'restart',
      detail: 'detail',
      unsafeDaemonNames: ['botmux-local'],
      notification: { status: 'pending', attempts: 0, updatedAt: new Date(T0).toISOString() },
    });
    expect(text).toContain('botmux restart --bootstrap-shutdown-protocol --yes');
    expect(text).toContain('botmux-local');
    expect(text).not.toContain('appSecret');
  });
});
