import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ─── feishu-send + feishu-reply: canonicalInput shape ──────────────────────

describe('feishuSendExecutor.canonicalInput', () => {
  afterEach(() => {
    vi.doUnmock('../src/im/lark/client.js');
    vi.resetModules();
  });

  it('covers receive_id + msg_type + content + larkAppId (spike §1.5)', async () => {
    const { feishuSendExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    const canonical = feishuSendExecutor.canonicalInput({
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'hello',
    });
    expect(canonical).toEqual({
      receive_id: 'oc_y',
      receive_id_type: 'chat_id',
      msg_type: 'text',
      content: 'hello',
      larkAppId: 'cli_x',
    });
  });

  it('respects custom msgType', async () => {
    const { feishuSendExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    const canonical = feishuSendExecutor.canonicalInput({
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: '{"text":"hi"}',
      msgType: 'interactive',
    });
    expect((canonical as any).msg_type).toBe('interactive');
  });

  it('parseFeishuSendInput validates the workflow input shape', async () => {
    const { parseFeishuSendInput } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    expect(parseFeishuSendInput({
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'hello',
    })).toEqual({
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'hello',
    });
    expect(() => parseFeishuSendInput({ chatId: 'oc_y', content: 'hello' })).toThrow();
    expect(() => parseFeishuSendInput({
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      rootMessageId: 'om_parent',
      content: 'ambiguous',
    })).toThrow(/Unrecognized key/);
  });

  it('invoke forwards the runtime idempotencyKey to sendMessage uuid', async () => {
    vi.resetModules();
    const sendMessage = vi.fn(async () => 'om_sent_1');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));
    const { feishuSendExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );

    const result = await feishuSendExecutor.invoke(
      {
        larkAppId: 'cli_x',
        chatId: 'oc_y',
        content: 'hello',
      },
      'wf_idem_key',
    );

    expect(sendMessage).toHaveBeenCalledWith('cli_x', 'oc_y', 'hello', 'text', 'wf_idem_key');
    expect(result).toEqual({
      output: { messageId: 'om_sent_1' },
      externalRefs: { messageId: 'om_sent_1' },
    });
  });

  it('reconciler idempotentSubmit reuses the same Feishu uuid', async () => {
    vi.resetModules();
    const sendMessage = vi.fn(async () => 'om_replayed');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));
    const { feishuSendReconciler } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );

    const result = await feishuSendReconciler.idempotentSubmit!('wf_retry_key', {
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'hello',
      msgType: 'text',
    });

    expect(feishuSendReconciler.requiresEffectInput).toBe(true);
    expect(sendMessage).toHaveBeenCalledWith('cli_x', 'oc_y', 'hello', 'text', 'wf_retry_key');
    expect(result).toMatchObject({
      ok: true,
      externalRefs: { messageId: 'om_replayed' },
      evidence: { source: 'idempotentSubmit', externalRefs: { messageId: 'om_replayed' } },
    });
  });

  it('reconciler maps transient Feishu submit failures to retryable', async () => {
    vi.resetModules();
    const sendMessage = vi.fn(async () => {
      const err = Object.assign(new Error('rate limited'), { response: { status: 429 } });
      throw err;
    });
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));
    const { feishuSendReconciler } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );

    const result = await feishuSendReconciler.idempotentSubmit!('wf_retry_key', {
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      content: 'hello',
    });

    expect(result).toMatchObject({
      ok: false,
      errorCode: 'ProviderRateLimited',
      errorClass: 'retryable',
    });
  });
});

describe('default hostExecutor registry', () => {
  it('registers botmux-schedule and Feishu IM executors/reconcilers', async () => {
    const {
      createDefaultHostExecutorRegistry,
      createDefaultProviderReconcilers,
    } = await import('../src/workflows/hostExecutors/registry.js');

    expect(createDefaultHostExecutorRegistry().has('botmux-schedule')).toBe(true);
    expect(createDefaultHostExecutorRegistry().has('feishu-send')).toBe(true);
    expect(createDefaultHostExecutorRegistry().has('feishu-reply')).toBe(true);
    expect(createDefaultProviderReconcilers().has('botmux-schedule')).toBe(true);
    expect(createDefaultProviderReconcilers().has('feishu-im')).toBe(true);
  });
});

