import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deliverWelcomeMessageOnce,
  planStartupWelcomeMessages,
  readWelcomeRecord,
  WELCOME_CLAIM_TTL_MS,
  WELCOME_SEND_BUDGET_MS,
  welcomeMessageUuid,
  welcomeSentMarkerPath,
  type WelcomeDeliveryResult,
  type WelcomeRecord,
} from '../src/services/welcome-message.js';
import { withFileLock } from '../src/utils/file-lock.js';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const APP = 'cli_welcome';
const OWNER = 'ou_owner123456';
const T0 = Date.parse('2026-11-01T08:00:00.000Z');

type SendFn = Parameters<typeof deliverWelcomeMessageOnce>[0]['send'];

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'botmux-welcome-'));
}

function clockAt(startMs: number) {
  let current = startMs;
  return {
    now: () => new Date(current),
    advance: (ms: number) => { current += ms; },
  };
}

function writeRecord(dataDir: string, larkAppId: string, record: WelcomeRecord): void {
  const file = welcomeSentMarkerPath(dataDir, larkAppId);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(record));
}

function claimBy(token: string, claimedAtMs: number): WelcomeRecord {
  return { status: 'sending', claimedAt: new Date(claimedAtMs).toISOString(), recipient: OWNER, token };
}

function heldSend() {
  let markStarted!: () => void;
  const started = new Promise<void>(resolve => { markStarted = resolve; });
  let finish!: (err?: Error) => void;
  const outcome = new Promise<void>((resolve, reject) => { finish = err => (err ? reject(err) : resolve()); });
  const send = vi.fn<SendFn>(() => { markStarted(); return outcome; });
  return { send, started, finish };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('deliverWelcomeMessageOnce', () => {
  it('sends the trimmed text once and records it; later starts do not resend', async () => {
    const dataDir = freshDir();
    const send = vi.fn<SendFn>(async () => undefined);
    const { now } = clockAt(T0);

    const first = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: ' 你好，回复 /init 开始 ', recipient: OWNER, send, now });
    expect(first).toEqual({ status: 'sent', recipient: OWNER, sentAt: new Date(T0).toISOString() });
    expect(send).toHaveBeenCalledWith(OWNER, '你好，回复 /init 开始', expect.objectContaining({ uuid: welcomeMessageUuid(APP) }));
    expect(readWelcomeRecord(dataDir, APP)).toEqual({ status: 'sent', sentAt: new Date(T0).toISOString(), recipient: OWNER });

    const second = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: '你好', recipient: OWNER, send });
    expect(second).toEqual({ status: 'already_sent', sentAt: new Date(T0).toISOString() });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when sending fails, so the next start retries without waiting', async () => {
    const dataDir = freshDir();
    const failing = vi.fn<SendFn>(async () => { throw new Error('network down'); });
    const failed = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send: failing });
    expect(failed).toEqual({ status: 'failed', recipient: OWNER, error: 'network down' });
    expect(readWelcomeRecord(dataDir, APP)).toMatchObject({ status: 'failed', error: 'network down' });

    const send = vi.fn<SendFn>(async () => undefined);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const retried = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, sleep });
    expect(retried.status).toBe('sent');
    expect(sleep).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips without recording when there is no message or no owner open_id', async () => {
    const dataDir = freshDir();
    const send = vi.fn<SendFn>(async () => undefined);
    expect(await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: undefined, recipient: OWNER, send }))
      .toEqual({ status: 'no_message' });
    expect(await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: '   ', recipient: OWNER, send }))
      .toEqual({ status: 'no_message' });
    expect(existsSync(dirname(welcomeSentMarkerPath(dataDir, APP)))).toBe(false);
    expect(await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: undefined, send }))
      .toEqual({ status: 'no_recipient' });
    expect(await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: 'on_union', send }))
      .toEqual({ status: 'no_recipient' });
    expect(send).not.toHaveBeenCalled();
    expect(readWelcomeRecord(dataDir, APP)).toBeUndefined();
  });

  it('keeps the record per bot and treats a corrupt record as unsent', async () => {
    const dataDir = freshDir();
    const send = vi.fn<SendFn>(async () => undefined);
    await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send });
    expect((await deliverWelcomeMessageOnce({ dataDir, larkAppId: 'cli_other', message: 'hi', recipient: OWNER, send })).status)
      .toBe('sent');

    const corruptApp = 'cli_corrupt';
    const marker = welcomeSentMarkerPath(dataDir, corruptApp);
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, '{oops');
    expect((await deliverWelcomeMessageOnce({ dataDir, larkAppId: corruptApp, message: 'hi', recipient: OWNER, send })).status)
      .toBe('sent');
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('lets only one of several concurrent starts in one process send', async () => {
    const dataDir = freshDir();
    const send = vi.fn<SendFn>(() => new Promise(resolve => setTimeout(resolve, 50)));
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, sleep: async () => undefined })));
    expect(results.filter(r => r.status === 'sent')).toHaveLength(1);
    expect(results.every(r => ['sent', 'claim_held', 'already_sent'].includes(r.status))).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('takes over a claim older than the TTL without waiting', async () => {
    const dataDir = freshDir();
    writeRecord(dataDir, APP, claimBy('crashed', T0 - WELCOME_CLAIM_TTL_MS - 1_000));
    const send = vi.fn<SendFn>(async () => undefined);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const result = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, sleep, now: clockAt(T0).now });
    expect(result.status).toBe('sent');
    expect(sleep).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps a claim stamped slightly ahead of this clock held instead of overwriting it', async () => {
    const dataDir = freshDir();
    const claimedAt = new Date(T0 + WELCOME_CLAIM_TTL_MS / 2).toISOString();
    const ahead = claimBy('live', Date.parse(claimedAt));
    writeRecord(dataDir, APP, ahead);
    const send = vi.fn<SendFn>(async () => undefined);
    const result = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, sleep: async () => undefined, now: clockAt(T0).now });
    expect(result).toEqual({ status: 'claim_held', claimedAt });
    expect(send).not.toHaveBeenCalled();
    expect(readWelcomeRecord(dataDir, APP)).toEqual(ahead);
  });

  it('takes over a claim stamped further ahead than the TTL without waiting', async () => {
    const dataDir = freshDir();
    writeRecord(dataDir, APP, claimBy('skewed', T0 + WELCOME_CLAIM_TTL_MS + 1_000));
    const send = vi.fn<SendFn>(async () => undefined);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const result = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, sleep, now: clockAt(T0).now });
    expect(result.status).toBe('sent');
    expect(sleep).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('waits out a fresh claim whose holder died, then takes it over in the same start', async () => {
    const dataDir = freshDir();
    const age = 1_000;
    writeRecord(dataDir, APP, claimBy('crashed', T0 - age));
    const clock = clockAt(T0);
    const sleep = vi.fn(async (ms: number) => { clock.advance(ms); });
    const send = vi.fn<SendFn>(async () => undefined);
    const result = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, sleep, now: clock.now });
    expect(result.status).toBe('sent');
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep.mock.calls[0][0] + age).toBeGreaterThanOrEqual(WELCOME_CLAIM_TTL_MS);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not send when the holder finishes while this start waits', async () => {
    const dataDir = freshDir();
    writeRecord(dataDir, APP, claimBy('live', T0));
    const sentAt = new Date(T0 + 500).toISOString();
    const sleep = vi.fn(async (_ms: number) => {
      writeRecord(dataDir, APP, { status: 'sent', sentAt, recipient: OWNER });
    });
    const send = vi.fn<SendFn>(async () => undefined);
    const result = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, sleep, now: clockAt(T0).now });
    expect(result).toEqual({ status: 'already_sent', sentAt });
    expect(send).not.toHaveBeenCalled();
  });

  it('gives up for this start when the claim stays held', async () => {
    const dataDir = freshDir();
    const held = claimBy('live', T0);
    writeRecord(dataDir, APP, held);
    const sleep = vi.fn(async (_ms: number) => undefined);
    const send = vi.fn<SendFn>(async () => undefined);
    const result = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, sleep, now: clockAt(T0).now });
    expect(result).toEqual({ status: 'claim_held', claimedAt: new Date(T0).toISOString() });
    expect(sleep).toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(readWelcomeRecord(dataDir, APP)).toEqual(held);
  });

  it('does not release a claim another start has taken over', async () => {
    const dataDir = freshDir();
    const taken = claimBy('taker', T0);
    const send = vi.fn<SendFn>(async () => {
      writeRecord(dataDir, APP, taken);
      throw new Error('timeout');
    });
    const result = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, now: clockAt(T0).now });
    expect(result.status).toBe('failed');
    expect(readWelcomeRecord(dataDir, APP)).toEqual(taken);
  });

  it('gives a takeover its own claim, so the stale holder failing late leaves it alone', async () => {
    const dataDir = freshDir();
    const stale = heldSend();
    const taker = heldSend();
    const staleStart = deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send: stale.send, now: clockAt(T0).now });
    await stale.started;

    const takeoverAt = T0 + WELCOME_CLAIM_TTL_MS + 1_000;
    const takerStart = deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send: taker.send, now: clockAt(takeoverAt).now });
    await taker.started;

    stale.finish(new Error('stalled holder gave up'));
    expect((await staleStart).status).toBe('failed');
    expect(readWelcomeRecord(dataDir, APP)).toMatchObject({ status: 'sending', claimedAt: new Date(takeoverAt).toISOString() });

    taker.finish();
    expect((await takerStart).status).toBe('sent');
    expect(readWelcomeRecord(dataDir, APP)?.status).toBe('sent');
  });

  it('abandons a send that exceeds the budget, aborts it and releases the claim', async () => {
    vi.useFakeTimers();
    const dataDir = freshDir();
    let signal: AbortSignal | undefined;
    const send = vi.fn<SendFn>((_openId, _text, request) => {
      signal = request.signal;
      return new Promise(() => undefined);
    });
    let settled: WelcomeDeliveryResult | undefined;
    const pending = deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, now: clockAt(T0).now })
      .then(result => { settled = result; return result; });

    await vi.advanceTimersByTimeAsync(WELCOME_SEND_BUDGET_MS - 1);
    expect(settled).toBeUndefined();
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;
    expect(result.status).toBe('failed');
    expect(signal?.aborted).toBe(true);
    expect(readWelcomeRecord(dataDir, APP)?.status).toBe('failed');
  });

  it('keeps the claim TTL longer than the send budget', () => {
    expect(WELCOME_CLAIM_TTL_MS).toBeGreaterThan(WELCOME_SEND_BUDGET_MS);
  });

  it('sends with a Feishu uuid derived from the app alone, so a resend after a crash is deduped', async () => {
    const uuid = welcomeMessageUuid(APP);
    expect(uuid.length).toBeLessThanOrEqual(50);
    expect(welcomeMessageUuid('cli_other')).not.toBe(uuid);
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const before = welcomeMessageUuid(APP);
    vi.setSystemTime(T0 + 2 * 60 * 60_000);
    expect(welcomeMessageUuid(APP)).toBe(before);
    vi.useRealTimers();

    const dataDir = freshDir();
    const send = vi.fn<SendFn>(async () => undefined);
    await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, now: clockAt(T0).now });
    unlinkSync(welcomeSentMarkerPath(dataDir, APP));
    await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send, now: clockAt(T0 + 60_000).now });
    expect(send.mock.calls.map(call => call[2].uuid)).toEqual([uuid, uuid]);
  });

  it('still reports the send when the record cannot be saved afterwards', async () => {
    const dataDir = freshDir();
    const marker = welcomeSentMarkerPath(dataDir, APP);
    const send = vi.fn<SendFn>(async () => { mkdirSync(`${marker}.tmp`); });
    const result = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send });
    expect(result).toMatchObject({ status: 'sent', recipient: OWNER, recordError: expect.any(String) });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not send when the delivery record location is unusable', async () => {
    const dataDir = freshDir();
    writeFileSync(join(dataDir, 'welcome-sent'), 'not a directory');
    const send = vi.fn<SendFn>(async () => undefined);
    for (let start = 0; start < 2; start++) {
      const result = await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send });
      expect(result.status).toBe('error');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps the record inside the data dir and readable only by the owner', async () => {
    const dataDir = freshDir();
    expect(dirname(welcomeSentMarkerPath(dataDir, '../../escape/x'))).toBe(join(dataDir, 'welcome-sent'));
    await deliverWelcomeMessageOnce({ dataDir, larkAppId: APP, message: 'hi', recipient: OWNER, send: async () => undefined });
    if (process.platform !== 'win32') {
      expect(statSync(welcomeSentMarkerPath(dataDir, APP)).mode & 0o777).toBe(0o600);
    }
  });
});

