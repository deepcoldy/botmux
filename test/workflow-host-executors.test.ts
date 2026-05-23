import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EventLog, type EventDraft } from '../src/workflows/events/append.js';
import {
  executeSideEffect,
  type HostExecutorContext,
  type SideEffectingExecutor,
} from '../src/workflows/hostExecutors/index.js';
import { deriveIdempotencyKey } from '../src/workflows/events/idempotency.js';

// ─── Test fixtures ──────────────────────────────────────────────────────────

const RUN_ID = 'run-host-exec-01';
const SHA64 = 'a'.repeat(64);

let baseDir: string;
let log: EventLog;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), 'wf-host-exec-'));
  log = new EventLog(RUN_ID, baseDir);
});
afterEach(() => {
  rmSync(baseDir, { recursive: true, force: true });
});

function context(overrides: Partial<HostExecutorContext> = {}): HostExecutorContext {
  return {
    log,
    runId: RUN_ID,
    workflowId: 'wf-demo',
    revisionId: 'rev-001',
    nodeId: 'n1',
    activityId: 'a1',
    attemptId: 'at1',
    ...overrides,
  };
}

async function seedRun(): Promise<void> {
  // Replay needs runCreated as the first event.  Any test reading events
  // back must call this first; otherwise readAll is just the protocol
  // events and replay() will reject.
  await log.append({
    runId: RUN_ID,
    type: 'runCreated',
    actor: 'scheduler',
    payload: {
      workflowId: 'wf-demo',
      revisionId: 'rev-001',
      inputRef: { outputHash: `sha256:${SHA64}`, outputBytes: 1, outputSchemaVersion: 1 },
      initiator: 'tests',
    },
  } as EventDraft);
}

// ─── Mock executor: tracks invoke calls + can be configured to throw ────────

function makeMockExecutor(opts: {
  output?: unknown;
  externalRefs?: Record<string, unknown>;
  throws?: Error;
  classifier?: SideEffectingExecutor<any, any>['classifyError'];
} = {}): SideEffectingExecutor<{ x: string }, { y: string }> & {
  calls: Array<{ input: { x: string }; idempotencyKey: string }>;
} {
  const calls: Array<{ input: { x: string }; idempotencyKey: string }> = [];
  return {
    provider: 'mock-provider',
    idempotencyTtlMs: 60000,
    canonicalInput(input) {
      return { x: input.x };
    },
    async invoke(input, idempotencyKey) {
      calls.push({ input, idempotencyKey });
      if (opts.throws) throw opts.throws;
      return {
        output: (opts.output ?? { y: 'ok' }) as { y: string },
        externalRefs: opts.externalRefs ?? { mockId: 'mock-123' },
      };
    },
    classifyError: opts.classifier,
    calls,
  };
}

// ─── executeSideEffect — happy path ─────────────────────────────────────────