describe('feishuReplyExecutor.canonicalInput', () => {
  afterEach(() => {
    vi.doUnmock('../src/im/lark/client.js');
    vi.resetModules();
  });

  it('pins root_message_id (spike test 3c: parent ignored by Feishu uuid)', async () => {
    const { feishuReplyExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-reply.js'
    );
    const canonical = feishuReplyExecutor.canonicalInput({
      larkAppId: 'cli_x',
      rootMessageId: 'om_parent',
      content: 'reply',
    });
    expect(canonical).toEqual({
      root_message_id: 'om_parent',
      msg_type: 'text',
      content: 'reply',
      reply_in_thread: false,
      larkAppId: 'cli_x',
    });
  });

  it('different rootMessageId → different canonicalInput → different inputHash', async () => {
    const { feishuReplyExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-reply.js'
    );
    const { computeInputHash } = await import('../src/utils/canonical-input-hash.js');
    const a = computeInputHash(
      feishuReplyExecutor.canonicalInput({
        larkAppId: 'cli_x',
        rootMessageId: 'om_A',
        content: 'reply',
      }),
    );
    const b = computeInputHash(
      feishuReplyExecutor.canonicalInput({
        larkAppId: 'cli_x',
        rootMessageId: 'om_B',
        content: 'reply',
      }),
    );
    expect(a).not.toBe(b);
  });

  it('parseFeishuReplyInput validates the workflow input shape', async () => {
    const { parseFeishuReplyInput } = await import(
      '../src/workflows/hostExecutors/feishu-reply.js'
    );
    expect(parseFeishuReplyInput({
      larkAppId: 'cli_x',
      rootMessageId: 'om_parent',
      content: 'hello',
      replyInThread: true,
    })).toEqual({
      larkAppId: 'cli_x',
      rootMessageId: 'om_parent',
      content: 'hello',
      replyInThread: true,
    });
    expect(() => parseFeishuReplyInput({ larkAppId: 'cli_x', content: 'hello' })).toThrow();
    expect(() => parseFeishuReplyInput({
      larkAppId: 'cli_x',
      chatId: 'oc_y',
      rootMessageId: 'om_parent',
      content: 'ambiguous',
    })).toThrow(/Unrecognized key/);
  });

  it('invoke forwards the runtime idempotencyKey to replyMessage uuid', async () => {
    vi.resetModules();
    const replyMessage = vi.fn(async () => 'om_reply_1');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage: vi.fn(),
      replyMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));
    const { feishuReplyExecutor } = await import(
      '../src/workflows/hostExecutors/feishu-reply.js'
    );

    const result = await feishuReplyExecutor.invoke(
      {
        larkAppId: 'cli_x',
        rootMessageId: 'om_parent',
        content: 'reply',
        replyInThread: true,
      },
      'wf_reply_key',
    );

    expect(replyMessage).toHaveBeenCalledWith(
      'cli_x',
      'om_parent',
      'reply',
      'text',
      true,
      'wf_reply_key',
    );
    expect(result).toEqual({
      output: { messageId: 'om_reply_1' },
      externalRefs: { messageId: 'om_reply_1' },
    });
  });

  it('single feishu-im reconciler dispatches reply input by rootMessageId', async () => {
    vi.resetModules();
    const replyMessage = vi.fn(async () => 'om_replied');
    const sendMessage = vi.fn(async () => 'om_sent');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      replyMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));
    const { feishuImReconciler } = await import(
      '../src/workflows/hostExecutors/feishu-im.js'
    );

    const result = await feishuImReconciler.idempotentSubmit!('wf_same_uuid', {
      larkAppId: 'cli_x',
      rootMessageId: 'om_parent',
      content: 'reply',
      replyInThread: false,
    });

    expect(feishuImReconciler.provider).toBe('feishu-im');
    expect(feishuImReconciler.requiresEffectInput).toBe(true);
    expect(replyMessage).toHaveBeenCalledWith(
      'cli_x',
      'om_parent',
      'reply',
      'text',
      false,
      'wf_same_uuid',
    );
    expect(sendMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      externalRefs: { messageId: 'om_replied' },
      evidence: { source: 'idempotentSubmit', externalRefs: { messageId: 'om_replied' } },
    });
  });

  it('single feishu-im reconciler still dispatches send input by chatId', async () => {
    vi.resetModules();
    const replyMessage = vi.fn(async () => 'om_replied');
    const sendMessage = vi.fn(async () => 'om_sent');
    vi.doMock('../src/im/lark/client.js', () => ({
      sendMessage,
      replyMessage,
      MessageWithdrawnError: class MessageWithdrawnError extends Error {},
    }));
    const { feishuImReconciler } = await import(
      '../src/workflows/hostExecutors/feishu-im.js'
    );

    const result = await feishuImReconciler.idempotentSubmit!('wf_same_uuid', {
      larkAppId: 'cli_x',
      chatId: 'oc_chat',
      content: 'send',
    });

    expect(sendMessage).toHaveBeenCalledWith(
      'cli_x',
      'oc_chat',
      'send',
      'text',
      'wf_same_uuid',
    );
    expect(replyMessage).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      externalRefs: { messageId: 'om_sent' },
    });
  });
});

