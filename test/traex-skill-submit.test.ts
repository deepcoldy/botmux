import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { traexHistoryMatchDelta, drainTraexRollout } from '../src/services/traex-transcript.js';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { checkpointCodexAdoptTurns, restoreCodexAdoptTurns } from '../src/services/codex-adopt-recovery.js';
import { readBridgeTurnJournal, writeBridgeTurnJournal } from '../src/services/bridge-turn-journal.js';

const SID = '00000000-0000-7000-8000-000000000001';
const START = Date.parse('2026-01-01T00:00:00Z');
const BODY = ' Verify receipt only; keep this complete argument text unchanged.';
let dir: string;
let history: string;
let rollout: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traex-skill-submit-'));
  history = join(dir, 'history.jsonl');
  rollout = join(dir, `rollout-2026-01-01T00-00-00-${SID}.jsonl`);
  writeFileSync(history, '');
  writeFileSync(rollout, '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function receipt(text: string, sid = SID): void {
  appendFileSync(history, JSON.stringify({ session_id: sid, ts: START / 1000, text }) + '\n');
}

function user(text = '$receipt' + BODY, skillName = 'receipt', skillPath = '/tmp/skills/receipt/SKILL.md') {
  return { timestamp: new Date(START + 100).toISOString(), type: 'history_mutation', payload: {
    operation: 'append', turn_id: 'native-1', items: [], display_completions: [{
      thread_id: SID, turn_id: 'native-1', item: { type: 'UserMessage', id: 'user-1', content: [
        { type: 'text', text }, { type: 'skill', name: skillName, path: skillPath },
      ] },
    }],
  } };
}