describe('executeSideEffect — happy path event sequence', () => {
  it('writes effectAttempted then activitySucceeded in order', async () => {
    await seedRun();
    const exec = makeMockExecutor();
    const result = await executeSideEffect(context(), { x: 'hi' }, exec);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toEqual({ y: 'ok' });
    expect(result.externalRefs).toEqual({ mockId: 'mock-123' });

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'effectAttempted',
      'activitySucceeded',
    ]);

    const effectAttempted = events[1] as any;
    const succeeded = events[2] as any;
    expect(effectAttempted.payload.activityId).toBe('a1');
    expect(effectAttempted.payload.attemptId).toBe('at1');
    expect(effectAttempted.payload.provider).toBe('mock-provider');
    expect(effectAttempted.payload.idempotencyTtlMs).toBe(60000);
    expect(succeeded.payload.activityId).toBe('a1');
    expect(succeeded.payload.attemptId).toBe('at1');
    expect(succeeded.payload.externalRefs).toEqual({ mockId: 'mock-123' });
  });

  it('forwards a deterministic idempotencyKey to executor.invoke', async () => {
    await seedRun();
    const exec = makeMockExecutor();
    await executeSideEffect(context(), { x: 'hi' }, exec);
    expect(exec.calls).toHaveLength(1);
    expect(exec.calls[0].idempotencyKey).toBe(
      deriveIdempotencyKey({
        workflowId: 'wf-demo',
        revisionId: 'rev-001',
        runId: RUN_ID,
        nodeId: 'n1',
        attemptId: 'at1',
      }),
    );
    expect(exec.calls[0].idempotencyKey.length).toBeLessThanOrEqual(50);
  });

  it('records canonical inputHash on effectAttempted', async () => {
    await seedRun();
    const exec = makeMockExecutor();
    await executeSideEffect(context(), { x: 'frozen-input' }, exec);
    const events = await log.readAll();
    const effectAttempted = events[1] as any;
    expect(effectAttempted.payload.inputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('activitySucceeded carries an outputRef with hash of externalRefs', async () => {
    await seedRun();
    const exec = makeMockExecutor({ externalRefs: { messageId: 'om_abc' } });
    await executeSideEffect(context(), { x: 'y' }, exec);
    const events = await log.readAll();
    const succeeded = events[2] as any;
    expect(succeeded.payload.outputRef.outputHash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(succeeded.payload.outputRef.contentType).toBe('application/json');
  });

  it('outputRef points at a JSON blob containing {output, externalRefs}', async () => {
    const { readFileSync } = await import('node:fs');
    await seedRun();
    const exec = makeMockExecutor({
      output: { y: 'detail' },
      externalRefs: { messageId: 'om_xyz' },
    });
    await executeSideEffect(context(), { x: 'y' }, exec);
    const events = await log.readAll();
    const succeeded = events[2] as any;
    const outputPath = succeeded.payload.outputRef.outputPath;
    expect(typeof outputPath).toBe('string');
    const blob = JSON.parse(readFileSync(outputPath, 'utf-8'));
    expect(blob).toEqual({
      output: { y: 'detail' },
      externalRefs: { messageId: 'om_xyz' },
    });
  });

  it('outputRef.outputBytes matches the actual blob size', async () => {
    const { statSync } = await import('node:fs');
    await seedRun();
    const exec = makeMockExecutor({ externalRefs: { id: 'abc' } });
    await executeSideEffect(context(), { x: 'y' }, exec);
    const events = await log.readAll();
    const succeeded = events[2] as any;
    expect(statSync(succeeded.payload.outputRef.outputPath).size).toBe(
      succeeded.payload.outputRef.outputBytes,
    );
  });
});

// ─── executeSideEffect — failure paths ──────────────────────────────────────

describe('executeSideEffect — failure paths', () => {
  it('writes activityFailed with classifier output', async () => {
    await seedRun();
    const exec = makeMockExecutor({
      throws: new Error('boom'),
      classifier: () => ({
        errorCode: 'NetworkError',
        errorClass: 'retryable',
        errorMessage: 'network down',
      }),
    });
    const result = await executeSideEffect(context(), { x: 'y' }, exec);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.errorCode).toBe('NetworkError');
    expect(result.error.errorClass).toBe('retryable');

    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'effectAttempted', // still written before invoke
      'activityFailed',
    ]);
    const failed = events[2] as any;
    expect(failed.payload.error.errorCode).toBe('NetworkError');
    expect(failed.payload.error.errorClass).toBe('retryable');
    expect(failed.payload.error.errorMessage).toBe('network down');
  });

  it('falls back to UnknownProviderError/manual when no classifier', async () => {
    await seedRun();
    const exec = makeMockExecutor({ throws: new Error('huh?') });
    const result = await executeSideEffect(context(), { x: 'y' }, exec);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.errorCode).toBe('UnknownProviderError');
    expect(result.error.errorClass).toBe('manual');
    expect(result.error.errorMessage).toBe('huh?');
  });

  it('falls back to UnknownProviderError/manual when classifier returns null', async () => {
    await seedRun();
    const exec = makeMockExecutor({
      throws: new Error('weird'),
      classifier: () => null,
    });
    const result = await executeSideEffect(context(), { x: 'y' }, exec);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.errorCode).toBe('UnknownProviderError');
    expect(result.error.errorClass).toBe('manual');
  });

  it('truncates long error messages to fit the envelope payload cap', async () => {
    // Truncation budget is 2048 chars — schema allows 4096 but envelope
    // payload cap is also 4096 bytes, so we leave headroom for the rest
    // of the JSON envelope (activityId/attemptId/errorCode/etc).
    await seedRun();
    const longMsg = 'x'.repeat(5000);
    const exec = makeMockExecutor({ throws: new Error(longMsg) });
    const result = await executeSideEffect(context(), { x: 'y' }, exec);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.errorMessage.length).toBeLessThanOrEqual(2048);
    expect(result.error.errorMessage.endsWith('...')).toBe(true);
  });

  it('truncates classifier-returned long messages too', async () => {
    await seedRun();
    const longMsg = 'y'.repeat(5000);
    const exec = makeMockExecutor({
      throws: new Error('boom'),
      classifier: () => ({
        errorCode: 'NetworkError',
        errorClass: 'retryable',
        errorMessage: longMsg,
      }),
    });
    const result = await executeSideEffect(context(), { x: 'y' }, exec);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.errorMessage.length).toBeLessThanOrEqual(2048);
  });

  it('rejects non-plain-JSON output (Date) via activityFailed instead of silent coerce', async () => {
    await seedRun();
    const exec: SideEffectingExecutor<{ x: string }, any> = {
      provider: 'mock-provider',
      idempotencyTtlMs: 60000,
      canonicalInput(input) {
        return { x: input.x };
      },
      async invoke() {
        return {
          output: { when: new Date('2026-05-19T00:00:00Z') },
          externalRefs: { mockId: 'm1' },
        };
      },
    };
    const result = await executeSideEffect(context(), { x: 'y' }, exec);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.errorCode).toBe('UnknownProviderError');
    expect(result.error.errorClass).toBe('manual');
    expect(result.error.errorMessage).toMatch(/JSON-serializable.*Date/);
    const events = await log.readAll();
    expect(events.map((e) => e.type)).toEqual([
      'runCreated',
      'effectAttempted',
      'activityFailed',
    ]);
  });

  it('rejects non-plain-JSON externalRefs (Map) the same way', async () => {
    await seedRun();
    const exec: SideEffectingExecutor<{ x: string }, any> = {
      provider: 'mock-provider',
      idempotencyTtlMs: 60000,
      canonicalInput(input) {
        return { x: input.x };
      },
      async invoke() {
        return {
          output: { ok: true },
          externalRefs: { tags: new Map([['k', 'v']]) } as any,
        };
      },
    };
    const result = await executeSideEffect(context(), { x: 'y' }, exec);
    if (result.ok) throw new Error('expected failure');
    expect(result.error.errorMessage).toMatch(/JSON-serializable.*Map/);
  });
});

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
    const { computeInputHash } = await import('../src/workflows/events/idempotency.js');
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
    await botmuxScheduleExecutor.invoke(
      {
        name: 'Lookup',
        schedule: '0 9 * * *',
        parsed: { kind: 'cron', expr: '0 9 * * *', display: '0 9 * * *' },
        prompt: 'do',
        workingDir: '/wd',
        chatId: 'oc_x',
      },
      idemKey,
    );

    await expect(botmuxScheduleReconciler.readOnlyLookup!(idemKey, undefined)).resolves.toMatchObject({
      found: true,
      externalRefs: { taskId: idemKey },
      evidence: { source: 'getTask', externalRefs: { taskId: idemKey } },
    });
    await expect(botmuxScheduleReconciler.readOnlyLookup!('missing', undefined)).resolves.toMatchObject({
      found: false,
      evidence: { source: 'getTask', returned: 'undefined' },
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
