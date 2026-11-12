import { afterEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleSessionChatTool, type SessionChatContext, type SessionChatDeps } from '../src/core/session-chat-tools.js';
import { RiffHostTools, type RiffHostBinding, type RiffHostRequest } from '../src/services/riff-host-tools.js';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  let current = true;
  const permission = new Map([['oc_source', true], ['oc_target', true]]);
  const ctx: SessionChatContext = {
    sessionId: 'review-session', larkAppId: 'cli_review', chatId: 'oc_source', turnId: 'review-turn',
    callerOpenId: 'ou_caller', humanCaller: true, enabled: true, isCurrent: () => current,
  };
  const deps: SessionChatDeps = {
    route: {
      lookupMessageChatId: async () => null,
      getChatInfo: async () => ({ external: false, mode: 'group' }),
      isBotInChat: async () => true,
      listMemberOpenIds: async () => ['ou_caller', 'ou_qa'],
      canTalk: id => permission.get(id) === true,
    },
    canCreateChat: () => true,
    canTalkInNewChat: () => true,
    resolveMembers: async () => new Map([['qa@example.com', 'ou_qa']]),
    listMembers: vi.fn(async () => [{ openId: 'ou_qa', name: 'QA' }]),
    create: vi.fn(async () => ({ chatId: 'oc_created', invalidUserIds: [] })),
  };
  const create = { action: 'create', turnId: ctx.turnId, name: 'Review', members: ['qa@example.com'], chatMode: 'group' };
  const members = { action: 'members', turnId: ctx.turnId, chatId: 'oc_target' };
  return { ctx, deps, permission, create, members, revokeTurn: () => { current = false; } };
}

const delay = <T>(value: T, ms = 1000) => new Promise<T>(resolve => setTimeout(() => resolve(value), ms));

async function gatewayRequest(gateway: RiffHostTools, binding: RiffHostBinding, request: RiffHostRequest, method = 'POST') {
  const req = Readable.from(method === 'POST' ? [Buffer.from(JSON.stringify(request))] : []) as IncomingMessage;
  req.method = method;
  req.url = `${binding.url}?operationId=${request.operationId}`;
  req.headers = { 'x-riff-host-token': binding.token };
  req.setTimeout = () => req;
  let status = 0;
  let body: any;
  const res = {
    writeHead(code: number) { status = code; },
    end(data: string) { body = JSON.parse(data); },
  } as unknown as ServerResponse;
  await gateway.handle(req, res);
  return { status, body };
}

