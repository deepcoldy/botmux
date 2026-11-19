import { cmdPost } from '../src/cli/post-command.js';
import { __setLoopbackTransportForTests } from '../src/core/loopback-fetch.js';
import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { registerBot } from '../src/bot-registry.js';
import { fetchDaemonIpc } from '../src/core/daemon-ipc-auth.js';
import { setIpcAuthSecret, setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { resolveBotmuxDataDir } from '../src/core/data-dir.js';
import { HOST_POST_MAX_TEXT_BYTES, HOST_POST_PATH } from '../src/core/host-post-request.js';
import { GROUP_SEND_UUID_REUSE_MS } from '../src/services/request-bound-group-send.js';
import * as lark from '../src/im/lark/client.js';
import { larkApiError, LARK_CODE_CROSS_APP_OPEN_ID } from '../src/im/lark/lark-errors.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const APP = 'cli_post_test';
const CHAT = 'oc_post_test';
const ROOT = 'om_post_root';
const USER = 'ou_post_recipient';
const SECRET = 'test-host-post-secret';
const REQUEST_ID = 'build_12345';
const groupRequest = { requestId: REQUEST_ID, larkAppId: APP, chatId: CHAT, text: 'Build complete' };

let server: IpcServerHandle;
let transport: ReturnType<typeof mockTransport>;

function mockTransport() {
  return {
    isInChat: vi.spyOn(lark, 'isCurrentBotInChat').mockResolvedValue(true),
    lookupChat: vi.spyOn(lark, 'lookupMessageChatId').mockResolvedValue(CHAT),
    send: vi.spyOn(lark, 'sendMessage').mockResolvedValue('om_group_sent'),
    reply: vi.spyOn(lark, 'replyMessage').mockResolvedValue('om_topic_sent'),
    dm: vi.spyOn(lark, 'sendUserMessage').mockResolvedValue('om_dm_sent'),
  };
}

beforeEach(async () => {
  registerBot({ larkAppId: APP, larkAppSecret: 'test-secret', cliId: 'claude-code' });
  setLarkAppId(APP);
  setIpcAuthSecret(SECRET);
  transport = mockTransport();
  server = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
});

afterEach(async () => {
  await server?.close();
  setIpcAuthSecret(null);
  setLarkAppId('');
  vi.restoreAllMocks();
});

function post(body: unknown): Promise<Response> {
  return fetchDaemonIpc(server.port, HOST_POST_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, SECRET);
}

async function runCli(args: string[], input = '') {
  const env = { ...process.env };
  delete env.BOTMUX_SESSION_ID;
  delete env.BOTMUX_CHAT_ID;
  delete env.BOTMUX_LARK_APP_ID;
  const child = spawnTsScript('src/cli.ts', ['post', '--bot', APP, ...args], {
    env,
    stdio: 'pipe',
    signal: AbortSignal.timeout(10_000),
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
  child.stderr!.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  child.stdin!.end(input);
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

function publishDaemonDescriptor() {
  const configDir = join(homedir(), '.botmux');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, '.dashboard-secret'), SECRET, { mode: 0o600 });
  const registryDir = join(resolveBotmuxDataDir(), 'dashboard-daemons');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, `${APP}.json`), JSON.stringify({
    larkAppId: APP, ipcPort: server.port, lastHeartbeat: Date.now(),
  }));
  return configDir;
}

it('posts from a bare shell through signed daemon discovery to a group, topic, and DM', async () => {
  const configDir = publishDaemonDescriptor();
  const textFile = join(configDir, 'message.txt');
  const topicText = '第一行\n第二行\n';
  writeFileSync(textFile, topicText);

  const group = await runCli(['--request-id', REQUEST_ID, '--chat-id', CHAT, '--text', groupRequest.text]);
  expect(group).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(group.stdout)).toEqual({ ok: true, larkAppId: APP, chatId: CHAT, requestId: REQUEST_ID, replayed: false, messageId: 'om_group_sent' });
  expect(transport.send).toHaveBeenCalledExactlyOnceWith(APP, CHAT, groupRequest.text, 'text', expect.any(String), undefined, { suppressHook: true, beforeWrite: expect.any(Function) });

  const topic = await runCli(['--chat-id', CHAT, '--into', ROOT, '--text-file', textFile]);
  expect(topic).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(topic.stdout)).toEqual({
    ok: true, larkAppId: APP, chatId: CHAT, rootMessageId: ROOT, requestId: expect.any(String), replayed: false, messageId: 'om_topic_sent',
  });
  expect(transport.reply).toHaveBeenCalledExactlyOnceWith(APP, ROOT, topicText, 'text', true, expect.any(String), { chatId: CHAT }, { suppressHook: true, beforeWrite: expect.any(Function), onAttemptStart: expect.any(Function) });

  transport.isInChat.mockClear();
  const direct = await runCli(['--user-open-id', USER, '--text-file', '-'], 'Action needed\n');
  expect(direct).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(direct.stdout)).toEqual({ ok: true, larkAppId: APP, userOpenId: USER, requestId: expect.any(String), replayed: false, messageId: 'om_dm_sent' });
  expect(transport.dm).toHaveBeenCalledExactlyOnceWith(APP, USER, 'Action needed\n', 'text', expect.any(String), undefined, { beforeWrite: expect.any(Function) });
  expect(transport.isInChat).not.toHaveBeenCalled();
}, 30_000);