interface ChildRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runChild(source: string, env: Record<string, string>, onStdout?: (chunk: string) => void): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawnTsEvalWithRepoImports(source, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout!.on('data', data => { stdout += String(data); onStdout?.(stdout); });
    child.stderr!.on('data', data => { stderr += String(data); });
    child.once('error', reject);
    child.once('exit', code => resolve({ code, stdout, stderr }));
  });
}

function childResult(run: ChildRun): WelcomeDeliveryResult {
  expect(run.code, run.stderr).toBe(0);
  const line = run.stdout.split('\n').find(l => l.startsWith('WELCOME_RESULT '));
  expect(line, run.stdout).toBeDefined();
  return JSON.parse(line!.slice('WELCOME_RESULT '.length));
}

function sendCount(file: string): number {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
}

const CHILD_DELIVER = `
  const env = process.env;
  const result = await deliverWelcomeMessageOnce({
    dataDir: env.WELCOME_TEST_DIR,
    larkAppId: '${APP}',
    message: 'hi',
    recipient: '${OWNER}',
    send: async (_openId, _text, request) => {
      appendFileSync(env.WELCOME_TEST_SENDS, request.uuid + '\\n');
      await new Promise(resolve => setTimeout(resolve, 500));
    },
    sleep: async () => undefined,
  });
  console.log('WELCOME_RESULT ' + JSON.stringify(result));
`;