describe('session chat authorization and receipt recovery', () => {
  it('blocks a creation when permission is revoked during slow contact lookup', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.resolveMembers = () => delay(new Map([['qa@example.com', 'ou_qa']]));
    const result = handleSessionChatTool(f.create, f.ctx, f.deps);
    await vi.advanceTimersByTimeAsync(500);
    f.permission.set('oc_source', false);
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).status).toBe(403);
    expect(f.deps.create).not.toHaveBeenCalled();
  });

  it.each(['oc_source', 'oc_target'])('does not disclose members when %s permission is revoked during listing', async chatId => {
    const f = fixture();
    const listingStarted = Promise.withResolvers<void>();
    const finishListing = Promise.withResolvers<void>();
    f.deps.listMembers = vi.fn(async () => {
      listingStarted.resolve();
      await finishListing.promise;
      return [{ openId: 'ou_qa', name: 'QA' }];
    });
    const result = handleSessionChatTool(f.members, f.ctx, f.deps);
    // Gate on the provider call itself: advancing fake time does not guarantee
    // the preceding async authorization has settled on both test runners.
    await listingStarted.promise;
    expect(f.deps.listMembers).toHaveBeenCalledTimes(1);
    f.permission.set(chatId, false);
    finishListing.resolve();
    const returned = await result;
    expect(returned.status).toBe(403);
    expect(returned.body.error).toBe('principal_not_authorized');
    expect(returned.body).not.toHaveProperty('members');
  });

  it('does not start listing after source permission is revoked during destination authorization', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.route.getChatInfo = () => delay({ external: false, mode: 'group' as const });
    const result = handleSessionChatTool(f.members, f.ctx, f.deps);
    await vi.advanceTimersByTimeAsync(500);
    f.permission.set('oc_source', false);
    await vi.advanceTimersByTimeAsync(500);
    expect((await result).status).toBe(403);
    expect(f.deps.listMembers).not.toHaveBeenCalled();
  });

  it('discards member data when the turn is cancelled during listing', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.deps.listMembers = vi.fn(() => delay([{ openId: 'ou_qa', name: 'QA' }]));
    const result = handleSessionChatTool(f.members, f.ctx, f.deps);
    await vi.advanceTimersByTimeAsync(500);
    f.revokeTurn();
    await vi.advanceTimersByTimeAsync(500);
    expect(await result).toEqual({ status: 409, body: { ok: false, error: 'turn_changed' } });
  });

  it('treats a provider success without a usable chat id as an unknown creation outcome', async () => {
    const f = fixture();
    f.deps.create = vi.fn(async () => ({ chatId: '', invalidUserIds: [] }));
    await expect(handleSessionChatTool(f.create, f.ctx, f.deps)).rejects.toThrow('chat_creation_outcome_unknown');
    expect(f.deps.create).toHaveBeenCalledTimes(1);
  });

  it('keeps one partial creation through concurrent POST, polling, rebinding and gateway restart', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const directory = mkdtempSync(join(tmpdir(), 'session-chat-review-'));
    roots.push(directory);
    f.deps.create = vi.fn(() => delay({ chatId: 'oc_created', invalidUserIds: ['ou_qa'] }));
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify((await handleSessionChatTool(f.create, f.ctx, f.deps)).body), stderr: '' }));
    const gateway = new RiffHostTools(execute);
    const context = { sessionId: f.ctx.sessionId, turnId: f.ctx.turnId!, dataDir: directory, env: {}, isCurrent: () => true };
    const binding = gateway.bind('http://review/api/riff-host-tools', context);
    const operation = { operationId: 'review-create-0001', argv: ['chat', 'create', '--name', 'Review'] };
    expect((await gatewayRequest(gateway, binding, operation)).body.state).toBe('running');
    await vi.advanceTimersByTimeAsync(0);
    expect((await gatewayRequest(gateway, binding, operation)).body.state).toBe('running');
    expect((await gatewayRequest(gateway, binding, operation, 'GET')).body.state).toBe('running');
    const rebound = gateway.bind(binding.url, context);
    expect((await gatewayRequest(gateway, rebound, operation)).body.state).toBe('running');
    await vi.advanceTimersByTimeAsync(1000);
    const completed = await gatewayRequest(gateway, rebound, operation, 'GET');
    expect(JSON.parse(completed.body.result.stdout)).toMatchObject({ ok: true, chatId: 'oc_created', complete: false, invalidUserIds: ['ou_qa'] });
    const restarted = new RiffHostTools(execute);
    const resumed = restarted.bind(binding.url, context);
    expect(await gatewayRequest(restarted, resumed, operation)).toEqual(completed);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.deps.create).toHaveBeenCalledTimes(1);
  });

  it('fails closed after a durable running receipt is left by a lost creation response', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const directory = mkdtempSync(join(tmpdir(), 'session-chat-review-'));
    roots.push(directory);
    f.deps.create = vi.fn(() => delay({ chatId: 'oc_created', invalidUserIds: [] }));
    const execute = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify((await handleSessionChatTool(f.create, f.ctx, f.deps)).body), stderr: '' }));
    const context = { sessionId: f.ctx.sessionId, turnId: f.ctx.turnId!, dataDir: directory, env: {}, isCurrent: () => true };
    const gateway = new RiffHostTools(execute);
    const binding = gateway.bind('http://review/api/riff-host-tools', context);
    const operation = { operationId: 'review-create-0002', argv: ['chat', 'create', '--name', 'Review'] };
    expect((await gatewayRequest(gateway, binding, operation)).body.state).toBe('running');
    const receiptPath = join(directory, 'sessions', context.sessionId, 'riff-host-operations', `${createHash('sha256').update(operation.operationId).digest('hex')}.json`);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8'))).not.toHaveProperty('result');
    const restarted = new RiffHostTools(execute);
    const resumed = restarted.bind(binding.url, context);
    expect(await gatewayRequest(restarted, resumed, operation)).toEqual({ status: 409, body: { error: 'riff_host_execution_unknown' } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.deps.create).toHaveBeenCalledTimes(1);
    expect((await gatewayRequest(restarted, resumed, operation)).body.state).toBe('completed');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