it('refuses unauthenticated requests, a mismatched bot, or an ambiguous or oversized destination payload', async () => {
  const unauthenticated = await fetch(`http://127.0.0.1:${server.port}${HOST_POST_PATH}`, {
    method: 'POST', body: JSON.stringify(groupRequest),
  });
  expect(unauthenticated.status).toBe(401);

  const mismatch = await post({ ...groupRequest, larkAppId: 'cli_other' });
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ error: 'bot_mismatch' });
  for (const invalid of [
    { ...groupRequest, userOpenId: USER },
    { ...groupRequest, extra: true },
    { ...groupRequest, requestId: 'bad' },
    { larkAppId: APP, requestId: REQUEST_ID, rootMessageId: ROOT, text: 'hello' },
    { ...groupRequest, rootMessageId: 'omt_not_a_root' },
    { ...groupRequest, text: '界'.repeat(HOST_POST_MAX_TEXT_BYTES / 2) },
  ]) {
    expect((await post(invalid)).status).toBe(400);
  }
  expect(transport.isInChat).not.toHaveBeenCalled();
  expect(transport.send).not.toHaveBeenCalled();
  expect(transport.reply).not.toHaveBeenCalled();
  expect(transport.dm).not.toHaveBeenCalled();
});

it('rejects a non-member or a topic from another chat without a fallback send', async () => {
  transport.isInChat.mockResolvedValueOnce(false);
  const nonMember = await post({ ...groupRequest, requestId: 'non_member' });
  expect(nonMember.status).toBe(403);
  expect(await nonMember.json()).toMatchObject({ error: 'bot_not_in_chat' });

  transport.lookupChat.mockResolvedValueOnce(null);
  const missing = await post({ ...groupRequest, rootMessageId: ROOT });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: 'topic_not_visible' });

  transport.lookupChat.mockResolvedValueOnce('oc_other');
  const mismatch = await post({ ...groupRequest, rootMessageId: ROOT });
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ error: 'topic_chat_mismatch' });
  expect(transport.send).not.toHaveBeenCalled();
  expect(transport.reply).not.toHaveBeenCalled();
});

it('surfaces a Feishu DM rejection without reporting delivery', async () => {
  transport.dm.mockRejectedValueOnce(larkApiError('send user message', { code: LARK_CODE_CROSS_APP_OPEN_ID }));
  const response = await post({ larkAppId: APP, requestId: REQUEST_ID, userOpenId: USER, text: 'Action needed' });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ ok: false, error: 'send_failed', retryable: false, requestId: REQUEST_ID, providerCode: LARK_CODE_CROSS_APP_OPEN_ID });
});

it('refuses a bot without Feishu transport before calling the provider', async () => {
  const larkAppId = 'cli_post_api_only';
  registerBot({ larkAppId, larkAppSecret: '', apiOnly: true, cliId: 'claude-code' });
  setLarkAppId(larkAppId);
  const response = await post({ ...groupRequest, larkAppId });
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ ok: false, error: 'lark_transport_disabled' });
  expect(transport.isInChat).not.toHaveBeenCalled();
  expect(transport.send).not.toHaveBeenCalled();
});

it('shares group receipts with the group API and scopes each topic and DM independently', async () => {
  const requestId = 'shared_event';
  const legacy = await fetchDaemonIpc(server.port, `/api/groups/${CHAT}/messages`, {
    method: 'POST', body: JSON.stringify({ requestId, content: groupRequest.text }),
  }, SECRET);
  expect(legacy.status).toBe(200);
  const group = await post({ ...groupRequest, requestId });
  expect(await group.json()).toMatchObject({ replayed: true, messageId: 'om_group_sent' });
  expect(transport.send).toHaveBeenCalledTimes(1);

  for (const target of [{ chatId: CHAT, rootMessageId: ROOT }, { chatId: CHAT, rootMessageId: 'om_second' }, { userOpenId: USER }]) {
    const request = { larkAppId: APP, requestId, text: 'alert', ...target };
    const receipts = await Promise.all([post(request), post(request)].map(async response => (await response).json()));
    expect(receipts.map(r => r.replayed).sort()).toEqual([false, true]);
    expect(receipts[0].messageId).toEqual(receipts[1].messageId);
    const conflict = await post({ ...request, text: 'changed' });
    expect(await conflict.json()).toMatchObject({ error: 'request_conflict' });
  }
  expect(transport.reply).toHaveBeenCalledTimes(2);
  expect(transport.dm).toHaveBeenCalledTimes(1);
  const uuids = [
    transport.send.mock.calls[0][4], ...transport.reply.mock.calls.map(args => args[5]), transport.dm.mock.calls[0][4],
  ];
  expect(new Set(uuids).size).toBe(4);
});