describe('deliverWelcomeMessageOnce across daemon processes', () => {
  it('lets only one of several concurrently starting processes send', async () => {
    const dataDir = freshDir();
    const sends = join(dataDir, 'sends.log');
    const startAt = String(Date.now() + 2_000);
    const runs = await Promise.all(Array.from({ length: 4 }, () => runChild(`
      import { appendFileSync } from 'node:fs';
      import { deliverWelcomeMessageOnce } from './src/services/welcome-message.js';
      while (Date.now() < Number(process.env.WELCOME_TEST_START_AT)) await new Promise(resolve => setTimeout(resolve, 5));
      ${CHILD_DELIVER}
    `, { WELCOME_TEST_DIR: dataDir, WELCOME_TEST_SENDS: sends, WELCOME_TEST_START_AT: startAt })));
    const results = runs.map(childResult);
    expect(results.filter(r => r.status === 'sent')).toHaveLength(1);
    expect(sendCount(sends)).toBe(1);
  }, 60_000);

  it('decides under the lock, so a delivery recorded while it waits is honored', async () => {
    const dataDir = freshDir();
    const sends = join(dataDir, 'sends.log');
    const marker = welcomeSentMarkerPath(dataDir, APP);
    mkdirSync(dirname(marker), { recursive: true });
    let run: Promise<ChildRun> | undefined;
    await withFileLock(marker, async () => {
      await new Promise<void>((ready, reject) => {
        run = runChild(`
          import { appendFileSync } from 'node:fs';
          import { deliverWelcomeMessageOnce } from './src/services/welcome-message.js';
          console.log('WELCOME_READY');
          await new Promise(resolve => setTimeout(resolve, 50));
          ${CHILD_DELIVER}
        `, { WELCOME_TEST_DIR: dataDir, WELCOME_TEST_SENDS: sends }, out => {
          if (out.includes('WELCOME_READY')) ready();
        });
        run.then(() => reject(new Error('child exited before it was ready')), reject);
      });
      await new Promise(resolve => setTimeout(resolve, 400));
      writeRecord(dataDir, APP, { status: 'sent', sentAt: new Date(T0).toISOString(), recipient: OWNER });
    });
    expect(childResult(await run!)).toEqual({ status: 'already_sent', sentAt: new Date(T0).toISOString() });
    expect(sendCount(sends)).toBe(0);
  }, 60_000);
});

