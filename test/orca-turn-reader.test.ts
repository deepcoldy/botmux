import { describe, expect, it } from 'vitest';
import { OrcaTurnReader } from '../src/services/orca-turn-reader.js';
import { orcaMutation } from '../src/services/orca-session-protocol.js';
import type { OrcaItem, OrcaPage } from '../src/services/orca-session-protocol.js';

function page(items: OrcaItem[], removedItemIds: string[] = []): OrcaPage {
  return { sessionId: 'session', items, removedItemIds, submissions: [], hasNewer: false,
    window: { nextCursor: { epoch: 'epoch', sequence: 10 } } };
}
function message(itemId: string, turnItemId: string, text: string, revision = 0): OrcaItem {
  return { itemId, revision, sequence: 2, turnScope: { kind: 'turn', turnItemId },
    body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text }] } };
}
const turn: OrcaItem = { itemId: 'turn', revision: 0, sequence: 1,
  body: { kind: 'turn', turnId: 'native-turn', userItemId: 'orca:operation', state: 'running' } };

describe('Orca turn journal', () => {
  it('folds revised rows, ignores local turns and subagents, and waits for the authoritative outcome', () => {
    const reader = new OrcaTurnReader('operation');
    reader.apply(page([turn, message('answer', 'turn', 'Hel'), message('local', 'other', 'private'),
      { ...message('child', 'turn', 'subagent'), agentId: 'child' }]));
    expect(reader.view()).toMatchObject({ text: 'Hel', done: false });
    reader.apply(page([message('answer', 'turn', 'Hello', 1), { ...turn, revision: 1,
      body: { ...turn.body, state: 'completed', outcome: 'success' } }]));
    expect(reader.view()).toMatchObject({ text: 'Hello', done: true, failed: undefined });
    reader.apply(page([message('answer', 'turn', 'Hel', 0)]));
    expect(reader.view().text).toBe('Hello');
    reader.apply(page([], ['answer']));
    expect(reader.view().text).toBe('');
  });

  it('does not treat an idle session or a completed turn with no outcome as success', () => {
    const reader = new OrcaTurnReader('operation');
    reader.apply(page([message('local', 'other', 'done')]));
    expect(reader.view().done).toBe(false);
    reader.apply(page([{ ...turn, body: { ...turn.body, state: 'completed' } }]));
    expect(reader.view().failed).toContain('completed');
  });

  it('follows an explicitly linked queued submission after a desktop input race', () => {
    const reader = new OrcaTurnReader('queued-operation');
    reader.apply({ ...page([turn, message('answer', 'turn', 'queued answer')]), submissions: [
      { clientMessageId: 'operation', queuedMessageId: 'queued-operation', dispatchState: 'accepted', providerItemId: null },
    ] });
    expect(reader.view().text).toBe('queued answer');
  });

  it('uses the accepted provider item identity for Claude turns', () => {
    const reader = new OrcaTurnReader('operation');
    reader.apply({ ...page([{ ...turn, body: { ...turn.body, userItemId: 'claude:provider-user' } },
      message('answer', 'turn', 'Claude answer')]), submissions: [
      { clientMessageId: 'operation', dispatchState: 'accepted', providerItemId: 'claude:provider-user' },
    ] });
    expect(reader.view()).toMatchObject({ text: 'Claude answer', done: false });
  });

  it('surfaces rejected and uncertain submissions without borrowing neighbouring output', () => {
    const reader = new OrcaTurnReader('operation');
    reader.apply({ ...page([message('local', 'other', 'wrong')]), submissions: [
      { clientMessageId: 'operation', dispatchState: 'rejected', providerItemId: null, reason: 'busy' },
    ] });
    expect(reader.view()).toMatchObject({ done: true, failed: 'busy', text: '' });
  });

  it('keeps unknown delivery unresolved and accepts later authoritative evidence', () => {
    const reader = new OrcaTurnReader('operation');
    reader.apply({ ...page([]), submissions: [
      { clientMessageId: 'operation', dispatchState: 'unknown', providerItemId: null },
    ] });
    expect(reader.view()).toMatchObject({ done: false, uncertain: 'Orca delivery is unconfirmed' });
    reader.apply({ ...page([{ ...turn, body: { ...turn.body, state: 'completed', outcome: 'success' } },
      message('answer', 'turn', 'confirmed')]), submissions: [
      { clientMessageId: 'operation', dispatchState: 'accepted', providerItemId: null },
    ] });
    expect(reader.view()).toMatchObject({ done: true, text: 'confirmed', failed: undefined });
    expect(reader.view().uncertain).toBeUndefined();
  });

  it('uses the wire fingerprint independent of JSON property order, and fences mutations', () => {
    const a = orcaMutation('agentSession.send', 'session', 2, { body: { role: 'user', kind: 'message' } });
    const b = orcaMutation('agentSession.send', 'session', 2, { body: { kind: 'message', role: 'user' } });
    expect(a.envelope.payloadFingerprint).toBe(b.envelope.payloadFingerprint);
    expect(a.envelope.clientOperationId).not.toBe(b.envelope.clientOperationId);
    expect(() => orcaMutation('agentSession.send', 'session', 0, {})).toThrow('fence');
  });
});