it('reuses the provider uuid after an ambiguous DM error', async () => {
  transport.dm.mockRejectedValueOnce(new Error('connection lost'));
  const request = { larkAppId: APP, userOpenId: USER, text: 'alert', requestId: 'network_loss' };
  const first = await post(request);
  expect(await first.json()).toMatchObject({ error: 'outcome_unknown', retryable: true, requestId: request.requestId });
  expect(await (await post(request)).json()).toMatchObject({ ok: true, replayed: true, messageId: 'om_dm_sent' });
  const uuid = transport.dm.mock.calls[0][4];
  expect(uuid).toEqual(expect.any(String));
  expect(transport.dm.mock.calls[1][4]).toBe(uuid);
});

it('returns the same recovery id on connection loss or a receipt for a different bot and detects old daemons', async () => {
  publishDaemonDescriptor();
  const args = ['--bot', APP, '--chat-id', CHAT, '--text', 'alert'];
  const stderr = vi.spyOn(console, 'error').mockImplementation(() => {});
  const transport = vi.fn()
    .mockRejectedValueOnce(new Error('socket closed'))
    .mockResolvedValueOnce(Response.json({ ok: true, requestId: REQUEST_ID, larkAppId: 'cli_other', chatId: CHAT, messageId: 'om_other' }))
    .mockResolvedValueOnce(Response.json({ error: 'not_found' }, { status: 404 }));
  const previous = __setLoopbackTransportForTests(transport);
  try {
    expect(await cmdPost(args)).toBe(1);
    const autoId = JSON.parse(String(transport.mock.calls[0][1].body)).requestId;
    expect(autoId).toEqual(expect.any(String));
    expect(JSON.parse(stderr.mock.lastCall![0])).toMatchObject({ error: 'outcome_unknown', retryable: true, requestId: autoId });
    const fixedId = [...args, '--request-id', REQUEST_ID];
    expect(await cmdPost(fixedId)).toBe(1);
    expect(JSON.parse(stderr.mock.lastCall![0])).toMatchObject({ error: 'outcome_unknown', requestId: REQUEST_ID });
    expect(await cmdPost(fixedId)).toBe(1);
    expect(JSON.parse(stderr.mock.lastCall![0])).toMatchObject({ error: 'daemon_post_unsupported', retryable: false });
    expect(await cmdPost([...fixedId, '--request-id', REQUEST_ID])).toBe(2);
    expect(transport).toHaveBeenCalledTimes(3);
  } finally {
    __setLoopbackTransportForTests(previous);
  }
});

it('serves a durable topic receipt even when the root is later withdrawn', async () => {
  const request = { ...groupRequest, requestId: 'withdrawn_topic', rootMessageId: ROOT };
  expect(await (await post(request)).json()).toMatchObject({ ok: true, replayed: false });
  transport.lookupChat.mockResolvedValue(null);
  expect(await (await post(request)).json()).toMatchObject({ replayed: true, messageId: 'om_topic_sent' });
  expect(transport.lookupChat).toHaveBeenCalledTimes(1);
  expect(transport.reply).toHaveBeenCalledTimes(1);
});

it('blocks a delayed provider retry after the UUID window on every transport', async () => {
  let clock = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  const writes: number[] = [];
  async function loseReceiptThenRetry(beforeWrite: () => unknown): Promise<string> {
    await beforeWrite();
    writes.push(clock);
    clock += GROUP_SEND_UUID_REUSE_MS + 1;
    await beforeWrite();
    writes.push(clock);
    return 'om_duplicate';
  }
  transport.send.mockImplementation((...args) => loseReceiptThenRetry(args[6]!.beforeWrite!));
  transport.reply.mockImplementation((...args) => loseReceiptThenRetry(args[7]!.beforeWrite!));
  transport.dm.mockImplementation((...args) => loseReceiptThenRetry(args[6]!.beforeWrite!));
  for (const target of [{ chatId: CHAT }, { chatId: CHAT, rootMessageId: ROOT }, { userOpenId: USER }]) {
    const request = { larkAppId: APP, text: 'alert', requestId: 'rate_limited', ...target };
    for (let i = 0; i < 2; i++) {
      const response = await post(request);
      expect(await response.json()).toMatchObject({ error: 'outcome_unknown', retryable: false });
    }
  }
  expect(writes).toHaveLength(3);
});
