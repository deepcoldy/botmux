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
import * as lark from '../src/im/lark/client.js';
import { larkApiError, LARK_CODE_CROSS_APP_OPEN_ID } from '../src/im/lark/lark-errors.js';
import { spawnTsScript } from './helpers/ts-runner.js';

const APP = 'cli_post_test';
const CHAT = 'oc_post_test';
const ROOT = 'om_post_root';
const USER = 'ou_post_recipient';
const SECRET = 'test-host-post-secret';
const groupRequest = { larkAppId: APP, chatId: CHAT, text: 'Build complete' };

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

it('posts from a bare shell through signed daemon discovery to a group, topic, and DM', async () => {
  const configDir = join(homedir(), '.botmux');
  mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(configDir, '.dashboard-secret'), SECRET, { mode: 0o600 });
  const registryDir = join(resolveBotmuxDataDir(), 'dashboard-daemons');
  mkdirSync(registryDir, { recursive: true });
  writeFileSync(join(registryDir, `${APP}.json`), JSON.stringify({
    larkAppId: APP, ipcPort: server.port, lastHeartbeat: Date.now(),
  }));
  const textFile = join(configDir, 'message.txt');
  const topicText = '第一行\n第二行\n';
  writeFileSync(textFile, topicText);

  const group = await runCli(['--chat-id', CHAT, '--text', groupRequest.text]);
  expect(group).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(group.stdout)).toEqual({ ok: true, larkAppId: APP, chatId: CHAT, messageId: 'om_group_sent' });
  expect(transport.send).toHaveBeenCalledExactlyOnceWith(APP, CHAT, groupRequest.text);

  const topic = await runCli(['--chat-id', CHAT, '--into', ROOT, '--text-file', textFile]);
  expect(topic).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(topic.stdout)).toEqual({
    ok: true, larkAppId: APP, chatId: CHAT, rootMessageId: ROOT, messageId: 'om_topic_sent',
  });
  expect(transport.reply).toHaveBeenCalledExactlyOnceWith(APP, ROOT, topicText, 'text', true, undefined, { chatId: CHAT });

  transport.isInChat.mockClear();
  const direct = await runCli(['--user-open-id', USER, '--text-file', '-'], 'Action needed\n');
  expect(direct).toMatchObject({ code: 0, stderr: '' });
  expect(JSON.parse(direct.stdout)).toEqual({ ok: true, larkAppId: APP, userOpenId: USER, messageId: 'om_dm_sent' });
  expect(transport.dm).toHaveBeenCalledExactlyOnceWith(APP, USER, 'Action needed\n');
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
    { larkAppId: APP, rootMessageId: ROOT, text: 'hello' },
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
  const nonMember = await post(groupRequest);
  expect(nonMember.status).toBe(403);
  expect(await nonMember.json()).toMatchObject({ error: 'bot_not_in_chat' });

  transport.lookupChat.mockResolvedValueOnce('oc_other');
  const mismatch = await post({ ...groupRequest, rootMessageId: ROOT });
  expect(mismatch.status).toBe(409);
  expect(await mismatch.json()).toMatchObject({ error: 'topic_chat_mismatch' });
  expect(transport.send).not.toHaveBeenCalled();
  expect(transport.reply).not.toHaveBeenCalled();
});

it('surfaces a Feishu DM rejection without reporting delivery', async () => {
  transport.dm.mockRejectedValueOnce(larkApiError('send user message', { code: LARK_CODE_CROSS_APP_OPEN_ID }));
  const response = await post({ larkAppId: APP, userOpenId: USER, text: 'Action needed' });
  expect(response.status).toBe(502);
  expect(await response.json()).toEqual({ ok: false, error: 'lark_request_failed', providerCode: LARK_CODE_CROSS_APP_OPEN_ID });
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
