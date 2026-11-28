/**
 * The feedback and controls cards after an answer are sent only while their
 * buttons are still honoured (the card-action window from a task's creation),
 * through the real bridge with an in-process core and transport and a fake
 * clock. A card whose every button would be refused is not sent, and nothing
 * is recorded for it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WecomBridge, type WecomBridgePolicy } from '../src/im/wecom/gateway/bridge.js';
import { WECOM_CARD_ACTION_WINDOW_MS } from '../src/im/wecom/gateway/bridge/card-events.js';
import type { TriggerRequest } from '../src/services/trigger-types.js';
import type { WecomInboundMessage, WecomTemplateCard } from '../src/im/wecom/protocol/types.js';

const T0 = Date.parse('2026-01-05T00:00:00Z');
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const keyOf = (messageId: string) => createHash('sha256').update(JSON.stringify(['bot', messageId])).digest('hex');
const message = (id: string): WecomInboundMessage =>
  ({ messageId: id, userId: 'alice', conversationId: 'alice', chatType: 'single', text: 'task', attachments: [], replyContext: { requestId: id } });

function harness(initial: Partial<WecomBridgePolicy> = {}) {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  const root = mkdtempSync(join(tmpdir(), 'wecom-card-window-'));
  roots.push(root);
  const stateFile = join(root, 'state.json');
  let policy: WecomBridgePolicy = { allowedUsers: ['alice'], ...initial };
  const running = new Set<string>();
  const cards: WecomTemplateCard[] = [];
  const replies: string[] = [];
  const bridge = new WecomBridge({
    botId: 'bot',
    allowedUsers: ['alice'],
    policy: () => policy,
    stateFile,
    transport: {
      reply: vi.fn(async (_m: WecomInboundMessage, text: string) => { replies.push(text); }),
      send: vi.fn(async () => {}),
      sendCard: vi.fn(async (_to: string, card: WecomTemplateCard) => { cards.push(card); }),
      updateCard: vi.fn(async () => {}),
    },
    core: {
      trigger: vi.fn(async (request: TriggerRequest) => ({
        ok: true, triggerId: `turn-${request.source.requestId}`, target: { kind: 'turn' as const, sessionId: 's1' },
      })),
      result: vi.fn(async (_sid: string, triggerId: string) => (running.has(triggerId)
        ? { ok: true, state: 'running' as const }
        : { ok: true, state: 'completed' as const, output: { content: `answer to ${triggerId}` } })),
      interrupt: vi.fn(async () => {}),
    },
    peerRoot: root,
    log: () => {},
  });
  return {
    bridge, cards, replies, running,
    task: (id: string) => JSON.parse(readFileSync(stateFile, 'utf8')).tasks[keyOf(id)],
    controlsCards: () => cards.filter(card => card.task_id.endsWith('-controls')).map(card => card.task_id),
    enable: (patch: Partial<WecomBridgePolicy>) => { policy = { ...policy, ...patch }; },
    at: (ms: number) => vi.setSystemTime(T0 + ms),
  };
}

describe('auxiliary cards of a delivered task', () => {
  // Mutation: sending auxiliary cards past the window turns this red.
  it('sends no card for a task past the window when card buttons are switched on later, and records nothing for it', async () => {
    const h = harness();
    await h.bridge.receive(message('a1'));
    await h.bridge.tick();
    expect(h.task('a1').delivered).toBe(true);
    expect(h.cards).toEqual([]);

    h.at(WECOM_CARD_ACTION_WINDOW_MS + 60_000);
    h.enable({ replyCardActions: true });
    await h.bridge.tick();
    expect(h.cards).toEqual([]);
    expect(h.task('a1')).not.toHaveProperty('controlsCardAttempted');
    expect(h.task('a1')).not.toHaveProperty('finalCardAttempted');
  });

  it('still sends the controls card, once, for a task inside the window', async () => {
    const h = harness();
    await h.bridge.receive(message('a1'));
    await h.bridge.tick();

    h.at(WECOM_CARD_ACTION_WINDOW_MS / 2);
    h.enable({ replyCardActions: true });
    await h.bridge.tick();
    await h.bridge.tick();
    expect(h.controlsCards()).toEqual([`${keyOf('a1')}-controls`]);
  });

  // Mutation: sending auxiliary cards past the window turns this red.
  it('delivers the answer of a turn that ran past the window, without a controls card', async () => {
    const h = harness({ replyCardActions: true });
    h.running.add('turn-a1');
    await h.bridge.receive(message('a1'));
    await h.bridge.tick();

    h.at(WECOM_CARD_ACTION_WINDOW_MS + 60 * 60 * 1000);
    h.running.delete('turn-a1');
    await h.bridge.tick();
    expect(h.task('a1').delivered).toBe(true);
    expect(h.replies.some(text => text.includes('answer to turn-a1'))).toBe(true);
    expect(h.controlsCards()).toEqual([]);
  });
});