describe('planStartupWelcomeMessages', () => {
  const bots = [
    { larkAppId: 'cli_a', welcomeMessage: '  回复 /init 开始  ' },
    { larkAppId: 'cli_none' },
    { larkAppId: 'cli_blank', welcomeMessage: '   ' },
    { larkAppId: 'cli_core', welcomeMessage: 'hi', apiOnly: true },
  ];
  const owners = {
    resolvedOwnerOpenId: (id: string) => (id === 'cli_a' ? 'ou_resolved' : undefined),
    configuredOwnerOpenId: () => 'ou_configured',
  };

  it('delivers in disabled and shadow mode, skipping bots without a message and core-only bots', () => {
    for (const coordinationMode of ['disabled', 'shadow'] as const) {
      expect(planStartupWelcomeMessages(bots, { coordinationMode, ...owners })).toEqual([
        { action: 'deliver', larkAppId: 'cli_a', message: '回复 /init 开始', recipient: 'ou_resolved' },
        { action: 'skip', larkAppId: 'cli_core', reason: 'api_only' },
      ]);
    }
  });

  it('skips in primary mode, where replicas do not share the delivery record', () => {
    expect(planStartupWelcomeMessages(bots, { coordinationMode: 'primary', ...owners })).toEqual([
      { action: 'skip', larkAppId: 'cli_a', reason: 'multi_replica' },
      { action: 'skip', larkAppId: 'cli_core', reason: 'api_only' },
    ]);
  });

  it('falls back to the configured owner when no allowed user resolved', () => {
    const plans = planStartupWelcomeMessages([{ larkAppId: 'cli_b', welcomeMessage: 'hi' }], { coordinationMode: 'disabled', ...owners });
    expect(plans).toEqual([{ action: 'deliver', larkAppId: 'cli_b', message: 'hi', recipient: 'ou_configured' }]);
  });
});
