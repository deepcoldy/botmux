import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WecomTransport } from '../src/im/wecom/protocol/transport.js';
import { normalizeWecomMessage } from '../src/im/wecom/protocol/messages.js';
class Socket extends EventEmitter {
  sent: any[] = [];
  send(data: string, cb?: (error?: Error) => void) { this.sent.push(JSON.parse(data)); cb?.(); }
  close() { this.emit('close'); }
  terminate() { this.emit('close'); }
  receive(frame: unknown) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  ack(index = this.sent.length - 1, errcode = 0) { this.receive({headers:this.sent[index].headers,errcode}); }
}
const transports: WecomTransport[] = [];
afterEach(async () => { for (const transport of transports.splice(0)) await transport.stop(); vi.useRealTimers(); });
/**
 * Attach a rejection handler now and assert after the triggering event. Bun's
 * `expect(promise).rejects` waits for the promise where it is called, so creating
 * the assertion before the event would observe a different settlement (or, under
 * fake timers, wait forever).
 */
const settled = (promise: Promise<unknown>) => promise.then(() => undefined, () => undefined);
async function setup() {
  const sockets: Socket[] = [];
  const onError = vi.fn(), onTerminalDisconnect = vi.fn(), onInboundEvent = vi.fn();
  const transport = new WecomTransport({botId:'bot',secret:'secret',onError,onTerminalDisconnect,onInboundEvent,ackTimeoutMs:50,heartbeatMs:100,reconnectMs:10,socketFactory:() => {const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket;}});
  transports.push(transport);
  const handler = vi.fn();
  const started = transport.start(handler);
  sockets[0].emit('open'); sockets[0].ack(); await started;
  return {transport,sockets,handler,onError,onTerminalDisconnect,onInboundEvent};
}
describe('WeCom native transport', () => {
  it('authenticates before start resolves and normalizes native identities', async () => {
    const {sockets,handler} = await setup();
    expect(sockets[0].sent[0]).toMatchObject({cmd:'aibot_subscribe',body:{bot_id:'bot',secret:'secret'}});
    sockets[0].receive({cmd:'aibot_msg_callback',headers:{req_id:'callback'},body:{msgid:'native',aibotid:'bot',chattype:'single',from:{userid:'user'},msgtype:'text',text:{content:'hello'}}});
    await Promise.resolve();
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({messageId:'native',userId:'user',conversationId:'user',text:'hello',replyContext:{requestId:'callback'}}));
  });
  it('只在认证成功发布已连接，网络关闭立即清除该证据', async () => {
    vi.useFakeTimers(); const states: string[] = []; const sockets: Socket[] = [];
    const transport = new WecomTransport({ botId: 'bot', secret: 'secret', onConnectionState: state => states.push(state), reconnectMs: 10,
      socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket as unknown as WebSocket; } });
    transports.push(transport); const started = transport.start();
    expect(states).toEqual(['connecting']); sockets[0].emit('open'); expect(states).not.toContain('connected');
    sockets[0].ack(); await started; expect(states.at(-1)).toBe('connected');
    sockets[0].close(); expect(states.at(-1)).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(10); expect(states.at(-1)).toBe('connecting');
    await transport.stop(); expect(states.at(-1)).toBe('disconnected');
  });
  it('reports fixed diagnostic signals for valid and invalid message callbacks without including payload', async () => {
    const {sockets,handler,onInboundEvent}=await setup();
    sockets[0].receive({cmd:'aibot_msg_callback',headers:{req_id:'private-request'},body:{msgid:'private-id',aibotid:'private-bot',chattype:'single',from:{userid:'private-user'},msgtype:'text',text:{content:'private text'}}});
    sockets[0].receive({cmd:'aibot_msg_callback',headers:{req_id:'invalid'},body:{msgtype:'text',text:{content:'private text'}}});
    sockets[0].receive({cmd:'aibot_event_callback',body:{event:{eventtype:'enter_chat'}}});
    await Promise.resolve();
    expect(onInboundEvent.mock.calls).toEqual([['callback_received'],['normalized'],['callback_received'],['invalid_message']]);
    expect(handler).toHaveBeenCalledTimes(1);
  });
  it('reports callbacks before authentication separately without changing their existing delivery behavior', async () => {
    const socket=new Socket(),onInboundEvent=vi.fn(),handler=vi.fn();
    const transport=new WecomTransport({botId:'bot',secret:'secret',socketFactory:()=>socket as unknown as WebSocket,onInboundEvent});transports.push(transport);
    const started=transport.start(handler);socket.emit('open');
    socket.receive({cmd:'aibot_msg_callback',headers:{req_id:'r'},body:{msgid:'m',chattype:'single',from:{userid:'u'},msgtype:'text',text:{content:'x'}}});
    socket.ack(0);await started;await Promise.resolve();
    expect(onInboundEvent.mock.calls).toEqual([['callback_received'],['callback_before_auth']]);
    expect(handler).not.toHaveBeenCalled();
  });
  it.each(['throw', 'reject'])('does not let a diagnostic observer %s interrupt message delivery', async failure => {
    const socket=new Socket(),handler=vi.fn(),onError=vi.fn();
    const transport=new WecomTransport({botId:'bot',secret:'secret',socketFactory:()=>socket as unknown as WebSocket,onInboundEvent:()=>{if (failure === 'reject') return Promise.reject(new Error('observer failed')); throw new Error('observer failed');},onError});transports.push(transport);
    const started=transport.start(handler);socket.emit('open');socket.ack();await started;
    socket.receive({cmd:'aibot_msg_callback',headers:{req_id:'r'},body:{msgid:'m',chattype:'single',from:{userid:'u'},msgtype:'text',text:{content:'x'}}});
    await Promise.resolve();expect(handler).toHaveBeenCalledTimes(1);expect(onError).not.toHaveBeenCalled();
  });
  it('keeps quoted content separate and parses mixed media without a synthetic thread', () => {
    const message = normalizeWecomMessage({msgid:'m',from:{userid:'u'},chattype:'group',chatid:'g',msgtype:'mixed',mixed:{msg_item:[{msgtype:'text',text:{content:'hi'}},{msgtype:'image',image:{url:'https://example.test/image',aeskey:'key'}}]},quote:{msgtype:'text',text:{content:'quoted'}}},'r');
    expect(message).toEqual({messageId:'m',userId:'u',conversationId:'g',chatType:'group',text:'hi',attachments:[{type:'image',url:'https://example.test/image',aesKey:'key'}],quote:{type:'text',text:'quoted'},replyContext:{requestId:'r'}});
    expect(normalizeWecomMessage({msgid:'m',from:{userid:'u'},chattype:'group'},'r')).toBeUndefined();
  });
  it('serializes updates by callback request id and propagates negative ACKs', async () => {
    const {transport,sockets} = await setup(); const socket=sockets[0];
    const first=transport.replyStream('r',{id:'s',content:'working',finish:false});
    const second=transport.replyStream('r',{id:'s',content:'done',finish:true});
    const secondSettled=settled(second);
    expect(socket.sent).toHaveLength(2); socket.ack(); await first;
    expect(socket.sent).toHaveLength(3); expect(socket.sent[2].body.stream).toEqual({id:'s',content:'done',finish:true});
    socket.ack(2,42); await secondSettled; await expect(second).rejects.toThrow('42');
    const pushed=transport.send('group','result'); expect(socket.sent[3]).toMatchObject({cmd:'aibot_send_msg',body:{chatid:'group',msgtype:'markdown',markdown:{content:'result'}}}); socket.ack(); await pushed;
  });
  it('fails all updates on ACK timeout instead of misattributing a late ACK', async () => {
    vi.useFakeTimers(); const {transport,sockets}=await setup();
    const first=transport.replyStream('r',{id:'s',content:'one',finish:false});
    const second=transport.replyStream('r',{id:'s',content:'two',finish:true});
    const bothSettled=Promise.all([settled(first),settled(second)]);
    await vi.advanceTimersByTimeAsync(51); await bothSettled;
    await expect(first).rejects.toThrow('timed out'); await expect(second).rejects.toThrow('timed out');
    expect(sockets[0].sent).toHaveLength(2);
    const late = transport.replyStream('r',{id:'s',content:'late',finish:true}).catch(error => error);
    await vi.advanceTimersByTimeAsync(51);
    expect(sockets[0].sent.filter(frame => frame.cmd === 'aibot_respond_msg')).toHaveLength(1);
    expect(await late).toBeInstanceOf(Error);
    sockets[0].ack();
  });
  it('reconnects on network closure but stays stopped after replacement', async () => {
    vi.useFakeTimers(); const {sockets,onTerminalDisconnect}=await setup(); sockets[0].close();
    expect(onTerminalDisconnect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10); expect(sockets).toHaveLength(2);
    sockets[1].emit('open'); sockets[1].ack();
    sockets[1].receive({cmd:'aibot_event_callback',body:{event:{eventtype:'disconnected_event'}}});
    expect(onTerminalDisconnect).toHaveBeenCalledExactlyOnceWith('replaced');
    await vi.advanceTimersByTimeAsync(10000); expect(sockets).toHaveLength(2);
  });
  it('does not dispatch queued callbacks after terminal replacement', async () => {
    const {sockets,handler,onTerminalDisconnect}=await setup();
    sockets[0].receive({cmd:'aibot_msg_callback',headers:{req_id:'r'},body:{msgid:'m',chattype:'single',from:{userid:'u'},msgtype:'text',text:{content:'x'}}});
    sockets[0].receive({cmd:'aibot_event_callback',body:{event:{eventtype:'disconnected_event'}}});
    await Promise.resolve();
    expect(onTerminalDisconnect).toHaveBeenCalledExactlyOnceWith('replaced');
    expect(handler).not.toHaveBeenCalled();
  });
  it('detects missing heartbeat ACKs and catches application handler failures', async () => {
    vi.useFakeTimers(); const {sockets,handler,onError}=await setup();
    handler.mockRejectedValueOnce(new Error('handler failed'));
    sockets[0].receive({cmd:'aibot_msg_callback',headers:{req_id:'r'},body:{msgid:'m',chattype:'single',from:{userid:'u'},msgtype:'text',text:{content:'x'}}});
    await vi.advanceTimersByTimeAsync(300); expect(onError).toHaveBeenCalledWith(expect.objectContaining({message:'handler failed'}));
    await vi.advanceTimersByTimeAsync(10); expect(sockets).toHaveLength(2);
  });
  it('closes pending replies and cancels future heartbeat/reconnect work on stop', async () => {
    vi.useFakeTimers(); const {transport,sockets}=await setup();
    const pending=transport.replyStream('r',{id:'s',content:'working',finish:false});
    const pendingSettled=settled(pending);
    await transport.stop(); await pendingSettled; await expect(pending).rejects.toThrow('stopped');
    await vi.advanceTimersByTimeAsync(10000);
    expect(sockets).toHaveLength(1); expect(sockets[0].sent).toHaveLength(2);
    await expect(transport.send('u','later')).rejects.toThrow('not authenticated');
  });
  it.each(['connecting', 'authenticating', 'reconnect_wait'])('stop settles pending startup during %s', async phase => {
    vi.useFakeTimers(); const socket = new Socket(), terminal=vi.fn();
    const transport = new WecomTransport({botId:'b',secret:'s',socketFactory:()=>socket as unknown as WebSocket,onTerminalDisconnect:terminal}); transports.push(transport);
    const started=transport.start().catch(error=>error);
    if (phase !== 'connecting') socket.emit('open');
    if (phase === 'reconnect_wait') socket.close();
    await transport.stop(); expect(await started).toBeInstanceOf(Error);
    await vi.advanceTimersByTimeAsync(100000);
    expect(terminal).not.toHaveBeenCalled();
    expect(socket.sent).toHaveLength(phase === 'connecting' ? 0 : 1);
  });
  it('reports exhausted recovery and settles startup after repeated unreachable connections', async () => {
    vi.useFakeTimers(); const terminal=vi.fn(), factory=vi.fn(()=>new Socket());
    const transport=new WecomTransport({botId:'b',secret:'s',socketFactory:()=>factory() as unknown as WebSocket,onTerminalDisconnect:terminal,ackTimeoutMs:10,reconnectMs:1}); transports.push(transport);
    const started=transport.start().catch(error=>error);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await started).toBeInstanceOf(Error);
    expect(terminal).toHaveBeenCalledExactlyOnceWith('reconnect_exhausted');
    const count=factory.mock.calls.length; await vi.advanceTimersByTimeAsync(100000);
    expect(factory).toHaveBeenCalledTimes(count);
  });
  it('rejects authentication errors and oversized UTF-8 streams', async () => {
    const socket=new Socket(), terminal=vi.fn(); const transport=new WecomTransport({botId:'b',secret:'s',socketFactory:()=>socket as unknown as WebSocket,onTerminalDisconnect:terminal}); transports.push(transport);
    const started=transport.start(); const startSettled=settled(started); socket.emit('open'); socket.ack(0,400); await startSettled;
    await expect(started).rejects.toThrow('authentication rejected');
    expect(terminal).toHaveBeenCalledExactlyOnceWith('authentication_failed');
    await expect(transport.replyStream('r',{id:'s',content:'界'.repeat(7000),finish:true})).rejects.toThrow('20480');
  });
});
