import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { drainTraexRollout } from '../src/services/traex-transcript.js';

const dirs: string[] = [];
const turn = 'native-turn';
const history = (kind = 'user.text', metadataTurn = turn) => ({
  timestamp: '2026-10-23T04:00:01Z', type: 'history_mutation',
  payload: { operation: 'append', turn_id: turn, items: [{
    type: 'message', role: 'user', content: [{ type: 'input_text', text: 'trusted submitted task' }],
    internal_chat_message_metadata_passthrough: { turn_id: metadataTurn, content_item_kinds: [kind] },
  }] },
});
const final = { timestamp: '2026-10-23T04:00:02Z', type: 'event_msg',
  payload: { type: 'task_complete', turn_id: turn, last_agent_message: 'analysis result' } };
const file = (...rows: unknown[]) => {
  const dir = mkdtempSync(join(tmpdir(), 'traex-user-')); dirs.push(dir);
  const path = join(dir, 'rollout.jsonl');
  writeFileSync(path, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  return path;
};
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('TraeX provenance-tagged history users', () => {
  it('binds a real user start before the final answer', () => {
    const result = drainTraexRollout(file(history('agents_md.instructions'), history(), final), 0);
    expect(result.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(result.events[0]).toMatchObject({ text: 'trusted submitted task', sourceTurnId: turn });
    expect(result.events[1].text).toBe('analysis result');
  });
  it('does not trust user-role runtime injections or inconsistent native IDs', () => {
    const result = drainTraexRollout(file(history('environments.environment_context'), history('user.text', 'other')), 0);
    expect(result.events.filter(e => e.kind === 'user')).toEqual([]);
  });
  it('probes do not consume the live reader user claim', () => {
    const path = file(history());
    expect(drainTraexRollout(path, 0, { probe: true }).events[0].kind).toBe('user');
    expect(drainTraexRollout(path, 0).events[0].kind).toBe('user');
  });
  it('does not duplicate a mirrored legacy user and handles split drains', () => {
    const path = file(history());
    const first = drainTraexRollout(path, 0);
    appendFileSync(path, JSON.stringify({ type: 'event_msg', payload: {
      type: 'user_message', turn_id: turn, message: 'trusted submitted task',
    } }) + '\n' + JSON.stringify(final) + '\n');
    expect(first.events.map(e => e.kind)).toEqual(['user']);
    expect(drainTraexRollout(path, first.newOffset).events.map(e => e.kind)).toEqual(['assistant_final']);
  });
  it('keeps a prior turn pending final when a queued next turn user edge arrives first', () => {
    // Type-ahead: turn B's input is persisted before turn A's terminal. The
    // provenance user edge must only forward the no-turn-id pending bucket
    // (activeKey) — deleting any pending bucket dropped A's recovered final and
    // surfaced an empty answer.
    const turnA = 'native-turn-a';
    const turnB = 'native-turn-b';
    const userHistory = (t: string, text: string) => ({
      timestamp: '2026-10-23T05:00:01Z', type: 'history_mutation',
      payload: { operation: 'append', turn_id: t, items: [{
        type: 'message', role: 'user', content: [{ type: 'input_text', text }],
        internal_chat_message_metadata_passthrough: { turn_id: t, content_item_kinds: ['user.text'] },
      }] },
    });
    const started = (t: string) => ({ timestamp: '2026-10-23T05:00:00Z', type: 'event_msg',
      payload: { type: 'task_started', turn_id: t, root_turn_id: t } });
    const result = drainTraexRollout(file(
      started(turnA),
      userHistory(turnA, 'first task'),
      { timestamp: '2026-10-23T05:00:02Z', type: 'event_msg', payload: {
        type: 'agent_message', turn_id: turnA, phase: 'final_answer', message: 'FIRST ANSWER',
      } },
      started(turnB),
      userHistory(turnB, 'queued next task'),
      { timestamp: '2026-10-23T05:00:04Z', type: 'event_msg', payload: {
        type: 'task_complete', turn_id: turnA, last_agent_message: '',
      } },
      { timestamp: '2026-10-23T05:00:05Z', type: 'event_msg', payload: {
        type: 'task_complete', turn_id: turnB, last_agent_message: 'SECOND ANSWER',
      } },
    ), 0);
    expect(result.events.filter(e => e.kind === 'assistant_final').map(e => [e.sourceTurnId, e.text])).toEqual([
      [turnA, 'FIRST ANSWER'],
      [turnB, 'SECOND ANSWER'],
    ]);
  });
  it('recovers this turn answer when an AgentMessage item landed before the user edge', () => {
    // Out-of-order dialect: the 0.201.4 item_completed AgentMessage mirror is
    // persisted before the provenance user edge. The user edge must not clear
    // the same turn's already-buffered final candidate.
    const agentItem = { timestamp: '2026-10-23T06:00:01Z', type: 'event_msg', payload: {
      type: 'item_completed', turn_id: turn,
      item: { type: 'AgentMessage', id: 'am-1', content: [{ type: 'text', text: 'LATE ANSWER' }] },
    } };
    const terminalEmpty = { timestamp: '2026-10-23T06:00:03Z', type: 'event_msg',
      payload: { type: 'task_complete', turn_id: turn, last_agent_message: '' } };
    const result = drainTraexRollout(file(agentItem, history(), terminalEmpty), 0);
    expect(result.events.filter(e => e.kind === 'assistant_final').map(e => e.text)).toEqual(['LATE ANSWER']);
  });
  it('recovers the answer across drains when evidence precedes the user edge', () => {
    const path = file({ timestamp: '2026-10-23T07:00:01Z', type: 'event_msg', payload: {
      type: 'item_completed', turn_id: turn,
      item: { type: 'AgentMessage', id: 'am-2', content: [{ type: 'text', text: 'SPLIT ANSWER' }] },
    } });
    const first = drainTraexRollout(path, 0);
    appendFileSync(path, JSON.stringify(history()) + '\n' + JSON.stringify({
      timestamp: '2026-10-23T07:00:03Z', type: 'event_msg',
      payload: { type: 'task_complete', turn_id: turn, last_agent_message: '' },
    }) + '\n');
    expect(first.events.some(e => e.kind === 'assistant_final')).toBe(false);
    expect(drainTraexRollout(path, first.newOffset).events
      .filter(e => e.kind === 'assistant_final').map(e => e.text)).toEqual(['SPLIT ANSWER']);
  });
  it('binds a turn-id-less AgentMessage item via the active key after the user edge', () => {
    // AgentMessage mirrors can omit turn_id; they are buffered under the active
    // key, which the provenance user edge must forward to the native turn.
    const keylessAgentItem = { timestamp: '2026-10-23T08:00:02Z', type: 'event_msg', payload: {
      type: 'item_completed',
      item: { type: 'AgentMessage', id: 'am-3', content: [{ type: 'text', text: 'ACTIVE-KEY ANSWER' }] },
    } };
    const terminalEmpty = { timestamp: '2026-10-23T08:00:03Z', type: 'event_msg',
      payload: { type: 'task_complete', turn_id: turn, last_agent_message: '' } };
    const result = drainTraexRollout(file(history(), keylessAgentItem, terminalEmpty), 0);
    expect(result.events.filter(e => e.kind === 'assistant_final').map(e => e.text))
      .toEqual(['ACTIVE-KEY ANSWER']);
  });
});
