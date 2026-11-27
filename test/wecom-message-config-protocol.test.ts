import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type WebSocket from 'ws';
import { WecomTransport } from '../src/im/wecom/protocol/transport.js';
import { normalizeWecomCardEvent } from '../src/im/wecom/protocol/messages.js';
import { validateWecomMessageConfig } from '../src/im/wecom/config/message-config.js';
import { parseWecomConfig } from '../src/im/wecom/config/config.js';
import { STREAMING_CARD_BUTTON_IDS } from '../src/im/lark/streaming-card-buttons.js';
import { botProfileCapabilities } from '../src/dashboard/web/providers/profile.js';
class Socket extends EventEmitter {
  sent: any[] = [];
  send(data: string, cb?: (error?: Error) => void) { this.sent.push(JSON.parse(data)); cb?.(); }
  terminate() { this.emit('close'); }
  receive(frame: unknown) { this.emit('message', Buffer.from(JSON.stringify(frame))); }
  ack() { this.receive({ headers: this.sent.at(-1).headers, errcode: 0 }); }
}
let transport: WecomTransport | undefined;
afterEach(async () => { await transport?.stop(); transport = undefined; vi.useRealTimers(); });
async function setup() {
  const socket = new Socket(), onCardEvent = vi.fn();
  transport = new WecomTransport({ botId: 'bot', secret: 'secret', socketFactory: () => socket as unknown as WebSocket, onCardEvent });
  const started = transport.start(); socket.emit('open'); socket.ack(); await started;
  return { socket, onCardEvent, transport };
}
const nativeEvent = { msgid: 'event', aibotid: 'bot', chattype: 'group', chatid: 'g', from: { userid: 'alice' }, msgtype: 'event', event: { eventtype: 'template_card_event', task_id: 'task-final', event_key: 'feedback:good' } };
const card = { card_type: 'button_interaction' as const, task_id: 'task-final', main_title: { title: 'result' }, button_list: [{ text: 'useful', key: 'feedback:good' }] };
describe('WeCom message protocol follows the official SDK wire format', () => {
  it('emits authenticated callback identities only for its own native bot', async () => {
    const { socket, onCardEvent } = await setup();
    socket.receive({ cmd: 'aibot_event_callback', headers: { req_id: 'req' }, body: nativeEvent }); await Promise.resolve();
    expect(onCardEvent).toHaveBeenCalledWith(expect.objectContaining({ botId: 'bot', userId: 'alice', conversationId: 'g', taskId: 'task-final', eventKey: 'feedback:good', requestId: 'req' }));
    socket.receive({ cmd: 'aibot_event_callback', headers: { req_id: 'req' }, body: { ...nativeEvent, aibotid: 'other' } }); await Promise.resolve(); expect(onCardEvent).toHaveBeenCalledTimes(1);
    expect(normalizeWecomCardEvent({ ...nativeEvent, from: {} }, 'req', 'bot')).toBeUndefined();
    expect(normalizeWecomCardEvent({ ...nativeEvent, event: { eventtype: 'feedback_event' } }, 'req', 'bot')).toBeUndefined();
  });
  it('sends stream plus template, proactive template and user-scoped callback update with ACK sequencing', async () => {
    const { transport, socket } = await setup();
    const pending = transport.replyWithCard({ messageId: 'm', userId: 'alice', conversationId: 'g', chatType: 'group', text: 'hi', attachments: [], replyContext: { requestId: 'req' } }, 'answer', { streamId: 's', finish: true, card });
    expect(socket.sent.at(-1)).toMatchObject({ cmd: 'aibot_respond_msg', headers: { req_id: 'req' }, body: { msgtype: 'stream_with_template_card', stream: { id: 's', content: 'answer', finish: true }, template_card: card } }); socket.ack(); await pending;
    const pushed = transport.sendCard('g', card); expect(socket.sent.at(-1)).toMatchObject({ cmd: 'aibot_send_msg', body: { chatid: 'g', msgtype: 'template_card', template_card: card } }); socket.ack(); await pushed;
    const event = normalizeWecomCardEvent(nativeEvent, 'card-callback', 'bot')!;
    const updated = transport.updateCard(event, card); expect(socket.sent.at(-1)).toMatchObject({ cmd: 'aibot_respond_update_msg', headers: { req_id: 'card-callback' }, body: { response_type: 'update_template_card', userids: ['alice'], template_card: card } }); socket.ack(); await updated;
    await expect(transport.updateCard({ ...event, receivedAt: Date.now() - 5000 }, card)).rejects.toThrow(/expired or mismatched/);
    await expect(transport.updateCard(event, { ...card, task_id: 'foreign-task' })).rejects.toThrow(/expired or mismatched/);
  });
  it('validates native reviewer identity and rejects unsupported controls instead of accepting inert values', () => {
    const config = validateWecomMessageConfig({ feedback: { enabled: true, audience: 'reviewers', reviewers: ['alice'] }, hiddenStreamingCardButtons: ['stop'], noProgressNotify: { enabled: true, timeoutMs: 10000 } });
    expect(config.feedback).toMatchObject({ reviewers: ['alice'] });
    expect(validateWecomMessageConfig({ hiddenStreamingCardButtons: ['terminal', 'writeLink'] }).hiddenStreamingCardButtons).toEqual(['terminal', 'writeLink']);
    for (const unknown of ['nope', 'Terminal', '', 42]) {
      expect(() => validateWecomMessageConfig({ hiddenStreamingCardButtons: ['stop', unknown] }), String(unknown)).toThrow('invalid_wecom_hidden_buttons');
    }
    expect(() => validateWecomMessageConfig({ hiddenStreamingCardButtons: 'terminal' })).toThrow('invalid_wecom_hidden_buttons');
    expect(() => validateWecomMessageConfig({ feedback: { enabled: true, audience: 'reviewers', reviewers: ['*'] } })).toThrow('invalid_wecom_feedback_reviewers');
    expect(() => validateWecomMessageConfig({ pinStreamingCard: true })).toThrow('invalid_wecom_message_config');
  });
  // Mutation: a button the configuration page offers missing from the validator (or the reverse) turns this red.
  it('keeps exactly the reply-card buttons the configuration page offers', () => {
    const offered = botProfileCapabilities('wecom').cardButtons;
    const kept = STREAMING_CARD_BUTTON_IDS.filter(id => {
      try {
        return validateWecomMessageConfig({ hiddenStreamingCardButtons: [id] }).hiddenStreamingCardButtons?.includes(id) === true;
      } catch {
        return false;
      }
    });
    expect(offered).toBeDefined();
    expect([...kept].sort()).toEqual([...offered!].sort());
  });
  it('still parses a file that hides the retired reply-draft button, and drops it', () => {
    expect(validateWecomMessageConfig({ hiddenStreamingCardButtons: ['substitute', 'stop'] }).hiddenStreamingCardButtons).toEqual(['stop']);
    const parsed = parseWecomConfig({
      botId: 'bot', secretEnv: 'FAKE_WECOM_SECRET', coreUrl: 'http://127.0.0.1:19443', allowedUsers: ['alice'],
      message: { hiddenStreamingCardButtons: ['substitute'] },
    });
    expect(parsed.message?.hiddenStreamingCardButtons).toEqual([]);
  });
});