// ─── botmux-schedule: integration with schedule-store ──────────────────────

describe('botmuxScheduleExecutor invoke()', () => {
  // We can't easily mock schedule-store because it pulls a side-effecting
  // singleton tree (config, logger, dashboard events).  Use a freshImport
  // pattern like the other schedule tests and verify behaviour end-to-end.
  let tempDataDir: string;

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'wf-host-exec-sched-'));
  });
  afterEach(() => {
    rmSync(tempDataDir, { recursive: true, force: true });
  });

  it('creates a task with id=idempotencyKey, returns externalRefs.taskId', async () => {
    // We need to mock config + logger BEFORE importing botmux-schedule
    // because it transitively imports schedule-store.
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      config: {
        session: {
          get dataDir() {
            return tempDataDir;
          },
        },
      },
    }));
    vi.doMock('../src/utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const { botmuxScheduleExecutor } = await import(
      '../src/workflows/hostExecutors/botmux-schedule.js'
    );
    const { getTask } = await import('../src/services/schedule-store.js');

    const idemKey = 'wf_test_schedule_idem';
    const result = await botmuxScheduleExecutor.invoke(
      {
        name: 'Daily',
        schedule: '0 9 * * *',
        parsed: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
        prompt: 'do the thing',
        workingDir: '/wd',
        chatId: 'oc_x',
        chatType: 'group',
      },
      idemKey,
    );

    expect(result.output.taskId).toBe(idemKey);
    expect(result.externalRefs).toEqual({ taskId: idemKey });
    expect(getTask(idemKey)?.name).toBe('Daily');
  });

  it('re-invoke with same input idempotent (returns same taskId)', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      config: { session: { get dataDir() { return tempDataDir; } } },
    }));
    vi.doMock('../src/utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const { botmuxScheduleExecutor } = await import(
      '../src/workflows/hostExecutors/botmux-schedule.js'
    );

    const idemKey = 'wf_test_schedule_rerun';
    const input = {
      name: 'Daily',
      schedule: '0 9 * * *',
      parsed: { kind: 'cron' as const, expr: '0 9 * * *', display: '0 9 * * *' },
      prompt: 'do',
      workingDir: '/wd',
      chatId: 'oc_x',
      chatType: 'group' as const,
    };
    const a = await botmuxScheduleExecutor.invoke(input, idemKey);
    const b = await botmuxScheduleExecutor.invoke(input, idemKey);
    expect(b.output.taskId).toBe(a.output.taskId);
  });

  it('classifies IdempotencyConflictError as fatal/IdempotencyConflict', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      config: { session: { get dataDir() { return tempDataDir; } } },
    }));
    vi.doMock('../src/utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const { botmuxScheduleExecutor } = await import(
      '../src/workflows/hostExecutors/botmux-schedule.js'
    );
    const { IdempotencyConflictError } = await import(
      '../src/services/schedule-store.js'
    );
    const conflict = new IdempotencyConflictError({
      taskId: 't',
      existingInputHash: 'sha256:' + '1'.repeat(64),
      incomingInputHash: 'sha256:' + '2'.repeat(64),
    });
    const cls = botmuxScheduleExecutor.classifyError!(conflict);
    expect(cls?.errorCode).toBe('IdempotencyConflict');
    expect(cls?.errorClass).toBe('fatal');
  });

  it('reconciler readOnlyLookup returns task externalRefs by idempotency key', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      config: { session: { get dataDir() { return tempDataDir; } } },
    }));
    vi.doMock('../src/utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));

    const { botmuxScheduleExecutor, botmuxScheduleReconciler } = await import(
      '../src/workflows/hostExecutors/botmux-schedule.js'
    );
    const idemKey = 'wf_test_schedule_lookup';
    const input = {
      name: 'Lookup',
      schedule: '0 9 * * *',
      parsed: { kind: 'cron' as const, expr: '0 9 * * *', display: '0 9 * * *' },
      prompt: 'do',
      workingDir: '/wd',
      chatId: 'oc_x',
      chatType: 'group' as const,
    };
    await botmuxScheduleExecutor.invoke(input, idemKey);

    await expect(botmuxScheduleReconciler.readOnlyLookup!(idemKey, undefined)).resolves.toMatchObject({
      found: true,
      externalRefs: { taskId: idemKey },
      evidence: { source: 'getTask', externalRefs: { taskId: idemKey } },
    });
    await expect(botmuxScheduleReconciler.readOnlyLookup!('missing', undefined)).resolves.toMatchObject({
      found: false,
      evidence: { source: 'getTask', returned: 'undefined' },
    });
    await expect(botmuxScheduleReconciler.readOnlyLookup!(idemKey, input)).resolves.toMatchObject({
      found: true,
      externalRefs: { taskId: idemKey },
    });
    await expect(botmuxScheduleReconciler.readOnlyLookup!(idemKey, {
      ...input,
      prompt: 'different body',
    })).rejects.toThrow(/IdempotencyConflict/);
  });

  it('freezes relative time once, rejects non-runnable shapes, and detects stale approval', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', () => ({
      config: { session: { get dataDir() { return tempDataDir; } } },
    }));
    vi.doMock('../src/utils/logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }));
    const { botmuxScheduleExecutor, parseScheduleInput } = await import(
      '../src/workflows/hostExecutors/botmux-schedule.js'
    );
    const base = {
      name: 'Once',
      prompt: 'do',
      workingDir: '/wd',
      chatId: 'oc_x',
      chatType: 'group' as const,
    };
    const frozen = parseScheduleInput({ ...base, schedule: '30m' });
    expect(frozen.parsed.kind).toBe('once');
    const runAtMs = Date.parse(frozen.parsed.runAt!);
    expect(parseScheduleInput(frozen).parsed).toEqual(frozen.parsed);
    expect(botmuxScheduleExecutor.validateBeforeIntent!(frozen, runAtMs - 1)).toEqual({ ok: true });
    expect(botmuxScheduleExecutor.validateBeforeIntent!(frozen, runAtMs + 120_001)).toMatchObject({
      ok: false,
      errorCode: 'HOST_SCHEDULE_APPROVAL_STALE',
    });
    expect(() => parseScheduleInput({ ...base, schedule: 'every 0m' }))
      .toThrow(/positive integer/);
    expect(() => parseScheduleInput({ ...base, schedule: '每0分钟' }))
      .toThrow(/valid future occurrence/);
    const past = parseScheduleInput({ ...base, schedule: '2020-01-01T00:00:00Z' });
    expect(botmuxScheduleExecutor.validateBeforeIntent!(past, Date.now())).toMatchObject({
      ok: false,
      errorCode: 'HOST_SCHEDULE_APPROVAL_STALE',
    });
  });
});

