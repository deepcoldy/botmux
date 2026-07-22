import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchDeferredTopicSend } from '../src/cli/deferred-topic-send.js';
import {
  deferredTopicBindingPath,
  readDeferredTopicBinding,
} from '../src/core/deferred-topic-binding.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const TURN_ID = 'schedule:task-1:run-1';

describe('deferred fresh-topic botmux send routing', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'botmux-deferred-topic-'));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  function makeOptions(overrides: Record<string, unknown> = {}) {
    return {
      dataDir,
      session: {
        sessionId: SESSION_ID,
        chatId: 'oc_target',
        larkAppId: 'cli_app',
        deferredScheduleRun: {
          taskId: 'task-1',
          turnId: TURN_ID,
          routingAnchor: 'schedule-run:task-1:run-1',
          createdAt: '2026-07-21T00:00:00.000Z',
        },
      },
      currentTurnId: TURN_ID,
      explicitTopLevel: false,
      content: 'service is down',
      msgType: 'text',
      sendRoot: vi.fn(async () => 'om_alert_root'),
      sendTitleSeed: vi.fn(async () => 'om_title_root'),
      replyRoot: vi.fn(async () => 'om_alert_reply'),
      ...overrides,
    };
  }

  it('uses the first alert as the root and persists an idempotent binding', async () => {
    const opts = makeOptions();
    const result = await dispatchDeferredTopicSend(opts);

    expect(result).toEqual({
      handled: true,
      messageId: 'om_alert_root',
      rootMessageId: 'om_alert_root',
      materializedNow: true,
    });
    expect(opts.sendRoot).toHaveBeenCalledWith('service is down', 'text', SESSION_ID);
    expect(opts.sendTitleSeed).not.toHaveBeenCalled();
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)).toMatchObject({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      routingAnchor: 'schedule-run:task-1:run-1',
      rootMessageId: 'om_alert_root',
    });
  });

  it('uses a custom title as the root and posts the alert as its first reply', async () => {
    const opts = makeOptions({
      session: {
        ...makeOptions().session,
        deferredScheduleRun: {
          ...makeOptions().session.deferredScheduleRun,
          topicTitle: '发布巡检告警',
        },
      },
      uuid: 'alert-uuid',
    });
    const result = await dispatchDeferredTopicSend(opts);

    expect(opts.sendTitleSeed).toHaveBeenCalledWith('发布巡检告警', SESSION_ID);
    expect(opts.replyRoot).toHaveBeenCalledWith('om_title_root', 'service is down', 'text', 'alert-uuid');
    expect(result).toMatchObject({
      handled: true,
      messageId: 'om_alert_reply',
      rootMessageId: 'om_title_root',
      materializedNow: true,
    });
  });

  it('reuses the materialized topic for later turns while explicit top-level remains an escape hatch', async () => {
    await dispatchDeferredTopicSend(makeOptions());
    const followUp = makeOptions({ currentTurnId: 'human-turn-2', content: 'more detail' });
    const result = await dispatchDeferredTopicSend(followUp);

    expect(followUp.sendRoot).not.toHaveBeenCalled();
    expect(followUp.replyRoot).toHaveBeenCalledWith('om_alert_root', 'more detail', 'text', undefined);
    expect(result).toMatchObject({ handled: true, rootMessageId: 'om_alert_root', materializedNow: false });

    const topLevel = makeOptions({ currentTurnId: 'human-turn-3', explicitTopLevel: true });
    expect(await dispatchDeferredTopicSend(topLevel)).toEqual({ handled: false });
    expect(topLevel.replyRoot).not.toHaveBeenCalled();
  });

  it('fails a stale turn closed instead of leaking it to the group top level', async () => {
    const opts = makeOptions({ currentTurnId: 'schedule:task-1:stale-run' });
    await expect(dispatchDeferredTopicSend(opts)).rejects.toThrow('not materialized');
    expect(opts.sendRoot).not.toHaveBeenCalled();
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)).toBeUndefined();
  });

  it('rejects a sidecar whose run identity does not match the session', async () => {
    await dispatchDeferredTopicSend(makeOptions());
    const path = deferredTopicBindingPath(dataDir, SESSION_ID);
    const binding = readDeferredTopicBinding(dataDir, SESSION_ID)!;
    writeFileSync(path, JSON.stringify({ ...binding, chatId: 'oc_other' }));

    await expect(dispatchDeferredTopicSend(makeOptions({ currentTurnId: 'human-turn' })))
      .rejects.toThrow('identity mismatch');
  });

  it('serializes concurrent first sends so only one root is created', async () => {
    let releaseRoot!: () => void;
    let rootStarted!: () => void;
    const rootStartedPromise = new Promise<void>(resolve => { rootStarted = resolve; });
    const rootReleasePromise = new Promise<void>(resolve => { releaseRoot = resolve; });
    const sendRoot = vi.fn(async () => {
      rootStarted();
      await rootReleasePromise;
      return 'om_concurrent_root';
    });
    const replyRoot = vi.fn(async () => 'om_second_reply');
    const first = dispatchDeferredTopicSend(makeOptions({ sendRoot, replyRoot, content: 'first' }));
    await rootStartedPromise;
    const second = dispatchDeferredTopicSend(makeOptions({ sendRoot, replyRoot, content: 'second' }));
    releaseRoot();

    const [a, b] = await Promise.all([first, second]);
    expect(sendRoot).toHaveBeenCalledTimes(1);
    expect(replyRoot).toHaveBeenCalledTimes(1);
    expect(replyRoot).toHaveBeenCalledWith('om_concurrent_root', 'second', 'text', undefined);
    expect([a.materializedNow, b.materializedNow].sort()).toEqual([false, true]);
  });

  it('rejects malformed binding sidecars instead of routing to an arbitrary id', () => {
    const path = deferredTopicBindingPath(dataDir, SESSION_ID);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      chatId: 'oc_target',
      larkAppId: 'cli_app',
      routingAnchor: 'schedule-run:task-1:run-1',
      rootMessageId: 'not-a-message',
      createdAt: '2026-07-21T00:00:00.000Z',
    }));
    expect(readDeferredTopicBinding(dataDir, SESSION_ID)).toBeUndefined();
  });
});
