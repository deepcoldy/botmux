import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { normalizeWecomMessage, normalizeWecomCardEvent } from './messages.js';
import { WecomDeliveryUncertainError } from './types.js';
import type { WecomInboundMessage, WecomInboundEvent, WecomCardEvent, WecomTemplateCard } from './types.js';
export type { WecomInboundMessage, WecomMessage, WecomInboundEvent } from './types.js';

interface Frame { cmd?: string; headers?: {req_id?: string}; body?: Record<string, unknown>; errcode?: number; errmsg?: string }
interface Job {frame: Frame; resolve: () => void; reject: (error: Error) => void; timer?: ReturnType<typeof setTimeout>}
export type WecomTerminalReason = 'replaced' | 'authentication_failed' | 'reconnect_exhausted';
export interface WecomTransportOptions {
  botId: string; secret: string;
  onMessage?: (message: WecomInboundMessage) => Promise<void> | void;
  onCardEvent?: (event: WecomCardEvent) => Promise<void> | void;
  onError?: (error: Error) => void;
  /** Optional redacted diagnostics; observer failures never affect message processing. */
  onInboundEvent?: (event: WecomInboundEvent) => void | Promise<void>;
  onConnectionState?: (state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected') => void;
  /** Called after transport cleanup only when automatic recovery is no longer possible. */
  onTerminalDisconnect?: (reason: WecomTerminalReason) => void;
  /** Injection seams for isolated protocol tests. */
  socketFactory?: (url: string) => WebSocket;
  heartbeatMs?: number; reconnectMs?: number; ackTimeoutMs?: number;
}
/** Minimal long-connection protocol; no Lark identifiers or topic emulation. */
export class WecomTransport {
  private socket?: WebSocket;
  private stopped = true;
  private authenticated = false;
  private reconnect?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private authTimer?: ReturnType<typeof setTimeout>;
  private startResolve?: () => void;
  private startReject?: (error: Error) => void;
  private handler?: WecomTransportOptions['onMessage'];
  private queues = new Map<string, Job[]>();
  private expiredReplyIds = new Set<string>();
  private missedPongs = new Set<string>();
  private attempt = 0;
  constructor(private readonly options: WecomTransportOptions) { this.handler = options.onMessage; }
  async start(onMessage?: WecomTransportOptions['onMessage']): Promise<void> {
    if (!this.stopped) throw new Error('WeCom transport already started');
    if (!this.options.botId || !this.options.secret) throw new Error('WeCom botId and secret are required');
    this.handler = onMessage ?? this.handler;
    this.expiredReplyIds.clear();
    this.stopped = false; this.attempt = 0;
    return new Promise<void>((resolve, reject) => { this.startResolve = resolve; this.startReject = reject; this.connect(); });
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.connectionState('disconnected');
    this.clearTimers();
    this.failAll(new Error('WeCom transport stopped'));
    this.startReject?.(new Error('WeCom transport stopped before authentication'));
    this.startResolve = undefined; this.startReject = undefined;
    const socket = this.socket; this.socket = undefined; this.authenticated = false;
    socket?.terminate();
  }
  private terminal(reason: WecomTerminalReason, error: Error): void {
    this.startReject?.(error);
    // stop() performs cleanup synchronously, before notifying the command owner.
    void this.stop();
    try { this.options.onTerminalDisconnect?.(reason); } catch (callbackError) { this.error(callbackError); }
    this.error(error);
  }
  private inboundEvent(event: WecomInboundEvent): void {
    try {
      void Promise.resolve(this.options.onInboundEvent?.(event)).catch(() => {});
    } catch { /* Diagnostics are not part of delivery authority. */ }
  }
  private error(error: unknown): void { this.options.onError?.(error instanceof Error ? error : new Error(String(error))); }
  private connectionState(state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'): void {
    try { this.options.onConnectionState?.(state); } catch (error) { this.error(error); }
  }
  private connect(): void {
    if (this.stopped) return;
    this.connectionState('connecting');
    let socket: WebSocket;
    try { socket = (this.options.socketFactory ?? (url => new WebSocket(url)))('wss://openws.work.weixin.qq.com'); }
    catch (error) { this.error(error); this.scheduleReconnect(); return; }
    this.socket = socket;
    this.expiredReplyIds.clear();
    const authId = `aibot_subscribe_${randomUUID()}`;
    // Bound both connection establishment and authentication so a hung socket cannot stall start forever.
    this.authTimer = setTimeout(() => socket.terminate(), this.options.ackTimeoutMs ?? 10000);
    socket.on('open', () => {
      if (this.socket !== socket || this.stopped) return;
      socket.send(JSON.stringify({cmd: 'aibot_subscribe', headers: {req_id: authId}, body: {bot_id: this.options.botId, secret: this.options.secret}}));
    });
    socket.on('message', data => {
      if (this.socket !== socket || this.stopped) return;
      let frame: Frame;
      try { frame = JSON.parse(data.toString()) as Frame; } catch { this.error(new Error('Invalid WeCom JSON frame')); return; }
      if (!frame || typeof frame !== 'object') return;
      const id = frame.headers?.req_id;
      if (frame.cmd === 'aibot_msg_callback') this.inboundEvent('callback_received');
      if (frame.cmd === 'aibot_event_callback' && (frame.body?.event as {eventtype?: string} | undefined)?.eventtype === 'disconnected_event') {
        this.terminal('replaced', new Error('WeCom connection replaced by another client')); return;
      }
      if (id === authId) {
        if (this.authenticated) return;
        if (frame.errcode !== 0) {
          const error = new Error(`WeCom authentication rejected (${frame.errcode}): ${frame.errmsg ?? ''}`);
          this.terminal('authentication_failed', error); return;
        }
        if (this.authTimer) clearTimeout(this.authTimer);
        this.authenticated = true; this.attempt = 0;
        this.connectionState('connected');
        this.startResolve?.(); this.startResolve = undefined; this.startReject = undefined;
        this.heartbeat = setInterval(() => {
          if (this.missedPongs.size >= 2) { socket.terminate(); return; }
          const pingId = `ping_${randomUUID()}`; this.missedPongs.add(pingId);
          socket.send(JSON.stringify({cmd:'ping', headers:{req_id:pingId}}));
        }, this.options.heartbeatMs ?? 30000);
        return;
      }
      if (!this.authenticated) {
        if (frame.cmd === 'aibot_msg_callback') this.inboundEvent('callback_before_auth');
        return;
      }
      if (frame.cmd === 'aibot_event_callback') {
        const event = normalizeWecomCardEvent(frame.body, id ?? '', this.options.botId);
        if (event) void Promise.resolve().then(() => {
          if (!this.stopped && this.socket === socket) return this.options.onCardEvent?.(event);
        }).catch(error => this.error(error));
        return;
      }
      if (frame.cmd === 'aibot_msg_callback') {
        const message = normalizeWecomMessage(frame.body, id ?? '');
        this.inboundEvent(message ? 'normalized' : 'invalid_message');
        if (message) void Promise.resolve().then(() => {
          if (!this.stopped && this.socket === socket) return this.handler?.(message);
        }).catch(error => this.error(error));
        return;
      }
      if (id && this.missedPongs.has(id)) { if (frame.errcode === 0) this.missedPongs.clear(); return; }
      if (id && !frame.cmd) {
        const queue = this.queues.get(id), job = queue?.[0];
        if (!job) return;
        if (job.timer) clearTimeout(job.timer);
        queue!.shift();
        if (frame.errcode === 0) job.resolve();
        else job.reject(new Error(`WeCom request rejected (${frame.errcode}): ${frame.errmsg ?? ''}`));
        if (queue!.length) this.dispatch(id); else this.queues.delete(id);
      }
    });
    socket.on('error', error => this.error(error));
    socket.on('close', () => {
      if (this.socket !== socket) return;
      this.socket = undefined; this.authenticated = false;
      this.clearTimers(); this.failAll(new Error('WeCom connection closed'));
      this.scheduleReconnect();
    });
  }
  private scheduleReconnect(): void {
    if (this.stopped || this.reconnect) return;
    this.connectionState('reconnecting');
    if (++this.attempt > 10) {
      const error = new Error('WeCom reconnection attempts exhausted');
      this.terminal('reconnect_exhausted', error); return;
    }
    this.reconnect = setTimeout(() => { this.reconnect = undefined; this.connect(); }, Math.min((this.options.reconnectMs ?? 1000) * 2 ** (this.attempt - 1), 30000));
  }
  private clearTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.authTimer) clearTimeout(this.authTimer);
    if (this.reconnect) clearTimeout(this.reconnect);
    this.heartbeat = undefined; this.authTimer = undefined; this.reconnect = undefined; this.missedPongs.clear();
  }
  private failAll(error: Error): void {
    for (const queue of this.queues.values()) for (const job of queue) { const sent = !!job.timer; if (job.timer) clearTimeout(job.timer); job.reject(sent ? new WecomDeliveryUncertainError(error.message) : error); }
    this.queues.clear();
  }
  private enqueue(requestId: string, cmd: string, body: Record<string, unknown>): Promise<void> {
    if (!requestId) return Promise.reject(new Error('WeCom request id is required'));
    if (this.expiredReplyIds.has(requestId)) return Promise.reject(new Error('WeCom reply request expired after acknowledgement timeout'));
    if (!this.authenticated || !this.socket || this.stopped) return Promise.reject(new Error('WeCom transport is not authenticated'));
    return new Promise<void>((resolve, reject) => {
      const queue = this.queues.get(requestId) ?? [];
      if (queue.length >= 100) { reject(new Error('WeCom reply queue full')); return; }
      queue.push({frame:{cmd, headers:{req_id:requestId}, body}, resolve, reject});
      this.queues.set(requestId, queue);
      if (queue.length === 1) this.dispatch(requestId);
    });
  }
  private dispatch(id: string): void {
    const job = this.queues.get(id)?.[0];
    if (!job) return;
    job.timer = setTimeout(() => {
      // ACKs carry no sequence number. After timeout the whole queue must fail:
      // a late ACK cannot safely be attributed to a later update with the same req_id.
      const queue = this.queues.get(id); this.queues.delete(id);
      this.expiredReplyIds.add(id);
      for (const pending of queue ?? []) pending.reject(new WecomDeliveryUncertainError('WeCom reply acknowledgement timed out'));
    }, this.options.ackTimeoutMs ?? 10000);
    try { this.socket!.send(JSON.stringify(job.frame), error => { if (error) { this.failAll(error); } }); }
    catch (error) { this.failAll(error instanceof Error ? error : new Error(String(error))); }
  }
  reply(message: WecomInboundMessage, text: string, options: {streamId?: string; finish?: boolean} = {}): Promise<void> {
    return this.replyStream(message.replyContext.requestId, {id: options.streamId ?? randomUUID(), content: text, finish: options.finish ?? true});
  }
  replyStream(requestId: string, stream: {id: string; content: string; finish: boolean}): Promise<void> {
    if (Buffer.byteLength(stream.content, 'utf8') > 20480) return Promise.reject(new Error('WeCom stream content exceeds 20480 UTF-8 bytes'));
    return this.enqueue(requestId, 'aibot_respond_msg', {msgtype:'stream', stream});
  }
  replyWithCard(message: WecomInboundMessage, text: string, options: { streamId: string; finish: boolean; card: WecomTemplateCard }): Promise<void> {
    if (Buffer.byteLength(text, 'utf8') > 20480) return Promise.reject(new Error('WeCom stream content exceeds 20480 UTF-8 bytes'));
    return this.enqueue(message.replyContext.requestId, 'aibot_respond_msg', {
      msgtype: 'stream_with_template_card', stream: { id: options.streamId, content: text, finish: options.finish }, template_card: options.card,
    });
  }
  sendCard(conversationId: string, card: WecomTemplateCard): Promise<void> {
    return this.enqueue(`aibot_send_msg_${randomUUID()}`, 'aibot_send_msg', { chatid: conversationId, msgtype: 'template_card', template_card: card });
  }
  updateCard(event: WecomCardEvent, card: WecomTemplateCard): Promise<void> {
    if (Date.now() - event.receivedAt >= 5000 || card.task_id !== event.taskId || event.botId !== this.options.botId) return Promise.reject(new Error('WeCom card event expired or mismatched'));
    return this.enqueue(event.requestId, 'aibot_respond_update_msg', { response_type: 'update_template_card', template_card: card, userids: [event.userId] });
  }
  send(conversationId: string, text: string): Promise<void> { return this.sendMarkdown(conversationId, text); }
  sendMarkdown(conversationId: string, text: string): Promise<void> {
    return this.enqueue(`aibot_send_msg_${randomUUID()}`, 'aibot_send_msg', {chatid:conversationId, msgtype:'markdown', markdown:{content:text}});
  }
}