function append(...records: unknown[]): void {
  appendFileSync(rollout, records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

// Real traex 0.214.1 shape: the raw items carry plain user.text with no skill
// block; only the display completion's UserMessage knows the native skill
// object. Drain order must let that display record claim the turn first.
function realisticUser(text = '$receipt' + BODY, skillName = 'receipt', skillPath = '/tmp/skills/receipt/SKILL.md') {
  return { timestamp: new Date(START + 100).toISOString(), type: 'history_mutation', payload: {
    operation: 'append', turn_id: 'native-1',
    items: [{ type: 'message', role: 'user',
      internal_chat_message_metadata_passthrough: { turn_id: 'native-1', content_item_kinds: ['user.text'] },
      content: [{ type: 'input_text', text }] }],
    display_completions: [{
      thread_id: SID, turn_id: 'native-1', item: { type: 'UserMessage', id: 'user-1', content: [
        { type: 'text', text }, { type: 'skill', name: skillName, path: skillPath },
      ] },
    }],
  } };
}

describe('TRAE native skill submit receipts', () => {
  it.each([
    '/tmp/skills/receipt/SKILL.md',
    '/tmp/skill fixtures/(test)/receipt/SKILL.md',
    '</tmp/skill fixtures/receipt/SKILL.md>',
    '/tmp/skill%20fixtures/receipt/SKILL.md',
    'C:\\skills\\receipt\\SKILL.md',
  ])('matches the complete slash and dollar input against a skill link at %s', path => {
    receipt(`[$receipt](${path})${BODY}`);
    expect(traexHistoryMatchDelta(history, 0, '/receipt' + BODY)).toEqual({ found: true, cliSessionId: SID });
    expect(traexHistoryMatchDelta(history, 0, '$receipt' + BODY).found).toBe(true);
  });

  it('keeps ownership, byte-delta and complete argument checks for expanded skills', () => {
    receipt('[$receipt](/tmp/skills/receipt/SKILL.md)' + BODY, 'foreign');
    expect(traexHistoryMatchDelta(history, 0, '/receipt' + BODY, sid => sid === SID).found).toBe(false);
    expect(traexHistoryMatchDelta(history, 0, '/receipt' + BODY + ' changed').found).toBe(false);
    expect(traexHistoryMatchDelta(history, 0, '/different' + BODY).found).toBe(false);
    const fromByte = Buffer.byteLength(JSON.stringify({ session_id: 'foreign', ts: START / 1000,
      text: '[$receipt](/tmp/skills/receipt/SKILL.md)' + BODY }) + '\n');
    expect(traexHistoryMatchDelta(history, fromByte, '/receipt' + BODY).found).toBe(false);
    receipt('[$receipt](/tmp/skills/receipt/SKILL.md)' + BODY);
    expect(traexHistoryMatchDelta(history, fromByte, '/receipt' + BODY, sid => sid === SID)
      .cliSessionId).toBe(SID);
  });

  it.each(['$receipt' + BODY, '[$receipt](https://example.com/SKILL.md)' + BODY,
    '[$receipt](/tmp/skills/receipt/README.md)' + BODY,
    'prefix [$receipt](/tmp/skills/receipt/SKILL.md)' + BODY])(
    'does not treat unproved prose as a slash submit: %s', text => {
      receipt(text);
      expect(traexHistoryMatchDelta(history, 0, '/receipt' + BODY).found).toBe(false);
    });

  it('preserves ordinary commands and ignores a partially written expanded receipt', () => {
    receipt('/rename Title');
    expect(traexHistoryMatchDelta(history, 0, '/rename Title').found).toBe(true);
    writeFileSync(history, JSON.stringify({ session_id: SID,
      text: '[$receipt](/tmp/skills/receipt/SKILL.md)' + BODY }));
    expect(traexHistoryMatchDelta(history, 0, '/receipt' + BODY).found).toBe(false);
    appendFileSync(history, '\n');
    expect(traexHistoryMatchDelta(history, 0, '/receipt' + BODY).found).toBe(true);
  });
});

describe('TRAE native skill task attribution', () => {
  it('restores exact skill attribution from a checkpoint without persisting private arguments', () => {
    const journal = join(dir, 'journal.json');
    const original = new CodexBridgeQueue(() => START);
    original.mark('im-skill', '/receipt' + BODY, START);
    checkpointCodexAdoptTurns(journal, rollout, original);
    const stored = readBridgeTurnJournal(journal);
    expect(stored[0].inputTextHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(stored)).not.toContain('complete argument text unchanged');
    append(user());
    const events = drainTraexRollout(rollout, 0).events;
    const restored = new CodexBridgeQueue(() => START + 500);
    const recovery = restoreCodexAdoptTurns(journal, rollout, restored, events, START + 500, START + 500);
    restored.ingest(recovery.live);
    expect(restored.peek()[0]).toMatchObject({ turnId: 'im-skill', started: true, sourceMessageId: 'user-1' });

    // A legacy prefix-only journal cannot prove that the expanded arguments
    // are identical. Nor can a corrupted optional digest invent that proof.
    for (const hash of [undefined, 'invalid']) {
      writeBridgeTurnJournal(journal, stored.map(entry => ({ ...entry, inputTextHash: hash })));
      const legacy = new CodexBridgeQueue(() => START + 500);
      const recovered = restoreCodexAdoptTurns(journal, rollout, legacy, events, START + 500, START + 500);
      legacy.ingest(recovered.live);
      expect(legacy.peek()[0]).toMatchObject({ turnId: 'im-skill', started: false });
    }
  });

  it('attributes expanded display input and its completion to the original IM turn once', () => {
    const queue = new CodexBridgeQueue(() => START + 2_000);
    queue.setLocalTurns(true, START);
    const started: string[] = [];
    queue.setTurnStartObserver(turn => started.push(turn.turnId));
    queue.mark('im-skill', '/receipt' + BODY, START);
    queue.beginSubmitVerification('im-skill', START);
    append(user(), { timestamp: new Date(START + 1_000).toISOString(), type: 'event_msg', payload: {
      type: 'task_complete', turn_id: 'native-1', last_agent_message: 'Receipt checked.',
    } });
    const drained = drainTraexRollout(rollout, 0, { adoptMode: true });
    expect(drained.events.find(event => event.kind === 'user')?.text).toBe('$receipt' + BODY);
    queue.ingest(drained.events);
    expect(started).toEqual(['im-skill']);
    expect(queue.drainEmittable()).toEqual([expect.objectContaining({
      turnId: 'im-skill', sourceSessionId: SID, sourceTurnId: 'native-1', finalText: 'Receipt checked.',
    })]);
    expect(queue.size()).toBe(0);
    queue.ingest(drained.events);
    expect(queue.drainEmittable()).toEqual([]);
    expect(started).toEqual(['im-skill']);
  });

  it('hashes a dollar-skill mark and attributes the native token via its skill block', () => {
    const queue = new CodexBridgeQueue(() => START);
    queue.setLocalTurns(true, START);
    const started: string[] = [];
    queue.setTurnStartObserver(turn => started.push(turn.turnId));
    // A leading $ must enter the same hash gate as a slash command: the native
    // UserMessage only matches through inputTextAliases, so a mark without
    // inputTextHash could never start this turn and would lose it to a local
    // turn synthesis.
    queue.mark('im-dollar-skill', '$receipt' + BODY, START);
    expect(queue.peek()[0].inputTextHash).toMatch(/^[a-f0-9]{64}$/);
    queue.beginSubmitVerification('im-dollar-skill', START);
    append(user('$receipt' + BODY, 'receipt', '/tmp/skills/receipt/SKILL.md'));
    queue.ingest(drainTraexRollout(rollout, 0, { adoptMode: true }).events);
    expect(started).toEqual(['im-dollar-skill']);
    expect(queue.peek()[0]).toMatchObject({
      turnId: 'im-dollar-skill', started: true, sourceMessageId: 'user-1',
    });
  });

  it('attributes a real-shaped record once when raw items lack the skill block', () => {
    const queue = new CodexBridgeQueue(() => START + 2_000);
    queue.setLocalTurns(true, START);
    const started: string[] = [];
    queue.setTurnStartObserver(turn => started.push(turn.turnId));
    queue.mark('im-skill', '/receipt' + BODY, START);
    queue.beginSubmitVerification('im-skill', START);
    append(realisticUser(), { timestamp: new Date(START + 1_000).toISOString(), type: 'event_msg', payload: {
      type: 'task_complete', turn_id: 'native-1', last_agent_message: 'Receipt checked.',
    } });
    const drained = drainTraexRollout(rollout, 0, { adoptMode: true });
    // Only the display-derived UserMessage carries aliases; the raw user.text
    // item is de-duplicated on the same native turn id and emits nothing.
    expect(drained.events.filter(event => event.kind === 'user')).toHaveLength(1);
    queue.ingest(drained.events);
    expect(started).toEqual(['im-skill']);
    expect(queue.drainEmittable()).toEqual([expect.objectContaining({
      turnId: 'im-skill', sourceTurnId: 'native-1', finalText: 'Receipt checked.',
    })]);
    expect(queue.size()).toBe(0);
    queue.ingest(drained.events);
    expect(queue.drainEmittable()).toEqual([]);
    expect(started).toEqual(['im-skill']);
  });

  it('corroborates an early task_started claim using the full expanded input', () => {
    const queue = new CodexBridgeQueue(() => START);
    queue.mark('im-skill', '/receipt' + BODY, START);
    queue.beginSubmitVerification('im-skill', START);
    append({ timestamp: new Date(START).toISOString(), type: 'event_msg',
      payload: { type: 'task_started', turn_id: 'native-1' } }, user());
    queue.ingest(drainTraexRollout(rollout, 0).events);
    expect(queue.peek()[0]).toMatchObject({ turnId: 'im-skill', started: true, sourceMessageId: 'user-1' });
    expect(queue.peek()[0].provisionalTaskStartedAtMs).toBeUndefined();
  });

  it.each([
    { text: '$receipt' + BODY + ' different', name: 'receipt', path: '/tmp/receipt/SKILL.md' },
    { text: '$receipt' + BODY, name: 'other', path: '/tmp/receipt/SKILL.md' },
    { text: '$receipt' + BODY, name: 'receipt', path: '/tmp/receipt/README.md' },
  ])('does not bind a mismatched skill or arguments: $name $path $text', row => {
    const queue = new CodexBridgeQueue(() => START);
    queue.mark('im-skill', '/receipt' + BODY, START);
    queue.beginSubmitVerification('im-skill', START);
    append(user(row.text, row.name, row.path));
    queue.ingest(drainTraexRollout(rollout, 0).events);
    expect(queue.peek()[0]).toMatchObject({ turnId: 'im-skill', started: false });
  });

  it('does not use a foreign display record or assistant link as input evidence', () => {
    const queue = new CodexBridgeQueue(() => START);
    queue.mark('im-skill', '/receipt' + BODY, START);
    queue.beginSubmitVerification('im-skill', START);
    const foreign = user();
    foreign.payload.display_completions[0].thread_id = 'foreign';
    append(foreign, { timestamp: new Date(START + 100).toISOString(), type: 'event_msg', payload: {
      type: 'agent_message', message: '[$receipt](/tmp/skills/receipt/SKILL.md)' + BODY,
    } });
    queue.ingest(drainTraexRollout(rollout, 0).events);
    expect(queue.peek()[0]).toMatchObject({ turnId: 'im-skill', started: false });
  });
});
