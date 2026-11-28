import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { pairDraftWecomIdentity } from '../src/dashboard/wecom/draft-identity.js';
import { WecomTransport } from '../src/im/wecom/protocol/transport.js';
import { FileLockTimeoutError } from '../src/utils/file-lock.js';

class Socket extends EventEmitter {
  sent: Array<{ headers: { req_id: string } }> = [];
  terminated = false;
  send(data: string) { this.sent.push(JSON.parse(data)); }
  terminate() { this.terminated = true; this.emit('close'); }
  ack(code = 0) { this.emit('message', Buffer.from(JSON.stringify({ headers: this.sent[0].headers, errcode: code, errmsg: 'upstream-secret-must-not-leak' }))); }
  message(text: string, chatType = 'single', user = 'callback-user', extra = {}) {
    this.emit('message', Buffer.from(JSON.stringify({ cmd: 'aibot_msg_callback', headers: { req_id: 'callback' }, body: { msgid: randomUUID(), from: { userid: user }, chattype: chatType, chatid: 'chat', msgtype: 'text', text: { content: text }, ...extra } })));
  }
}
function fixture(botId = randomUUID()) {
  const socket = new Socket(), challenge = vi.fn();
  const options = { botId, secret: 'draft-secret', onChallenge: challenge, createTransport: (settings: ConstructorParameters<typeof WecomTransport>[0]) => new WecomTransport({ ...settings, socketFactory: () => socket as unknown as WebSocket }) };
  return { socket, challenge, options };
}
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const opened = async (f: ReturnType<typeof fixture>) => { await vi.waitFor(() => expect(f.socket.listenerCount('open')).toBe(1)); f.socket.emit('open'); };
afterEach(() => vi.useRealTimers());
/**
 * Attach a rejection handler now and assert after the triggering event. Bun's
 * `expect(promise).rejects` waits for the promise where it is called, so an
 * assertion created before the event would sit out the 120s pairing deadline.
 */
const settled = (promise: Promise<unknown>) => promise.then(() => undefined, () => undefined);

it('真实transport认证前不生成配对码；拒绝群聊、引用、旧job消息，只接受当前精确单聊文字', async () => {
  const f = fixture(), pending = pairDraftWecomIdentity(f.options);
  await opened(f); f.socket.message('old-job-challenge'); await flush(); expect(f.challenge).not.toHaveBeenCalled();
  f.socket.ack(); await vi.waitFor(() => expect(f.challenge).toHaveBeenCalledOnce());
  const challenge = f.challenge.mock.calls[0][0];
  expect(challenge).toMatch(/^BOTMUX-ID-[A-F0-9]{32}$/);
  let done = false; void pending.then(() => { done = true; });
  f.socket.message(challenge, 'group', 'wrong-group-user'); f.socket.message(` ${challenge}`, 'single', 'wrong-content-user'); f.socket.message(challenge, 'single', 'wrong-quote-user', { quote: { msgtype: 'text', text: { content: 'quoted' } } });
  f.socket.message('old-job-challenge', 'single', 'other-user'); await flush(); expect(done).toBe(false);
  f.socket.message(challenge); expect(await pending).toMatchObject({ userid: 'callback-user' });
  expect(f.socket.terminated).toBe(true); expect(f.socket.sent).toHaveLength(1);
  f.socket.message(challenge, 'single', 'other-user'); expect(f.challenge).toHaveBeenCalledOnce();
});
it('认证失败没有可用配对码或上游错误泄露', async () => {
  const f = fixture(), pending = pairDraftWecomIdentity(f.options), pendingSettled = settled(pending);
  await opened(f); f.socket.ack(40001); await pendingSettled; await expect(pending).rejects.toThrow(/^wecom_identify_disconnected$/);
  expect(f.challenge).not.toHaveBeenCalled(); expect(f.socket.terminated).toBe(true);
});
it('同bot锁阻止第二连接，取消释放后新job验证码变化且旧消息无效', async () => {
  const f = fixture(), abort = new AbortController(), first = pairDraftWecomIdentity({ ...f.options, signal: abort.signal }), firstSettled = settled(first);
  await opened(f); f.socket.ack(); await vi.waitFor(() => expect(f.challenge).toHaveBeenCalledOnce());
  const old = f.challenge.mock.calls[0][0], second = fixture(f.options.botId);
  await expect(pairDraftWecomIdentity(second.options)).rejects.toThrow(FileLockTimeoutError); expect(second.socket.listenerCount('open')).toBe(0);
  abort.abort(); await firstSettled; await expect(first).rejects.toThrow('wecom_identify_cancelled');
  const next = pairDraftWecomIdentity(second.options); await opened(second); second.socket.ack(); await vi.waitFor(() => expect(second.challenge).toHaveBeenCalledOnce());
  const current = second.challenge.mock.calls[0][0]; expect(current).not.toBe(old);
  second.socket.message(old); await flush(); second.socket.message(current); expect(await next).toMatchObject({ userid: 'callback-user' });
});
it('可控时钟下deadline清理socket；锁后最终预检失败也不能连接', async () => {
  const f = fixture(), pending = pairDraftWecomIdentity(f.options);
  const pendingSettled = settled(pending);
  await opened(f); f.socket.ack(); await vi.waitFor(() => expect(f.challenge).toHaveBeenCalledOnce());
  vi.useFakeTimers(); vi.setSystemTime(Date.now() + 120001);
  f.socket.message(f.challenge.mock.calls[0][0]); await pendingSettled; await expect(pending).rejects.toThrow('wecom_identify_timeout'); expect(f.socket.terminated).toBe(true);
  vi.useRealTimers();
  const blocked = fixture();
  await expect(pairDraftWecomIdentity({ ...blocked.options, beforeConnect: () => { throw new Error('wecom_identify_registered_bot'); } })).rejects.toThrow('wecom_identify_registered_bot');
  expect(blocked.socket.listenerCount('open')).toBe(0); expect(blocked.challenge).not.toHaveBeenCalled();
});
