import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadWorkerPoolFunction } from './helpers/worker-pool-function-harness.js';
import type { OutputDeliveryRecord, OutputReceipt } from '../src/services/output-delivery-journal.js';
import type { OutputDeliveryControl } from '../src/services/output-delivery-coordinator.js';

const provider = vi.hoisted(() => ({ tenant: vi.fn(), userToken: vi.fn(), tenantToken: vi.fn(), dataDir: '' }));
vi.mock('../src/bot-registry.js', () => ({
  formatLarkError: vi.fn(), getAllBots: () => [], loadBotConfigs: () => [],
  getBot: () => ({ config: { larkAppId: 'cli_doc_effect_test', larkAppSecret: 'test-secret', brand: 'feishu' } }),
  getBotClient: () => ({ request: provider.tenant, tokenManager: { getTenantAccessToken: provider.tenantToken } }),
}));
vi.mock('../src/utils/user-token.js', () => ({ resolveUserToken: provider.userToken }));
vi.mock('../src/config.js', () => ({ config: { session: { get dataDir() { return provider.dataDir; } } } }));
vi.mock('../src/services/doc-subs-store.js', async original => ({
  ...await original<Record<string, unknown>>(), getDocSubscription: () => undefined,
}));
vi.mock('../src/utils/logger.js', () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { replyToDocComment } from '../src/im/lark/doc-comment.js';
import { OutputDeliveryJournal } from '../src/services/output-delivery-journal.js';
import { OutputDeliveryCoordinator } from '../src/services/output-delivery-coordinator.js';
import { outputSnapshot } from '../src/services/universal-output-handoff.js';

const appId = 'cli_doc_effect_test';
const directories: string[] = [];
const journals: OutputDeliveryJournal[] = [];
beforeEach(() => {
  vi.useFakeTimers();
  provider.tenant.mockReset();
  provider.userToken.mockReset();
  provider.tenantToken.mockReset().mockResolvedValue('tenant-token');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const journal of journals.splice(0)) journal.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Execute the actual pool doc branch and the actual Drive identity/SDK helper.
 * Only host dependencies unrelated to doc delivery and the HTTP boundaries are
 * stubbed; effect checkpoints and output receipts use real SQLite. */
function pipeline() {
  const directory = mkdtempSync(join(tmpdir(), 'doc-output-provider-'));
  directories.push(directory);
  provider.dataDir = directory;
  const journal = new OutputDeliveryJournal(directory, appId);
  journals.push(journal);
  const output = { type: 'final_output' as const, sessionId: 'session_doc_effect', turnId: 'om_doc_effect', lastUuid: 'doc_effect_uuid', content: 'answer' };
  const target = { fileToken: 'DocFixtureToken1234567890', fileType: 'docx', commentId: 'comment-fixture', replyToOpenId: 'ou_commenter' };
  const record = journal.accept(outputSnapshot(appId, output), { kind: 'doc', context: target });
  const ds = { larkAppId: appId, chatId: `doc:${target.fileToken}`, session: { sessionId: output.sessionId, status: 'active' } };
  const deliver = loadWorkerPoolFunction<(...args: any[]) => void>('deliverFinalOutput', {
    sessionPromptInjection: () => 'default', isMeetingDrivenTurn: () => false,
    frozenReplyContextForTurn: () => ({ target: { mode: 'plain', chatId: ds.chatId } }),
    fallbackTurnId: (_ds: unknown, turnId: string) => turnId,
    requireCallbacks: () => ({ sessionReply: vi.fn() }), sessionCliId: () => 'claude-code',
    getBot: () => ({ config: {} }), readGroupContextAuthorOrigin: () => undefined, turnResultBinding: () => undefined,
    resolveDocCommentTarget: () => target, chunkCommentText: (content: string) => [content], replyToDocComment,
    consumeDocCommentTurn: vi.fn(), finalOutputDedupeKey: () => 'doc-dedupe',
    logger: { info: vi.fn(), debug: vi.fn(), error: vi.fn() }, FINAL_OUTPUT_RETRY_BACKOFF_MS: [0, 800, 2000],
  });
  const coordinator = new OutputDeliveryCoordinator(journal);
  let allowed = true;
  const deps = {
    owns: () => allowed, settled: vi.fn(), error: vi.fn(),
    process: async (_record: OutputDeliveryRecord, control: OutputDeliveryControl) => new Promise<OutputReceipt | undefined>(resolve => {
      deliver(ds, output, 'doc-test', 0, (ok: boolean) => resolve(ok ? { status: 'delivered' } : undefined),
        control.owns, undefined, undefined, undefined, undefined, undefined, control);
    }),
  };
  return { journal, record, run: () => coordinator.deliver(record, deps), cancel: () => { allowed = false; }, resume: () => { allowed = true; } };
}
function userResponse(status: number, body: unknown) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe('durable document output through the real provider helper', () => {
  it('stops user fallback during token refresh after cancellation and resumes the same output', async () => {
    const p = pipeline();
    provider.tenant.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve({ code: 1069303, msg: 'tenant denied' }), 10)));
    provider.userToken.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve('user-token'), 1000)));
    const fetch = vi.fn(async () => userResponse(200, { code: 0, data: { reply_id: 'reply-too-late' } }));
    vi.stubGlobal('fetch', fetch);
    const first = p.run();
    await vi.advanceTimersByTimeAsync(20);
    p.cancel();
    await vi.advanceTimersByTimeAsync(1010);
    await first;
    expect(fetch).not.toHaveBeenCalled();
    expect(p.journal.read(p.record.id)?.state).toBe('blocked');
    p.resume();
    provider.tenant.mockResolvedValue({ code: 0, data: { reply_id: 'reply-resumed' } });
    await vi.advanceTimersByTimeAsync(5001);
    const retry = p.run();
    await vi.advanceTimersByTimeAsync(1);
    await retry;
    expect(provider.tenant).toHaveBeenCalledTimes(2);
    expect(p.journal.read(p.record.id)?.state).toBe('settled');
  });

  it.each([400, 200])('retries after user HTTP %s / 99991679 explicitly rejects the request', async status => {
    const p = pipeline();
    provider.tenant.mockResolvedValue({ code: 1069303, msg: 'tenant denied' });
    provider.userToken.mockResolvedValue('user-token');
    const fetch = vi.fn(async () => userResponse(status, { code: 99991679, msg: 'scope missing' }));
    vi.stubGlobal('fetch', fetch);
    const first = p.run();
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(p.journal.read(p.record.id)?.state).toBe('blocked');
    provider.tenant.mockResolvedValue({ code: 0, data: { reply_id: 'reply-after-auth' } });
    await vi.advanceTimersByTimeAsync(5001);
    const retry = p.run();
    await vi.advanceTimersByTimeAsync(1);
    await retry;
    expect(provider.tenant).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledOnce();
    expect(p.journal.read(p.record.id)?.state).toBe('settled');
  });

  it('retains an unknown provider request without user fallback or a duplicate retry', async () => {
    const p = pipeline();
    provider.tenant.mockRejectedValue(new Error('connection reset after write'));
    provider.userToken.mockResolvedValue('user-token');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const first = p.run();
    await vi.advanceTimersByTimeAsync(1);
    await first;
    provider.tenant.mockResolvedValue({ code: 0, data: { reply_id: 'would-duplicate' } });
    await vi.advanceTimersByTimeAsync(5001);
    const retry = p.run();
    await vi.advanceTimersByTimeAsync(1);
    await retry;
    expect(provider.tenant).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(p.journal.read(p.record.id)?.state).toBe('blocked');
  });

  it('retries token acquisition failure before any provider write', async () => {
    const p = pipeline();
    provider.tenantToken.mockRejectedValueOnce(new Error('token unavailable'));
    provider.tenant.mockResolvedValue({ code: 0, data: { reply_id: 'reply-after-token' } });
    provider.userToken.mockResolvedValue('user-token');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const first = p.run();
    await vi.advanceTimersByTimeAsync(1);
    await first;
    expect(provider.tenant).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5001);
    const retry = p.run();
    await vi.advanceTimersByTimeAsync(1);
    await retry;
    expect(provider.tenant).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
    expect(p.journal.read(p.record.id)?.state).toBe('settled');
  });

  it('retains a real receipt returned after cancellation and skips its completed block on recovery', async () => {
    const p = pipeline();
    provider.tenant.mockResolvedValue({ code: 1069303, msg: 'tenant denied' });
    provider.userToken.mockResolvedValue('user-token');
    const fetch = vi.fn(() => new Promise(resolve => setTimeout(() => resolve(userResponse(200, { code: 0, data: { reply_id: 'actual-reply' } })), 1000)));
    vi.stubGlobal('fetch', fetch);
    const first = p.run();
    await vi.advanceTimersByTimeAsync(20);
    expect(fetch).toHaveBeenCalledOnce();
    p.cancel();
    await vi.advanceTimersByTimeAsync(1000);
    await first;
    expect(p.journal.read(p.record.id)?.state).toBe('blocked');
    p.resume();
    await vi.advanceTimersByTimeAsync(5001);
    const retry = p.run();
    await vi.advanceTimersByTimeAsync(1);
    await retry;
    expect(provider.tenant).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(p.journal.read(p.record.id)?.state).toBe('settled');
  });
});