// ─── feishuSendExecutor error classifier ────────────────────────────────────

describe('classifyFeishuError', () => {
  it('classifies MessageWithdrawnError as manual', async () => {
    const { classifyFeishuError } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    const { MessageWithdrawnError } = await import('../src/im/lark/client.js');
    const cls = classifyFeishuError(new MessageWithdrawnError('om_x'));
    expect(cls?.errorCode).toBe('UnknownProviderError');
    expect(cls?.errorClass).toBe('manual');
  });

  it('classifies HTTP 429 as ProviderRateLimited/retryable', async () => {
    const { classifyFeishuError } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    const err = Object.assign(new Error('rate limited'), {
      response: { status: 429 },
    });
    const cls = classifyFeishuError(err);
    expect(cls?.errorCode).toBe('ProviderRateLimited');
    expect(cls?.errorClass).toBe('retryable');
  });

  it('classifies ECONNREFUSED as NetworkError/retryable', async () => {
    const { classifyFeishuError } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    const cls = classifyFeishuError(new Error('connect ECONNREFUSED 127.0.0.1'));
    expect(cls?.errorCode).toBe('NetworkError');
    expect(cls?.errorClass).toBe('retryable');
  });

  it('returns null for unknown errors (falls back to protocol default)', async () => {
    const { classifyFeishuError } = await import(
      '../src/workflows/hostExecutors/feishu-send.js'
    );
    expect(classifyFeishuError(new Error('something else'))).toBeNull();
  });
});
