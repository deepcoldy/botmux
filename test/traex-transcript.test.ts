import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodexBridgeQueue } from '../src/services/codex-bridge-queue.js';
import { CODEX_CONNECTION_ERROR_CODE, CODEX_RATE_LIMIT_ERROR_CODE } from '../src/services/codex-transcript.js';
import {
  bridgePostText,
  isBridgeNothingToSendFinal,
  shouldEmitEmptyCompletedBridgeFallback,
  structuredFallbackKind,
} from '../src/services/bridge-fallback-gate.js';
import {
  drainTraexRollout,
  findTraexRolloutSetByPid,
  findTraexRolloutBySessionId,
  readLatestTraexRuntime,
  traexRolloutHasUserInputSince,
  traexHistoryMatchDelta,
  traexHistorySize,
  traexHistorySidIsOwned,
} from '../src/services/traex-transcript.js';
import { openDatabaseSyncNow } from '../src/services/sqlite-compat.js';

const SID = '00000000-0000-7000-8000-000000000001';
const traexTranscriptSource = readFileSync(
  new URL('../src/services/traex-transcript.ts', import.meta.url),
  'utf8',
);
let dir: string;
let path: string;

function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function user(
  text: string,
  timestamp = '2000-01-01T00:00:01.000Z',
  turnId?: string,
) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'user_message',
      message: text,
      images: [],
      local_images: [],
      text_elements: [],
      ...(turnId ? { turn_id: turnId } : {}),
    },
  };
}

function itemCompleted(
  item: { type: string; id: string; content: Array<{ type: string; text: string }> },
  turnId = '00000000-0000-7000-8000-000000000010',
  timestamp = '2000-01-01T00:00:01.000Z',
) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'item_completed',
      thread_id: SID,
      turn_id: turnId,
      item,
      completed_at_ms: Date.parse(timestamp),
    },
  };
}

function userResponseItem(text: string, timestamp = '2000-01-01T00:00:01.000Z') {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  };
}

function assistantProgress(text: string) {
  return {
    timestamp: '2000-01-01T00:00:02.000Z',
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      // TRAE rollout shape: no phase. These records are emitted during
      // tool use and therefore must never close a turn.
      content: [{ type: 'output_text', text }],
    },
  };
}

function taskComplete(lastAgentMessage?: string) {
  return {
    timestamp: '2000-01-01T00:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '00000000-0000-7000-8000-000000000010',
      ...(lastAgentMessage === undefined ? {} : { last_agent_message: lastAgentMessage }),
      completed_at: 946_684_803,
      duration_ms: 1_000,
    },
  };
}

function agentMessage(text: string, phase: 'commentary' | 'final_answer' = 'commentary') {
  return {
    timestamp: '2000-01-01T00:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: text,
      phase,
      memory_citation: null,
    },
  };
}

function historyAppend(items: unknown[], timestamp = '2000-01-01T00:00:02.000Z') {
  return {
    timestamp,
    type: 'history_mutation',
    payload: {
      version: 1,
      commit_id: 'commit-1',
      turn_id: '00000000-0000-7000-8000-000000000010',
      operation: 'append',
      items,
    },
  };
}

function canonicalCompletion(item: unknown, timestamp = '2000-01-01T00:00:01.000Z') {
  return {
    ...historyAppend([], timestamp),
    payload: {
      ...historyAppend([]).payload,
      display_completions: [{
        thread_id: SID,
        turn_id: '00000000-0000-7000-8000-000000000010',
        item,
        started_at_ms: Date.parse(timestamp),
        completed_at_ms: Date.parse(timestamp),
      }],
    },
  };
}

// 0.208-shaped mutation that mirrors the UI completion both in
// display_completions AND as a model-visible response item in `items`.
function historyDisplayCompletion(
  item: { type: string; id: string; content: Array<{ type: string; text: string }> },
  turnId = '00000000-0000-7000-8000-000000000010',
  timestamp = '2000-01-01T00:00:01.000Z',
) {
  return {
    timestamp,
    type: 'history_mutation',
    payload: {
      version: 1,
      commit_id: 'commit-display',
      turn_id: turnId,
      operation: 'append',
      display_completions: [{
        thread_id: SID,
        turn_id: turnId,
        item,
        started_at_ms: Date.parse(timestamp),
        completed_at_ms: Date.parse(timestamp),
      }],
      items: [{
        type: 'message',
        id: item.id,
        role: item.type === 'UserMessage' ? 'user' : 'assistant',
        content: item.content.map(block => ({
          type: item.type === 'UserMessage' ? 'input_text' : 'output_text',
          text: block.text,
        })),
        ...(item.type === 'AgentMessage' ? { phase: 'final_answer' } : {}),
      }],
    },
  };
}


// Dialect that dropped the `phase` field (cf. codex >= 0.146): the record
// carries no phase at all, so commentary and final are byte-identical.
function agentMessageNoPhase(text: string) {
  return {
    timestamp: '2000-01-01T00:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'agent_message',
      message: text,
      memory_citation: null,
    },
  };
}

function taskCompleteWithError(error: unknown, lastAgentMessage?: string) {
  return {
    timestamp: '2000-01-01T00:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'task_complete',
      turn_id: '00000000-0000-7000-8000-000000000010',
      ...(lastAgentMessage === undefined ? {} : { last_agent_message: lastAgentMessage }),
      error,
      completed_at: 946_684_803,
      duration_ms: 1_000,
    },
  };
}

function turnAborted(reason: unknown = 'interrupted') {
  return {
    timestamp: '2000-01-01T00:00:03.000Z',
    type: 'event_msg',
    payload: {
      type: 'turn_aborted',
      turn_id: '00000000-0000-7000-8000-000000000010',
      reason,
      completed_at: 946_684_803,
      duration_ms: 1_000,
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'traex-transcript-'));
  path = join(dir, `rollout-2000-01-01T00-00-00-${SID}.jsonl`);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('findTraexRolloutBySessionId', () => {
  it('does not resolve rollout-shaped files inside TRAE sidecar directories', () => {
    const previousTraeHome = process.env.TRAE_HOME;
    const traeHome = join(dir, 'trae-home');
    const sidecarDir = join(traeHome, 'cli', 'sessions', '2026', '06', '04', 'rollout-blobs');
    const internalRollout = join(sidecarDir, `rollout-internal-${SID}.jsonl`);
    const dbPath = join(traeHome, 'cli', 'state_5.sqlite');
    mkdirSync(sidecarDir, { recursive: true });
    writeFileSync(internalRollout, line(user('internal sidecar record')));
    const db = openDatabaseSyncNow(dbPath);
    expect(db).not.toBeNull();
    db!.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
    db!.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(SID, internalRollout);
    db!.close();
    process.env.TRAE_HOME = traeHome;

    try {
      expect(findTraexRolloutBySessionId(SID)).toBeUndefined();
    } finally {
      if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
      else process.env.TRAE_HOME = previousTraeHome;
    }
  });

  it('resolves a rollout recorded in the TRAE threads index', () => {
    const previousTraeHome = process.env.TRAE_HOME;
    const traeHome = join(dir, 'trae-home');
    const dayDir = join(traeHome, 'cli', 'sessions', '2026', '06', '04');
    const rollout = join(dayDir, `rollout-2026-06-04T12-00-00-${SID}.jsonl`);
    const dbPath = join(traeHome, 'cli', 'state_5.sqlite');
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(rollout, line(user('indexed rollout')));
    const db = openDatabaseSyncNow(dbPath);
    expect(db).not.toBeNull();
    db!.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
    db!.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(SID, rollout);
    db!.close();
    process.env.TRAE_HOME = traeHome;

    try {
      expect(findTraexRolloutBySessionId(SID)).toBe(rollout);
    } finally {
      if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
      else process.env.TRAE_HOME = previousTraeHome;
    }
  });

  it('falls back to the canonical date tree when an older threads schema has no rollout_path', () => {
    const previousTraeHome = process.env.TRAE_HOME;
    const traeHome = join(dir, 'trae-home');
    const dayDir = join(traeHome, 'cli', 'sessions', '2026', '06', '04');
    const rollout = join(dayDir, `rollout-2026-06-04T12-00-00-${SID}.jsonl`);
    const dbPath = join(traeHome, 'cli', 'state_5.sqlite');
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(rollout, line(user('fallback rollout')));
    const db = openDatabaseSyncNow(dbPath);
    expect(db).not.toBeNull();
    db!.exec('CREATE TABLE threads (id TEXT PRIMARY KEY)');
    db!.close();
    process.env.TRAE_HOME = traeHome;

    try {
      expect(findTraexRolloutBySessionId(SID)).toBe(rollout);
    } finally {
      if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
      else process.env.TRAE_HOME = previousTraeHome;
    }
  });

  it('backs off repeated filesystem misses while keeping discovery bounded', () => {
    const previousTraeHome = process.env.TRAE_HOME;
    const traeHome = join(dir, 'trae-home');
    const dayDir = join(traeHome, 'cli', 'sessions', '2026', '06', '04');
    const rollout = join(dayDir, `rollout-2026-06-04T12-00-00-${SID}.jsonl`);
    mkdirSync(dayDir, { recursive: true });
    process.env.TRAE_HOME = traeHome;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T12:00:00.000Z'));

    try {
      expect(findTraexRolloutBySessionId(SID)).toBeUndefined();
      writeFileSync(rollout, line(user('appeared after miss')));

      vi.advanceTimersByTime(1_000);
      expect(findTraexRolloutBySessionId(SID)).toBeUndefined();
      vi.advanceTimersByTime(999);
      expect(findTraexRolloutBySessionId(SID)).toBeUndefined();
      vi.advanceTimersByTime(1);
      expect(findTraexRolloutBySessionId(SID)).toBe(rollout);
    } finally {
      vi.useRealTimers();
      if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
      else process.env.TRAE_HOME = previousTraeHome;
    }
  });

  it('observes a newly indexed rollout during filesystem backoff', () => {
    const previousTraeHome = process.env.TRAE_HOME;
    const traeHome = join(dir, 'trae-home');
    const dayDir = join(traeHome, 'cli', 'sessions', '2026', '06', '04');
    const rollout = join(dayDir, `rollout-2026-06-04T12-00-00-${SID}.jsonl`);
    const dbPath = join(traeHome, 'cli', 'state_5.sqlite');
    mkdirSync(dayDir, { recursive: true });
    process.env.TRAE_HOME = traeHome;
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-04T12:00:00.000Z'));

    try {
      expect(findTraexRolloutBySessionId(SID)).toBeUndefined();

      writeFileSync(rollout, line(user('indexed during backoff')));
      const db = openDatabaseSyncNow(dbPath);
      expect(db).not.toBeNull();
      db!.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)');
      db!.prepare('INSERT INTO threads (id, rollout_path) VALUES (?, ?)').run(SID, rollout);
      db!.close();
      vi.advanceTimersByTime(1_000);

      expect(findTraexRolloutBySessionId(SID)).toBe(rollout);
    } finally {
      vi.useRealTimers();
      if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
      else process.env.TRAE_HOME = previousTraeHome;
    }
  });
});

describe('drainTraexRollout', () => {
  it.each([
    'model output limit exceeded: max_output_tokens',
    'stream disconnected before completion: invalid completed function call arguments: EOF while parsing a string',
  ])('binds canonical display input to a failed turn: %s', (message) => {
    const input = itemCompleted({
      type: 'UserMessage', id: 'canonical-user',
      content: [{ type: 'text', text: 'investigate failure' }],
    });
    const mutation = canonicalCompletion(input.payload.item, input.timestamp);
    writeFileSync(path, line(mutation) + line(taskCompleteWithError({ message })));
    expect(traexRolloutHasUserInputSince(path, 0, 'investigate failure')).toBe(true);
    const queue = new CodexBridgeQueue();
    queue.mark('remote-turn', 'investigate failure', Date.parse(input.timestamp) - 1);
    const events = drainTraexRollout(path, 0).events;
    queue.ingest(events);
    const ready = queue.drainEmittable();
    expect(ready).toEqual([
      expect.objectContaining({ turnId: 'remote-turn', terminalStatus: 'failed' }),
    ]);
    for (const mode of ['send', 'transcript'] as const) {
      expect(structuredFallbackKind(ready[0], undefined, [], false, false, mode)).toBe('failed');
    }
    queue.ingest(events);
    expect(queue.drainEmittable()).toEqual([]);
  });

  it('recovers a canonical final without treating commentary as completion', () => {
    const display = (text: string, phase: string) => canonicalCompletion({
      type: 'AgentMessage', id: `agent-${phase}`, phase,
      content: [{ type: 'Text', text }],
    }, '2000-01-01T00:00:02.000Z');
    writeFileSync(path, line(user('work')) + line(display('still working', 'commentary')));
    const first = drainTraexRollout(path, 0);
    expect(first.events.filter(event => event.kind === 'assistant_final')).toEqual([]);
    appendFileSync(path, line(display('finished result', 'final_answer')) + line(taskComplete()));
    expect(drainTraexRollout(path, first.newOffset).events).toEqual([
      expect.objectContaining({ kind: 'assistant_final', text: 'finished result' }),
    ]);
  });

  it('does not recover another turn from a replayed canonical final', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000010';
    const secondTurnId = '00000000-0000-7000-8000-000000000011';
    const answer = canonicalCompletion({
      type: 'AgentMessage', id: 'replayed-answer', phase: 'final_answer',
      content: [{ type: 'Text', text: 'first answer' }],
    }, '2000-01-01T00:00:02.000Z');
    writeFileSync(path, line(user('first', undefined, firstTurnId))
      + line(answer) + line(taskComplete()));
    const first = drainTraexRollout(path, 0);
    expect(first.events.at(-1)).toEqual(expect.objectContaining({ text: 'first answer' }));
    appendFileSync(path, line(user('second', '2000-01-01T00:00:04.000Z', secondTurnId))
      + line({ ...answer, timestamp: '2000-01-01T00:00:05.000Z' })
      + line({
        ...taskComplete(),
        timestamp: '2000-01-01T00:00:06.000Z',
        payload: { ...taskComplete().payload, turn_id: secondTurnId },
      }));
    expect(drainTraexRollout(path, first.newOffset).events.at(-1)).toEqual(
      expect.objectContaining({ sourceTurnId: secondTurnId, text: '' }),
    );
  });

  it.each(['canonical-first', 'legacy-first'])(
    'keeps canonical commentary out of final recovery across assistant mirrors: %s', (order) => {
      const agent = {
        type: 'AgentMessage', id: 'mirrored-commentary', phase: 'commentary',
        content: [{ type: 'Text', text: 'still working' }],
      };
      const canonical = canonicalCompletion(agent);
      const legacy = itemCompleted(agent);
      const records = order === 'canonical-first' ? [canonical, legacy] : [legacy, canonical];
      writeFileSync(path, line(user('work')) + records.map(line).join('') + line(taskComplete()));
      expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(
        expect.objectContaining({ kind: 'assistant_final', text: '' }),
      );
    },
  );

  it('preserves canonical final recovery when a delayed user mirror binds the turn', () => {
    writeFileSync(path, line(user('delayed input'))
      + line(canonicalCompletion({
        type: 'AgentMessage', id: 'answer-before-mirror', phase: 'final_answer',
        content: [{ type: 'Text', text: 'preserved answer' }],
      }, '2000-01-01T00:00:02.000Z')));
    const first = drainTraexRollout(path, 0);
    appendFileSync(path, line(canonicalCompletion({
      type: 'UserMessage', id: 'delayed-user-mirror',
      content: [{ type: 'text', text: 'delayed input' }],
    }, '2000-01-01T00:00:02.500Z')) + line(taskComplete()));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([
      expect.objectContaining({ kind: 'turn_bind' }),
      expect.objectContaining({ kind: 'assistant_final', text: 'preserved answer' }),
    ]);
  });

  it('does not let a replayed terminal consume the next legacy answer', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000010';
    const secondTurnId = '00000000-0000-7000-8000-000000000012';
    writeFileSync(path, line(user('first', undefined, firstTurnId)) + line(taskComplete('first answer')));
    const first = drainTraexRollout(path, 0);
    appendFileSync(path, line(user('second', '2000-01-01T00:00:04.000Z'))
      + line(agentMessage('second answer', 'final_answer')));
    const second = drainTraexRollout(path, first.newOffset);
    appendFileSync(path, line(taskComplete())
      + line({ ...taskComplete(), payload: { ...taskComplete().payload, turn_id: secondTurnId } }));
    const finals = drainTraexRollout(path, second.newOffset).events;
    expect(finals).toEqual([
      expect.objectContaining({ sourceTurnId: firstTurnId, text: '' }),
      expect.objectContaining({ sourceTurnId: secondTurnId, text: 'second answer' }),
    ]);
  });

  it('attributes idless assistant messages to the latest accepted native input', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000010';
    const secondTurnId = '00000000-0000-7000-8000-000000000013';
    writeFileSync(path, line(user('first', undefined, firstTurnId))
      + line(user('second', '2000-01-01T00:00:02.000Z', secondTurnId))
      + line(agentMessageNoPhase('second answer'))
      + line(taskComplete())
      + line({ ...taskComplete(), payload: { ...taskComplete().payload, turn_id: secondTurnId } }));
    expect(drainTraexRollout(path, 0).events.filter(event => event.kind === 'assistant_final')).toEqual([
      expect.objectContaining({ sourceTurnId: firstTurnId, text: '' }),
      expect.objectContaining({ sourceTurnId: secondTurnId, text: 'second answer' }),
    ]);
  });

  it.each(['canonical-first', 'legacy-first'])(
    'keeps canonical phase authority over a phase-less same-ID mirror: %s', (order) => {
      const agent = {
        type: 'AgentMessage', id: 'phase-authority', phase: 'commentary',
        content: [{ type: 'Text', text: 'still working' }],
      };
      const { phase, ...phaseLessAgent } = agent;
      const canonical = canonicalCompletion(agent);
      const legacy = itemCompleted(phaseLessAgent);
      const records = order === 'canonical-first' ? [canonical, legacy] : [legacy, canonical];
      writeFileSync(path, line(user('work')) + line(records[0]));
      const first = drainTraexRollout(path, 0);
      appendFileSync(path, line(records[1]) + line(taskComplete()));
      expect(drainTraexRollout(path, first.newOffset).events.at(-1)).toEqual(
        expect.objectContaining({ kind: 'assistant_final', text: '' }),
      );
    },
  );

  it('retains unrelated phase-less answers when a commentary mirror is classified', () => {
    const candidate = itemCompleted({
      type: 'AgentMessage', id: 'real-candidate',
      content: [{ type: 'Text', text: 'candidate answer' }],
    });
    const mirror = itemCompleted({
      type: 'AgentMessage', id: 'commentary-candidate',
      content: [{ type: 'Text', text: 'still working' }],
    });
    const canonical = canonicalCompletion({ ...mirror.payload.item, phase: 'commentary' });
    writeFileSync(path, line(user('work')) + line(candidate) + line(mirror)
      + line(canonical) + line(taskComplete()));
    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(
      expect.objectContaining({ text: 'candidate answer' }),
    );
  });

  it.each(['canonical', 'legacy'])('recovers mirrored input on a same-offset replay: %s', (dialect) => {
    const input = {
      type: 'UserMessage', id: 'replay-user',
      content: [{ type: 'text', text: 'replay work' }],
    };
    const mirror = dialect === 'canonical' ? canonicalCompletion(input) : itemCompleted(input);
    writeFileSync(path, line(user('replay work')) + line(mirror)
      + line(agentMessage('early answer', 'final_answer')));
    const queue = new CodexBridgeQueue();
    queue.mark('remote-replay', 'replay work', 0);
    const first = drainTraexRollout(path, 0);
    queue.ingest(first.events);
    queue.ingest(drainTraexRollout(path, 0).events);
    appendFileSync(path, line(agentMessage('latest answer', 'final_answer')) + line(taskComplete()));
    queue.ingest(drainTraexRollout(path, first.newOffset).events);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'remote-replay', finalText: 'latest answer' }),
    ]);
    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(
      expect.objectContaining({ text: 'latest answer' }),
    );
  });

  it('preserves same-message phase classification while binding assistant buckets', () => {
    const agent = {
      type: 'AgentMessage', id: 'bound-commentary',
      content: [{ type: 'Text', text: 'still working' }],
    };
    const legacyAgent = {
      ...itemCompleted({ ...agent, phase: 'commentary' }),
      payload: { ...itemCompleted(agent).payload, turn_id: undefined, item: { ...agent, phase: 'commentary' } },
    };
    writeFileSync(path, line(user('bind work'))
      + line(itemCompleted(agent)) + line(legacyAgent));
    const first = drainTraexRollout(path, 0);
    appendFileSync(path, line(canonicalCompletion({
      type: 'UserMessage', id: 'bound-user',
      content: [{ type: 'text', text: 'bind work' }],
    })) + line(taskComplete()));
    expect(drainTraexRollout(path, first.newOffset).events.at(-1)).toEqual(
      expect.objectContaining({ text: '' }),
    );
  });

  it.each(['canonical-first', 'legacy-first'])('deduplicates canonical and legacy mirrors: %s', (order) => {
    const input = itemCompleted({
      type: 'UserMessage', id: 'mirrored-user',
      content: [{ type: 'text', text: 'same input' }],
    });
    const canonical = canonicalCompletion(input.payload.item);
    const records = order === 'canonical-first' ? [canonical, input] : [input, canonical];
    writeFileSync(path, line(records[0]));
    const first = drainTraexRollout(path, 0);
    appendFileSync(path, line(records[1]) + line(taskComplete('done')));
    const second = drainTraexRollout(path, first.newOffset);
    const events = [...first.events, ...second.events];
    expect(events.filter(event => event.kind === 'user')).toHaveLength(1);
    const queue = new CodexBridgeQueue();
    queue.mark('remote', 'same input', Date.parse(input.timestamp) - 1);
    queue.ingest(events);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'remote', finalText: 'done' }),
    ]);
  });

  it('ingests TraeX 0.208 display_completions as user and agent item mirrors', () => {
    const turnId = '00000000-0000-7000-8000-000000000208';
    writeFileSync(path, [
      line(historyDisplayCompletion({
        type: 'UserMessage',
        id: 'msg-user-208',
        content: [{ type: 'text', text: '0.208 submitted prompt' }],
      }, turnId)),
      line(historyDisplayCompletion({
        type: 'AgentMessage',
        id: 'msg-agent-208',
        content: [{ type: 'Text', text: 'BOTMUX_NOTHING_TO_SEND' }],
      }, turnId, '2000-01-01T00:00:02.000Z')),
      line({
        ...taskComplete(),
        payload: { ...taskComplete().payload, turn_id: turnId },
      }),
    ].join(''));

    expect(drainTraexRollout(path, 0).events).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: '0.208 submitted prompt',
        sourceTurnId: turnId,
      }),
      expect.objectContaining({
        kind: 'assistant_final',
        text: 'BOTMUX_NOTHING_TO_SEND',
        sourceTurnId: turnId,
      }),
    ]);
  });

  it('does not double-count a 0.208 display completion and legacy item mirror', () => {
    const turnId = '00000000-0000-7000-8000-000000000209';
    const item = {
      type: 'UserMessage',
      id: 'msg-user-209',
      content: [{ type: 'text', text: 'same 0.208 turn' }],
    };
    writeFileSync(path, [
      line(historyDisplayCompletion(item, turnId)),
      line(itemCompleted(item, turnId, '2000-01-01T00:00:01.001Z')),
      line({
        ...taskComplete('done'),
        payload: { ...taskComplete('done').payload, turn_id: turnId },
      }),
    ].join(''));

    const events = drainTraexRollout(path, 0).events;
    expect(events.filter(event => event.kind === 'user')).toHaveLength(1);
    expect(events.filter(event => event.kind === 'assistant_final')).toHaveLength(1);
  });

  it.each(['wrong-thread', 'wrong-turn', 'non-append', 'unknown-item'])(
    'rejects unrelated canonical display completions: %s', (invalid) => {
      const mutation = canonicalCompletion({
        type: invalid === 'unknown-item' ? 'Reasoning' : 'UserMessage',
        id: 'unrelated',
        content: [{ type: 'text', text: 'must not start a turn' }],
      });
      const completion = mutation.payload.display_completions[0];
      if (invalid === 'wrong-thread') completion.thread_id = 'other-session';
      if (invalid === 'wrong-turn') completion.turn_id = 'other-turn';
      if (invalid === 'non-append') mutation.payload.operation = 'replace';
      writeFileSync(path, line(mutation));
      expect(drainTraexRollout(path, 0).events.filter(event => event.kind === 'user')).toEqual([]);
    },
  );

  it('does not parse a partially persisted canonical completion', () => {
    const mutation = line(canonicalCompletion({
      type: 'UserMessage', id: 'partial-user',
      content: [{ type: 'text', text: 'complete input' }],
    }));
    writeFileSync(path, mutation.slice(0, -1));
    const incomplete = drainTraexRollout(path, 0);
    expect(incomplete.events).toEqual([]);
    expect(incomplete.newOffset).toBe(0);
    appendFileSync(path, '\n');
    expect(drainTraexRollout(path, incomplete.newOffset).events).toEqual([
      expect.objectContaining({ kind: 'user', text: 'complete input' }),
    ]);
  });

  it('processes canonical input before tools in the same mutation', () => {
    const mutation = canonicalCompletion({
      type: 'UserMessage', id: 'user-with-tool',
      content: [{ type: 'text', text: 'execute task' }],
    });
    const payload = {
      ...mutation.payload,
      items: [{ type: 'function_call', call_id: 'canonical-tool', name: 'exec_command', arguments: '{}' }],
    };
    writeFileSync(path, line({ ...mutation, payload }) + line(taskComplete('tool completed')));
    const events = drainTraexRollout(path, 0).events;
    expect(events.map(event => event.kind)).toEqual(['user', 'cot', 'assistant_final']);
    const queue = new CodexBridgeQueue();
    const observed: string[] = [];
    queue.setCotObserver(entries => observed.push(...entries.map(entry => entry.kind)));
    queue.mark('remote-tool', 'execute task', Date.parse(mutation.timestamp) - 1);
    queue.ingest(events);
    expect(observed).toEqual(['tool_call']);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'remote-tool', finalText: 'tool completed' }),
    ]);
  });

  it('emits TraeX reasoning and tool calls/results as ordered CoT events', () => {
    const longOutput = `done\n${'x'.repeat(900)}`;
    writeFileSync(path, [
      line(user('inspect it')),
      line(historyAppend([
        {
          type: 'reasoning',
          id: 'rs_1',
          summary: [{ type: 'summary_text', text: 'Inspect the repository' }],
          content: [{ type: 'reasoning_text', text: 'private raw fallback' }],
        },
        {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'call_1',
          name: 'exec',
          arguments: JSON.stringify({ command: ['bash', '-lc', 'rg --files src'] }),
        },
        {
          type: 'function_call_output',
          id: 'fco_1',
          call_id: 'call_1',
          output: [
            { type: 'input_text', text: 'Script completed\n' },
            { type: 'input_text', text: longOutput },
            { type: 'image_url', image_url: 'data:image/png;base64,ignored' },
          ],
        },
        {
          type: 'custom_tool_call',
          id: 'fc_2',
          call_id: 'call_2',
          name: 'apply_patch',
          input: '*** Begin Patch\n*** Update File: src/a.ts\n',
        },
        {
          type: 'custom_tool_call_output',
          id: 'fco_2',
          call_id: 'call_2',
          output: [{ type: 'output_text', text: 'Done!' }],
        },
      ])),
      line(taskComplete('done')),
    ].join(''));

    const result = drainTraexRollout(path, 0);
    expect(result.events.map(event => event.kind)).toEqual([
      'user',
      'cot',
      'assistant_final',
    ]);
    expect(result.events[1].cotEntries).toEqual([
      { kind: 'thinking', text: 'Inspect the repository' },
      {
        kind: 'tool_call',
        id: 'call_1',
        name: 'exec',
        args: JSON.stringify({ command: ['bash', '-lc', 'rg --files src'] }),
        subject: 'rg --files src',
      },
      {
        kind: 'tool_result',
        id: 'call_1',
        result: expect.stringMatching(/^Script completed\ndone\n.*…$/),
      },
      {
        kind: 'tool_call',
        id: 'call_2',
        name: 'apply_patch',
        args: '*** Begin Patch\n*** Update File: src/a.ts\n',
        subject: 'src/a.ts',
      },
      { kind: 'tool_result', id: 'call_2', result: 'Done!' },
    ]);
    expect(result.events[1].cotEntries?.[2]).toMatchObject({
      kind: 'tool_result',
      result: expect.stringMatching(/^.{800}…$/s),
    });
  });

  it.each(
    ['legacy', 'canonical'].flatMap(dialect =>
      ['Text', 'text', 'output_text'].flatMap(blockType =>
        (['send', 'transcript'] as const).map(mode => ({ dialect, blockType, mode })))),
  )('preserves normal Markdown output: $dialect / $blockType / $mode', ({ dialect, blockType, mode }) => {
    const answer = '# Result\n\n| Key | Value |\n| --- | --- |\n| status | OK |\n\n```ts\nconst value = "✓";\n```\n';
    const input = {
      type: 'UserMessage', id: 'normal-user',
      content: [{ type: 'text', text: 'format the result' }],
    };
    const assistant = {
      type: 'AgentMessage', id: 'normal-answer', phase: 'final_answer',
      content: [{ type: blockType, text: answer }],
    };
    const inputRecord = dialect === 'canonical' ? canonicalCompletion(input) : itemCompleted(input);
    const answerRecord = dialect === 'canonical' ? canonicalCompletion(assistant) : itemCompleted(assistant);
    writeFileSync(path, line(inputRecord) + line(answerRecord) + line(taskComplete()));
    const queue = new CodexBridgeQueue();
    queue.mark('normal-turn', 'format the result', 0);
    const events = drainTraexRollout(path, 0).events;
    queue.ingest(events);
    const ready = queue.drainEmittable();
    expect(ready).toEqual([
      expect.objectContaining({ turnId: 'normal-turn', finalText: answer }),
    ]);
    expect(structuredFallbackKind(ready[0], undefined, [], false, false, mode)).toBe('final');
    expect(bridgePostText(ready[0].finalText ?? '', false)).toBe(answer);
    queue.ingest(events);
    expect(queue.drainEmittable()).toEqual([]);
  });

  it.each(['legacy', 'canonical'])('normalizes thinking and tool outputs once: %s', dialect => {
    const reasoning = {
      type: 'reasoning', id: 'output-reasoning',
      summary: [{ type: 'summary_text', text: 'Inspect inputs' }, { type: 'summary_text', text: 'Compare results' }],
    };
    const input = {
      type: 'UserMessage', id: 'output-user',
      content: [{ type: 'text', text: 'inspect outputs' }],
    };
    const toolItems = [
      { type: 'function_call', call_id: 'output-tool', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
      {
        type: 'function_call_output', call_id: 'output-tool',
        output: dialect === 'canonical' ? 'first line\nsecond line\n' : [
          { type: 'input_text', text: 'first line\n' }, { type: 'output_text', text: 'second line\n' },
        ],
      },
    ];
    const mutation = dialect === 'canonical'
      ? {
          ...canonicalCompletion({
            type: 'Reasoning', id: reasoning.id,
            summary_text: ['Inspect inputs', 'Compare results'], raw_content: [],
          }),
          payload: {
            ...canonicalCompletion({
              type: 'Reasoning', id: reasoning.id,
              summary_text: ['Inspect inputs', 'Compare results'], raw_content: [],
            }).payload,
            items: [{ ...reasoning, summary: [] }, ...toolItems],
          },
        }
      : historyAppend([reasoning, ...toolItems]);
    writeFileSync(path, line(dialect === 'canonical' ? canonicalCompletion(input) : itemCompleted(input))
      + line(mutation) + line(taskComplete('done')));
    const observed: unknown[] = [];
    const queue = new CodexBridgeQueue();
    queue.setCotObserver(entries => observed.push(...entries));
    queue.mark('output-turn', 'inspect outputs', 0);
    const events = drainTraexRollout(path, 0).events;
    queue.ingest(events);
    queue.ingest(events);
    expect(observed).toEqual([
      { kind: 'thinking', text: 'Inspect inputs\n\nCompare results' },
      { kind: 'tool_call', id: 'output-tool', name: 'exec_command', args: '{"cmd":"pwd"}', subject: 'pwd' },
      { kind: 'tool_result', id: 'output-tool', result: 'first line\nsecond line\n' },
    ]);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'output-turn', finalText: 'done' }),
    ]);
  });

  it('accepts display-only thinking without duplicating its raw mirror', () => {
    const display = {
      type: 'Reasoning', id: 'display-thinking', summary_text: ['Visible summary'], raw_content: [],
    };
    const mutation = canonicalCompletion(display);
    writeFileSync(path, line(mutation));
    expect(drainTraexRollout(path, 0).events.flatMap(event => event.cotEntries ?? [])).toEqual([
      { kind: 'thinking', text: 'Visible summary' },
    ]);
    const mirrored = {
      ...mutation,
      payload: {
        ...mutation.payload,
        items: [{
          type: 'reasoning', id: display.id,
          summary: [{ type: 'summary_text', text: 'Visible summary' }],
        }],
      },
    };
    writeFileSync(path, line(mirrored));
    expect(drainTraexRollout(path, 0).events.flatMap(event => event.cotEntries ?? [])).toEqual([
      { kind: 'thinking', text: 'Visible summary' },
    ]);
  });

  it.each([
    { ids: ['first'], expected: ['First', 'Second', 'Third', 'tool_call'] },
    { ids: ['second'], expected: ['First', 'Second', 'Third', 'tool_call'] },
    { ids: ['first', 'third'], expected: ['First', 'Second', 'Third', 'tool_call'] },
    { ids: [], expected: ['First', 'Second', 'Third', 'tool_call'] },
  ])('preserves mixed reasoning order with model anchors $ids', ({ ids, expected }) => {
    const summaries = [
      { id: 'first', text: 'First' },
      { id: 'second', text: 'Second' },
      { id: 'third', text: 'Third' },
    ];
    const mutation = canonicalCompletion({
      type: 'Reasoning', id: 'first', summary_text: ['First'], raw_content: [],
    });
    writeFileSync(path, line({
      ...mutation,
      payload: {
        ...mutation.payload,
        display_completions: summaries.map(({ id, text }) => ({
          ...mutation.payload.display_completions[0],
          item: { type: 'Reasoning', id, summary_text: [text], raw_content: [] },
        })),
        items: [
          ...ids.map(id => ({ type: 'reasoning', id, summary: [] })),
          { type: 'function_call', call_id: 'ordered-tool', name: 'exec_command', arguments: '{}' },
        ],
      },
    }));
    const entries = drainTraexRollout(path, 0).events.flatMap(event => event.cotEntries ?? []);
    expect(entries.map(entry => entry.kind === 'thinking' ? entry.text : entry.kind)).toEqual(expected);
  });

  it('preserves a legacy reasoning summary when its canonical mirror has only raw content', () => {
    const mutation = canonicalCompletion({
      type: 'Reasoning', id: 'summary-priority', summary_text: [], raw_content: ['Raw fallback'],
    });
    writeFileSync(path, line({
      ...mutation,
      payload: {
        ...mutation.payload,
        items: [{
          type: 'reasoning', id: 'summary-priority',
          summary: [{ type: 'summary_text', text: 'Visible summary' }],
          content: [{ type: 'reasoning_text', text: 'Raw fallback' }],
        }],
      },
    }));
    expect(drainTraexRollout(path, 0).events.flatMap(event => event.cotEntries ?? [])).toEqual([
      { kind: 'thinking', text: 'Visible summary' },
    ]);
  });

  it('reads canonical reasoning when the mutation contains no model items', () => {
    const mutation = canonicalCompletion({
      type: 'Reasoning', id: 'no-model-items', summary_text: ['Visible summary'], raw_content: [],
    });
    const { items, ...payload } = mutation.payload;
    writeFileSync(path, line({ ...mutation, payload }));
    expect(drainTraexRollout(path, 0).events.flatMap(event => event.cotEntries ?? [])).toEqual([
      { kind: 'thinking', text: 'Visible summary' },
    ]);
  });

  it.each(['foreign-session', 'foreign-turn'])('keeps unrelated display reasoning out of tool output: %s', invalid => {
    const mutation = canonicalCompletion({
      type: 'Reasoning', id: 'unrelated-summary', summary_text: ['Unrelated summary'], raw_content: [],
    });
    const completion = mutation.payload.display_completions[0];
    if (invalid === 'foreign-session') completion.thread_id = 'other-session';
    else completion.turn_id = 'other-turn';
    writeFileSync(path, line(mutation));
    expect(drainTraexRollout(path, 0).events).toEqual([]);
  });

  it('prefers canonical summary text and keeps reasoning probes side-effect free', () => {
    const mutation = canonicalCompletion({
      type: 'Reasoning', id: 'summary-blocks',
      summary_text: ['Visible summary', null, 123, '', 'Second paragraph'],
      raw_content: ['Raw fallback'],
    });
    writeFileSync(path, line(mutation));
    expect(drainTraexRollout(path, 0, { probe: true }).events).toEqual([]);
    const result = drainTraexRollout(path, 0);
    expect(result.events.flatMap(event => event.cotEntries ?? [])).toEqual([
      { kind: 'thinking', text: 'Visible summary\n\nSecond paragraph' },
    ]);
    expect(drainTraexRollout(path, result.newOffset).events).toEqual([]);
  });

  it('closes tool calls whose output has no displayable text', () => {
    writeFileSync(path, line(historyAppend([
      { type: 'function_call_output', call_id: 'image', output: [{ type: 'input_image', image_url: 'data:image/png;base64,hidden' }] },
      { type: 'function_call_output', call_id: 'unknown', output: [{ type: 'future_block', value: 'hidden' }] },
      { type: 'function_call_output', call_id: 'empty-array', output: [] },
      { type: 'function_call_output', call_id: 'scalar', output: 'plain text' },
    ])));

    expect(drainTraexRollout(path, 0).events[0].cotEntries).toEqual([
      { kind: 'tool_result', id: 'image', result: '' },
      { kind: 'tool_result', id: 'unknown', result: '' },
      { kind: 'tool_result', id: 'empty-array', result: '' },
      { kind: 'tool_result', id: 'scalar', result: 'plain text' },
    ]);
  });

  it('ignores replacement history and diagnostic mirrors to avoid replaying or duplicating CoT', () => {
    const reasoning = {
      type: 'reasoning',
      id: 'rs_old',
      summary: [],
      content: [{ type: 'reasoning_text', text: 'historical reasoning' }],
    };
    writeFileSync(path, [
      line(user('inspect it')),
      line({
        ...historyAppend([reasoning]),
        payload: { ...historyAppend([reasoning]).payload, operation: 'replace' },
      }),
      line({
        timestamp: '2000-01-01T00:00:02.000Z',
        type: 'event_msg',
        payload: { type: 'agent_reasoning_raw_content', text: 'diagnostic mirror' },
      }),
      line({
        timestamp: '2000-01-01T00:00:02.500Z',
        type: 'event_msg',
        payload: { type: 'exec_command_end', call_id: 'call_1', command: ['pwd'], status: 'completed' },
      }),
      line(taskComplete('done')),
    ].join(''));

    const result = drainTraexRollout(path, 0);
    expect(result.events.map(event => event.kind)).toEqual(['user', 'assistant_final']);
  });

  it('keeps submit-confirmation probes free of cosmetic CoT events', () => {
    writeFileSync(path, [
      line(historyAppend([{
        type: 'reasoning',
        id: 'rs_1',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'not needed by the probe' }],
      }])),
      line(user('confirm me')),
    ].join(''));

    expect(drainTraexRollout(path, 0, { probe: true }).events).toEqual([
      expect.objectContaining({ kind: 'user', text: 'confirm me' }),
    ]);
  });

  it('reports the latest complete turn_context model and reasoning effort', () => {
    writeFileSync(path, [
      line({
        type: 'turn_context',
        payload: {
          model: 'GPT-5.5',
          collaboration_mode: { settings: { reasoning_effort: 'high' } },
        },
      }),
      line(user('switch model')),
      line({
        type: 'turn_context',
        payload: {
          model: 'GPT-5.6-Sol',
          collaboration_mode: { settings: { reasoning_effort: 'xhigh' } },
        },
      }),
      line(taskComplete('done')),
    ].join(''));

    const result = drainTraexRollout(path, 0);
    expect(result.latestModel).toBe('GPT-5.6-Sol');
    expect(result.latestReasoningEffort).toBe('xhigh');
    expect(readLatestTraexRuntime(path)).toEqual({
      model: 'GPT-5.6-Sol',
      reasoningEffort: 'xhigh',
    });
  });

  it('ignores model-like non-turn_context records during incremental drain', () => {
    writeFileSync(path, [
      line({
        type: 'turn_context',
        payload: { model: 'parent-model', reasoning_effort: 'ultra' },
      }),
      line({
        type: 'event_msg',
        payload: {
          type: 'collab_agent_spawn_end',
          model: 'subagent-model',
          reasoning_effort: 'medium',
        },
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          model: 'message-model',
          effort: 'low',
        },
      }),
    ].join(''));

    const result = drainTraexRollout(path, 0);
    expect(result.latestModel).toBe('parent-model');
    expect(result.latestReasoningEffort).toBe('ultra');
  });

  it('ignores model-like non-turn_context records during backward runtime scan', () => {
    writeFileSync(path, [
      line({
        type: 'turn_context',
        payload: { model: 'parent-model', reasoning_effort: 'ultra' },
      }),
      line({
        type: 'event_msg',
        payload: {
          type: 'collab_agent_spawn_end',
          model: 'subagent-model',
          reasoning_effort: 'medium',
        },
      }),
      line({
        type: 'response_item',
        payload: {
          type: 'message',
          model: 'message-model',
          effort: 'low',
        },
      }),
    ].join(''));

    expect(readLatestTraexRuntime(path)).toEqual({
      model: 'parent-model',
      reasoningEffort: 'ultra',
    });
  });

  it('ignores a partial trailing model record until it is complete', () => {
    writeFileSync(path, line({ type: 'turn_context', payload: { model: 'stable-model' } }));
    appendFileSync(path, JSON.stringify({
      type: 'turn_context',
      payload: { model: 'partial-model' },
    }).slice(0, -4));

    expect(drainTraexRollout(path, 0).latestModel).toBe('stable-model');
    expect(readLatestTraexRuntime(path)).toEqual({ model: 'stable-model' });
  });

  it('readLatestTraexRuntime resolves model and effort from independent latest records (backward scan)', () => {
    // /model then /effort switched in separate turns — each field is
    // latest-wins independently, so the newest of EACH must win even though
    // they live on different lines.
    writeFileSync(path, [
      line({ type: 'turn_context', payload: { model: 'old-model', reasoning_effort: 'low' } }),
      line(user('/model new')),
      line({ type: 'turn_context', payload: { model: 'new-model' } }),
      line(user('/effort high')),
      line({ type: 'turn_context', payload: { reasoning_effort: 'high' } }),
      line(taskComplete('done')),
    ].join(''));

    expect(readLatestTraexRuntime(path)).toEqual({
      model: 'new-model',
      reasoningEffort: 'high',
    });
  });

  it('readLatestTraexRuntime finds the runtime when the only record is the first line (offset 0)', () => {
    writeFileSync(path, line({ type: 'turn_context', payload: { model: 'solo-model' } }));
    expect(readLatestTraexRuntime(path)).toEqual({ model: 'solo-model' });
  });

  it('readLatestTraexRuntime scans back across a large transcript to the newest tail record', () => {
    const filler = Array.from({ length: 2000 }, (_, i) =>
      line(assistantProgress(`tool commentary chunk ${i} ${'x'.repeat(200)}`)),
    ).join('');
    writeFileSync(path, [
      line({ type: 'turn_context', payload: { model: 'stale', reasoning_effort: 'low' } }),
      filler,
      line({ type: 'turn_context', payload: { model: 'fresh-tail', reasoning_effort: 'xhigh' } }),
      line(taskComplete('done')),
    ].join(''));

    expect(readLatestTraexRuntime(path)).toEqual({
      model: 'fresh-tail',
      reasoningEffort: 'xhigh',
    });
  });

  it('uses task_complete as the terminal and ignores phase-less assistant progress', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(assistantProgress('intermediate tool commentary')),
      line(assistantProgress('final-looking but still not a boundary')),
      line(taskComplete('durable final answer')),
    ].join(''));

    const result = drainTraexRollout(path, 0);
    expect(result.events).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: 'do the work',
        sourceSessionId: SID,
      }),
      expect.objectContaining({
        kind: 'assistant_final',
        text: 'durable final answer',
        sourceSessionId: SID,
      }),
    ]);
  });

  it('closes a TraeX 0.201.4 item_completed user turn in adopt mode', () => {
    // Production change that must fail this test: stop accepting the explicit
    // UserMessage item_completed shape emitted by TraeX 0.201.4.
    const turnId = '00000000-0000-7000-8000-000000000111';
    writeFileSync(path, [
      line({
        timestamp: '2000-01-01T00:00:00.999Z',
        type: 'history_mutation',
        payload: {
          turn_id: turnId,
          operation: 'append',
          items: [{
            type: 'message',
            id: 'msg-user',
            role: 'user',
            content: [{ type: 'input_text', text: 'probe from adopted terminal' }],
          }],
        },
      }),
      line(itemCompleted({
        type: 'UserMessage',
        id: 'msg-user',
        content: [{ type: 'text', text: 'probe from adopted terminal' }],
      }, turnId)),
      line(itemCompleted({
        type: 'AgentMessage',
        id: 'msg-agent',
        content: [{ type: 'Text', text: 'tool progress must not start a turn' }],
      }, turnId, '2000-01-01T00:00:02.000Z')),
      line({
        timestamp: '2000-01-01T00:00:03.000Z',
        type: 'event_msg',
        payload: {
          type: 'task_complete',
          turn_id: turnId,
          last_agent_message: 'delivered final',
        },
      }),
    ].join(''));

    const queue = new CodexBridgeQueue();
    queue.setLocalTurns(true, 0);
    queue.ingest(drainTraexRollout(path, 0, { adoptMode: true }).events);

    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({
        isLocal: true,
        userText: 'probe from adopted terminal',
        finalText: 'delivered final',
      }),
    ]);
  });

  it('does not double-count mixed user_message and item_completed dialects for one turn', () => {
    const turnId = '00000000-0000-7000-8000-000000000112';
    writeFileSync(path, [
      line({
        timestamp: '2000-01-01T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', turn_id: turnId, message: 'same turn' },
      }),
      line(itemCompleted({
        type: 'UserMessage',
        id: 'msg-user',
        content: [{ type: 'text', text: 'same turn' }],
      }, turnId, '2000-01-01T00:00:01.001Z')),
      line(taskComplete('done')),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.filter(event => event.kind === 'user')).toHaveLength(1);
  });

  it('does not double-count a legacy user_message without turn_id before its item_completed mirror', () => {
    const turnId = '00000000-0000-7000-8000-000000000116';
    writeFileSync(path, [
      line({
        timestamp: '2000-01-01T00:00:01.000Z',
        type: 'event_msg',
        payload: { type: 'user_message', message: 'legacy mirror has no turn id' },
      }),
      line(itemCompleted({
        type: 'UserMessage',
        id: 'msg-user',
        content: [{ type: 'text', text: 'legacy mirror has no turn id' }],
      }, turnId, '2000-01-01T00:00:01.001Z')),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.filter(event => event.kind === 'user')).toHaveLength(1);
  });

  it('does not let an item-first legacy mirror cross a drain and steal the next pending turn', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000117';
    const secondTurnId = '00000000-0000-7000-8000-000000000118';
    writeFileSync(path, line(itemCompleted({
      type: 'UserMessage', id: 'msg-first', content: [{ type: 'text', text: 'same queued prompt' }],
    }, firstTurnId)));

    const queue = new CodexBridgeQueue();
    const observed: Array<{ turnId: string; text: string }> = [];
    queue.setCotObserver((entries, turn) => {
      for (const entry of entries) {
        if (entry.kind === 'thinking') observed.push({ turnId: turn.turnId, text: entry.text });
      }
    });
    queue.mark('d1', 'same queued prompt', 0);
    queue.mark('d2', 'same queued prompt', 0);

    const first = drainTraexRollout(path, 0);
    queue.ingest(first.events);
    appendFileSync(path, [
      line(user('same queued prompt', '2000-01-01T00:00:01.001Z')),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs_first', summary: [{ type: 'summary_text', text: 'cot-1' }], content: [],
        }], '2000-01-01T00:00:02.000Z'),
        payload: {
          ...historyAppend([]).payload,
          turn_id: firstTurnId,
          items: [{ type: 'reasoning', id: 'rs_first', summary: [{ type: 'summary_text', text: 'cot-1' }], content: [] }],
        },
      }),
      line({ ...taskComplete('answer-1'), payload: { ...taskComplete('answer-1').payload, turn_id: firstTurnId } }),
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-second', content: [{ type: 'text', text: 'same queued prompt' }],
      }, secondTurnId, '2000-01-01T00:00:04.000Z')),
      line({ ...taskComplete('answer-2'), payload: { ...taskComplete('answer-2').payload, turn_id: secondTurnId }, timestamp: '2000-01-01T00:00:05.000Z' }),
    ].join(''));

    queue.ingest(drainTraexRollout(path, first.newOffset).events);
    expect(observed).toEqual([{ turnId: 'd1', text: 'cot-1' }]);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'd1', finalText: 'answer-1', sourceTurnId: firstTurnId }),
      expect.objectContaining({ turnId: 'd2', finalText: 'answer-2', sourceTurnId: secondTurnId }),
    ]);
  });

  it('does not let a legacy-first item mirror cross a drain and steal the next pending turn', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000120';
    writeFileSync(path, line(user('same prompt', '2000-01-01T00:00:01.000Z')));

    const queue = new CodexBridgeQueue();
    const observed: Array<{ turnId: string; text: string }> = [];
    queue.setCotObserver((entries, turn) => {
      for (const entry of entries) {
        if (entry.kind === 'thinking') observed.push({ turnId: turn.turnId, text: entry.text });
      }
    });
    queue.mark('d1', 'same prompt', 0);
    queue.mark('d2', 'same prompt', 0);

    const first = drainTraexRollout(path, 0);
    expect(first.events).toEqual([
      expect.objectContaining({ kind: 'user', text: 'same prompt' }),
    ]);
    expect(first.events[0]).not.toHaveProperty('sourceTurnId');
    queue.ingest(first.events);
    appendFileSync(path, [
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-first', content: [{ type: 'text', text: 'same prompt' }],
      }, firstTurnId, '2000-01-01T00:00:01.100Z')),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs_first', summary: [{ type: 'summary_text', text: 'cot-1' }], content: [],
        }], '2000-01-01T00:00:02.000Z'),
        payload: {
          ...historyAppend([]).payload,
          turn_id: firstTurnId,
          items: [{ type: 'reasoning', id: 'rs_first', summary: [{ type: 'summary_text', text: 'cot-1' }], content: [] }],
        },
      }),
      line({ ...taskComplete('answer-1'), payload: { ...taskComplete('answer-1').payload, turn_id: firstTurnId } }),
    ].join(''));

    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events.filter(event => event.kind === 'user')).toEqual([]);
    expect(second.events).toContainEqual(expect.objectContaining({
      kind: 'turn_bind', sourceTurnId: firstTurnId,
    }));
    queue.ingest(second.events);
    expect(observed).toEqual([{ turnId: 'd1', text: 'cot-1' }]);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'd1', finalText: 'answer-1', sourceTurnId: firstTurnId }),
    ]);
    expect(queue.peek()).toEqual([expect.objectContaining({ turnId: 'd2', started: false })]);
  });

  it('binds a legacy-first mirror before a native-id type-ahead successor', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000125';
    const secondTurnId = '00000000-0000-7000-8000-000000000126';
    writeFileSync(path, line(user('first', '2000-01-01T00:00:01.000Z')));

    const queue = new CodexBridgeQueue();
    const observed: Array<{ turnId: string; text: string }> = [];
    queue.setCotObserver((entries, turn) => {
      for (const entry of entries) {
        if (entry.kind === 'thinking') observed.push({ turnId: turn.turnId, text: entry.text });
      }
    });
    queue.mark('d1', 'first', 0);
    queue.mark('d2', 'second', 0);
    const first = drainTraexRollout(path, 0);
    queue.ingest(first.events);

    appendFileSync(path, [
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-first', content: [{ type: 'text', text: 'first' }],
      }, firstTurnId, '2000-01-01T00:00:01.100Z')),
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-second', content: [{ type: 'text', text: 'second' }],
      }, secondTurnId, '2000-01-01T00:00:02.000Z')),
    ].join(''));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([
      expect.objectContaining({ kind: 'turn_bind', sourceTurnId: firstTurnId }),
      expect.objectContaining({ kind: 'user', text: 'second', sourceTurnId: secondTurnId }),
    ]);
    queue.ingest(second.events);

    appendFileSync(path, [
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [],
        }], '2000-01-01T00:00:03.000Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: firstTurnId,
          items: [{ type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [] }],
        },
      }),
      line({ ...taskComplete('answer-a'), payload: { ...taskComplete('answer-a').payload, turn_id: firstTurnId } }),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [],
        }], '2000-01-01T00:00:05.000Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: secondTurnId,
          items: [{ type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [] }],
        },
      }),
      line({
        ...taskComplete('answer-b'),
        payload: { ...taskComplete('answer-b').payload, turn_id: secondTurnId },
        timestamp: '2000-01-01T00:00:06.000Z',
      }),
    ].join(''));
    queue.ingest(drainTraexRollout(path, second.newOffset).events);

    expect(observed).toEqual([
      { turnId: 'd1', text: 'cot-a' },
      { turnId: 'd2', text: 'cot-b' },
    ]);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'd1', finalText: 'answer-a', sourceTurnId: firstTurnId }),
      expect.objectContaining({ turnId: 'd2', finalText: 'answer-b', sourceTurnId: secondTurnId }),
    ]);
  });

  it('preserves a legacy-first turn when its native-id successor arrives before its mirror', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000127';
    const secondTurnId = '00000000-0000-7000-8000-000000000128';
    writeFileSync(path, line(user('first', '2000-01-01T00:00:01.000Z')));

    const queue = new CodexBridgeQueue();
    const observed: Array<{ turnId: string; text: string }> = [];
    queue.setCotObserver((entries, turn) => {
      for (const entry of entries) {
        if (entry.kind === 'thinking') observed.push({ turnId: turn.turnId, text: entry.text });
      }
    });
    queue.mark('d1', 'first', 0);
    queue.mark('d2', 'second', 0);
    const first = drainTraexRollout(path, 0);
    queue.ingest(first.events);

    appendFileSync(path, line(itemCompleted({
      type: 'UserMessage', id: 'msg-second', content: [{ type: 'text', text: 'second' }],
    }, secondTurnId, '2000-01-01T00:00:02.000Z')));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([expect.objectContaining({
      kind: 'user', text: 'second', sourceTurnId: secondTurnId, preserveCollecting: true,
    })]);
    queue.ingest(second.events);

    appendFileSync(path, [
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-first', content: [{ type: 'text', text: 'first' }],
      }, firstTurnId, '2000-01-01T00:00:02.100Z')),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [],
        }], '2000-01-01T00:00:03.000Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: firstTurnId,
          items: [{ type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [] }],
        },
      }),
      line({ ...taskComplete('answer-a'), payload: { ...taskComplete('answer-a').payload, turn_id: firstTurnId } }),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [],
        }], '2000-01-01T00:00:05.000Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: secondTurnId,
          items: [{ type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [] }],
        },
      }),
      line({
        ...taskComplete('answer-b'),
        payload: { ...taskComplete('answer-b').payload, turn_id: secondTurnId },
        timestamp: '2000-01-01T00:00:06.000Z',
      }),
    ].join(''));
    const third = drainTraexRollout(path, second.newOffset);
    expect(third.events[0]).toEqual(expect.objectContaining({
      kind: 'turn_bind', sourceTurnId: firstTurnId,
    }));
    queue.ingest(third.events);

    expect(observed).toEqual([
      { turnId: 'd1', text: 'cot-a' },
      { turnId: 'd2', text: 'cot-b' },
    ]);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'd1', finalText: 'answer-a', sourceTurnId: firstTurnId }),
      expect.objectContaining({ turnId: 'd2', finalText: 'answer-b', sourceTurnId: secondTurnId }),
    ]);
  });

  it('preserves a legacy-first turn before a native-id legacy-dialect successor', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000129';
    const secondTurnId = '00000000-0000-7000-8000-000000000130';
    writeFileSync(path, line(user('first', '2000-01-01T00:00:01.000Z')));

    const queue = new CodexBridgeQueue();
    const observed: Array<{ turnId: string; text: string }> = [];
    queue.setCotObserver((entries, turn) => {
      for (const entry of entries) {
        if (entry.kind === 'thinking') observed.push({ turnId: turn.turnId, text: entry.text });
      }
    });
    queue.mark('d1', 'first', 0);
    queue.mark('d2', 'second', 0);
    const first = drainTraexRollout(path, 0);
    queue.ingest(first.events);

    appendFileSync(path, line(user(
      'second', '2000-01-01T00:00:02.000Z', secondTurnId,
    )));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([expect.objectContaining({
      kind: 'user', text: 'second', sourceTurnId: secondTurnId, preserveCollecting: true,
    })]);
    queue.ingest(second.events);

    appendFileSync(path, [
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-first', content: [{ type: 'text', text: 'first' }],
      }, firstTurnId, '2000-01-01T00:00:02.100Z')),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [],
        }], '2000-01-01T00:00:03.000Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: firstTurnId,
          items: [{ type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [] }],
        },
      }),
      line({ ...taskComplete('answer-a'), payload: { ...taskComplete('answer-a').payload, turn_id: firstTurnId } }),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [],
        }], '2000-01-01T00:00:05.000Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: secondTurnId,
          items: [{ type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [] }],
        },
      }),
      line({
        ...taskComplete('answer-b'),
        payload: { ...taskComplete('answer-b').payload, turn_id: secondTurnId },
        timestamp: '2000-01-01T00:00:06.000Z',
      }),
    ].join(''));
    const third = drainTraexRollout(path, second.newOffset);
    expect(third.events[0]).toEqual(expect.objectContaining({
      kind: 'turn_bind', sourceTurnId: firstTurnId,
    }));
    queue.ingest(third.events);

    expect(observed).toEqual([
      { turnId: 'd1', text: 'cot-a' },
      { turnId: 'd2', text: 'cot-b' },
    ]);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'd1', finalText: 'answer-a', sourceTurnId: firstTurnId }),
      expect.objectContaining({ turnId: 'd2', finalText: 'answer-b', sourceTurnId: secondTurnId }),
    ]);
  });

  it.each([
    {
      terminalName: 'task_complete',
      firstTerminal: (turnId: string) => ({
        ...taskComplete('answer-a'),
        payload: { ...taskComplete('answer-a').payload, turn_id: turnId },
      }),
      expectedStatus: 'completed',
      expectedText: 'answer-a',
    },
    {
      terminalName: 'turn_aborted',
      firstTerminal: (turnId: string) => ({
        ...turnAborted('interrupted'),
        payload: { ...turnAborted('interrupted').payload, turn_id: turnId },
      }),
      expectedStatus: 'ambiguous',
      expectedText: '',
    },
  ])('binds an id-less legacy predecessor from $terminalName when its item mirror never arrives', ({
    firstTerminal, expectedStatus, expectedText,
  }) => {
    const firstTurnId = '00000000-0000-7000-8000-000000000131';
    const secondTurnId = '00000000-0000-7000-8000-000000000132';
    writeFileSync(path, line(user('first', '2000-01-01T00:00:01.000Z')));

    const queue = new CodexBridgeQueue();
    const observed: Array<{ turnId: string; text: string }> = [];
    queue.setCotObserver((entries, turn) => {
      for (const entry of entries) {
        if (entry.kind === 'thinking') observed.push({ turnId: turn.turnId, text: entry.text });
      }
    });
    queue.mark('d1', 'first', 0);
    queue.mark('d2', 'second', 0);
    const first = drainTraexRollout(path, 0);
    queue.ingest(first.events);

    appendFileSync(path, line(user(
      'second', '2000-01-01T00:00:02.000Z', secondTurnId,
    )));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([expect.objectContaining({
      kind: 'user', text: 'second', sourceTurnId: secondTurnId, preserveCollecting: true,
    })]);
    queue.ingest(second.events);

    appendFileSync(path, [
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [],
        }], '2000-01-01T00:00:02.500Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: firstTurnId,
          items: [{ type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [] }],
        },
      }),
      line(firstTerminal(firstTurnId)),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [],
        }], '2000-01-01T00:00:03.500Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: secondTurnId,
          items: [{ type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [] }],
        },
      }),
      line({
        ...taskComplete('answer-b'),
        payload: { ...taskComplete('answer-b').payload, turn_id: secondTurnId },
        timestamp: '2000-01-01T00:00:04.000Z',
      }),
    ].join(''));
    const terminal = drainTraexRollout(path, second.newOffset);
    expect(terminal.events.slice(0, 3)).toEqual([
      expect.objectContaining({ kind: 'turn_bind', sourceTurnId: firstTurnId }),
      expect.objectContaining({ kind: 'cot', sourceTurnId: firstTurnId }),
      expect.objectContaining({
        kind: 'assistant_final', sourceTurnId: firstTurnId,
        ...(expectedStatus === 'completed' ? {} : { terminalStatus: expectedStatus }),
      }),
    ]);
    queue.ingest(terminal.events);

    expect(observed).toEqual([
      { turnId: 'd1', text: 'cot-a' },
      { turnId: 'd2', text: 'cot-b' },
    ]);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'd1', finalText: expectedText, sourceTurnId: firstTurnId,
        ...(expectedStatus === 'completed' ? {} : { terminalStatus: expectedStatus }),
      }),
      expect.objectContaining({
        turnId: 'd2', finalText: 'answer-b', sourceTurnId: secondTurnId,
      }),
    ]);
  });

  it('retains a preserved legacy predecessor beyond the mirror window across three type-ahead turns', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000141';
    const secondTurnId = '00000000-0000-7000-8000-000000000142';
    const thirdTurnId = '00000000-0000-7000-8000-000000000143';
    writeFileSync(path, line(user('first', '2000-01-01T00:00:01.000Z')));

    const queue = new CodexBridgeQueue();
    queue.mark('d1', 'first', 0);
    queue.mark('d2', 'second', 0);
    queue.mark('d3', 'third', 0);

    const first = drainTraexRollout(path, 0);
    queue.ingest(first.events);

    appendFileSync(path, line(user(
      'second', '2000-01-01T00:00:02.000Z', secondTurnId,
    )));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([expect.objectContaining({
      kind: 'user', sourceTurnId: secondTurnId, preserveCollecting: true,
    })]);
    queue.ingest(second.events);

    // This successor arrives after the ordinary 5-second mirror window. The
    // first turn is already preserved behind a native successor, so its
    // binding evidence must survive until the delayed terminal arrives.
    appendFileSync(path, line(user(
      'third', '2000-01-01T00:00:07.000Z', thirdTurnId,
    )));
    const third = drainTraexRollout(path, second.newOffset);
    expect(third.events).toEqual([expect.objectContaining({
      kind: 'user', sourceTurnId: thirdTurnId, preserveCollecting: true,
    })]);
    queue.ingest(third.events);

    appendFileSync(path, line({
      ...taskComplete('answer-2'),
      timestamp: '2000-01-01T00:00:08.000Z',
      payload: { ...taskComplete('answer-2').payload, turn_id: secondTurnId },
    }));
    const fourth = drainTraexRollout(path, third.newOffset);
    queue.ingest(fourth.events);

    appendFileSync(path, line({
      ...taskComplete('answer-3'),
      timestamp: '2000-01-01T00:00:09.000Z',
      payload: { ...taskComplete('answer-3').payload, turn_id: thirdTurnId },
    }));
    const fifth = drainTraexRollout(path, fourth.newOffset);
    queue.ingest(fifth.events);

    appendFileSync(path, line({
      ...taskComplete('answer-1'),
      timestamp: '2000-01-01T00:00:10.000Z',
      payload: { ...taskComplete('answer-1').payload, turn_id: firstTurnId },
    }));
    const sixth = drainTraexRollout(path, fifth.newOffset);
    expect(sixth.events).toEqual([
      expect.objectContaining({ kind: 'turn_bind', sourceTurnId: firstTurnId }),
      expect.objectContaining({ kind: 'assistant_final', sourceTurnId: firstTurnId }),
    ]);
    queue.ingest(sixth.events);

    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'd1', sourceTurnId: firstTurnId, finalText: 'answer-1' }),
      expect.objectContaining({ turnId: 'd2', sourceTurnId: secondTurnId, finalText: 'answer-2' }),
      expect.objectContaining({ turnId: 'd3', sourceTurnId: thirdTurnId, finalText: 'answer-3' }),
    ]);
  });

  it('keeps a delayed item mirror from duplicating a predecessor bound by CoT', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000133';
    const secondTurnId = '00000000-0000-7000-8000-000000000134';
    writeFileSync(path, line(user('first', '2000-01-01T00:00:01.000Z')));
    const queue = new CodexBridgeQueue();
    const observed: Array<{ turnId: string; text: string }> = [];
    queue.setCotObserver((entries, turn) => {
      for (const entry of entries) {
        if (entry.kind === 'thinking') observed.push({ turnId: turn.turnId, text: entry.text });
      }
    });
    queue.mark('d1', 'first', 0);
    queue.mark('d2', 'second', 0);
    const first = drainTraexRollout(path, 0);
    queue.ingest(first.events);

    appendFileSync(path, line(user('second', '2000-01-01T00:00:02.000Z', secondTurnId)));
    const second = drainTraexRollout(path, first.newOffset);
    queue.ingest(second.events);

    appendFileSync(path, [
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [],
        }], '2000-01-01T00:00:02.100Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: firstTurnId,
          items: [{ type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [] }],
        },
      }),
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-first', content: [{ type: 'text', text: 'first' }],
      }, firstTurnId, '2000-01-01T00:00:02.200Z')),
      line({ ...taskComplete('answer-a'), payload: { ...taskComplete('answer-a').payload, turn_id: firstTurnId } }),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [],
        }], '2000-01-01T00:00:04.000Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: secondTurnId,
          items: [{ type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [] }],
        },
      }),
      line({
        ...taskComplete('answer-b'),
        payload: { ...taskComplete('answer-b').payload, turn_id: secondTurnId },
        timestamp: '2000-01-01T00:00:05.000Z',
      }),
    ].join(''));
    const final = drainTraexRollout(path, second.newOffset);
    expect(final.events.filter(event => event.kind === 'user')).toEqual([]);
    expect(final.events.filter(event => event.kind === 'turn_bind')).toHaveLength(1);
    queue.ingest(final.events);

    expect(observed).toEqual([
      { turnId: 'd1', text: 'cot-a' },
      { turnId: 'd2', text: 'cot-b' },
    ]);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'd1', finalText: 'answer-a', sourceTurnId: firstTurnId }),
      expect.objectContaining({ turnId: 'd2', finalText: 'answer-b', sourceTurnId: secondTurnId }),
    ]);
  });

  it('expires an item-first mirror expectation at terminal before a same-text next turn', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000121';
    writeFileSync(path, line(itemCompleted({
      type: 'UserMessage', id: 'msg-first', content: [{ type: 'text', text: 'repeat' }],
    }, firstTurnId, '2000-01-01T00:00:01.000Z')));

    const queue = new CodexBridgeQueue();
    queue.mark('d1', 'repeat', 0);
    queue.mark('d2', 'repeat', 0);

    const first = drainTraexRollout(path, 0);
    queue.ingest(first.events);
    appendFileSync(path, line({
      ...taskComplete('answer-1'),
      payload: { ...taskComplete('answer-1').payload, turn_id: firstTurnId },
      timestamp: '2000-01-01T00:00:02.000Z',
    }));
    const terminal = drainTraexRollout(path, first.newOffset);
    queue.ingest(terminal.events);
    appendFileSync(path, line(user('repeat', '2000-01-01T00:00:03.000Z')));
    const next = drainTraexRollout(path, terminal.newOffset);
    queue.ingest(next.events);

    expect(first.events).toEqual([expect.objectContaining({
      kind: 'user', text: 'repeat', sourceTurnId: firstTurnId,
    })]);
    expect(terminal.events).toEqual([expect.objectContaining({
      kind: 'assistant_final', text: 'answer-1', sourceTurnId: firstTurnId,
    })]);
    expect(next.events).toEqual([expect.objectContaining({ kind: 'user', text: 'repeat' })]);
    expect(next.events[0]).not.toHaveProperty('sourceTurnId');
    expect(queue.drainEmittable()).toEqual([expect.objectContaining({
      turnId: 'd1', finalText: 'answer-1', sourceTurnId: firstTurnId,
    })]);
    expect(queue.peek()).toEqual([expect.objectContaining({ turnId: 'd2', started: true })]);
  });

  it('pairs repeated legacy-first mirrors FIFO within one drain', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000122';
    const secondTurnId = '00000000-0000-7000-8000-000000000123';
    writeFileSync(path, [
      line(user('same', '2000-01-01T00:00:01.000Z')),
      line(user('same', '2000-01-01T00:00:02.000Z')),
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-first', content: [{ type: 'text', text: 'same' }],
      }, firstTurnId, '2000-01-01T00:00:01.100Z')),
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-second', content: [{ type: 'text', text: 'same' }],
      }, secondTurnId, '2000-01-01T00:00:02.100Z')),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [],
        }], '2000-01-01T00:00:03.000Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: firstTurnId,
          items: [{ type: 'reasoning', id: 'rs-a', summary: [{ type: 'summary_text', text: 'cot-a' }], content: [] }],
        },
      }),
      line({ ...taskComplete('answer-a'), payload: { ...taskComplete('answer-a').payload, turn_id: firstTurnId } }),
      line({
        ...historyAppend([{
          type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [],
        }], '2000-01-01T00:00:05.000Z'),
        payload: {
          ...historyAppend([]).payload, turn_id: secondTurnId,
          items: [{ type: 'reasoning', id: 'rs-b', summary: [{ type: 'summary_text', text: 'cot-b' }], content: [] }],
        },
      }),
      line({
        ...taskComplete('answer-b'),
        payload: { ...taskComplete('answer-b').payload, turn_id: secondTurnId },
        timestamp: '2000-01-01T00:00:06.000Z',
      }),
    ].join(''));

    const queue = new CodexBridgeQueue();
    const observed: Array<{ turnId: string; text: string }> = [];
    queue.setCotObserver((entries, turn) => {
      for (const entry of entries) {
        if (entry.kind === 'thinking') observed.push({ turnId: turn.turnId, text: entry.text });
      }
    });
    queue.mark('d1', 'same', 0);
    queue.mark('d2', 'same', 0);
    const result = drainTraexRollout(path, 0);

    expect(result.events.filter(event => event.kind === 'user')).toEqual([
      expect.objectContaining({ text: 'same', sourceTurnId: firstTurnId }),
      expect.objectContaining({ text: 'same', sourceTurnId: secondTurnId }),
    ]);
    queue.ingest(result.events);
    expect(observed).toEqual([
      { turnId: 'd1', text: 'cot-a' },
      { turnId: 'd2', text: 'cot-b' },
    ]);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({ turnId: 'd1', finalText: 'answer-a', sourceTurnId: firstTurnId }),
      expect.objectContaining({ turnId: 'd2', finalText: 'answer-b', sourceTurnId: secondTurnId }),
    ]);
  });

  it('keeps a same-text item as a new turn when the legacy mirror window elapsed', () => {
    const turnId = '00000000-0000-7000-8000-000000000124';
    writeFileSync(path, [
      line(user('repeat after window', '2000-01-01T00:00:01.000Z')),
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-later', content: [{ type: 'text', text: 'repeat after window' }],
      }, turnId, '2000-01-01T00:00:07.000Z')),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.filter(event => event.kind === 'user')).toEqual([
      expect.objectContaining({ text: 'repeat after window' }),
      expect.objectContaining({ text: 'repeat after window', sourceTurnId: turnId }),
    ]);
  });

  it('does not suppress a later identical prompt when the expected legacy mirror never arrives', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000119';
    writeFileSync(path, line(itemCompleted({
      type: 'UserMessage', id: 'msg-first', content: [{ type: 'text', text: 'repeat later' }],
    }, firstTurnId)));
    const first = drainTraexRollout(path, 0);

    appendFileSync(path, line(user('repeat later', '2000-01-01T00:00:10.000Z')));
    expect(drainTraexRollout(path, first.newOffset).events).toEqual([
      expect.objectContaining({ kind: 'user', text: 'repeat later' }),
    ]);
  });

  it('keeps identical item_completed prompts from separate turns', () => {
    const firstTurnId = '00000000-0000-7000-8000-000000000113';
    const secondTurnId = '00000000-0000-7000-8000-000000000114';
    writeFileSync(path, [
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-first', content: [{ type: 'text', text: 'repeat prompt' }],
      }, firstTurnId)),
      line(itemCompleted({
        type: 'UserMessage', id: 'msg-second', content: [{ type: 'text', text: 'repeat prompt' }],
      }, secondTurnId, '2000-01-01T00:00:02.000Z')),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.filter(event => event.kind === 'user'))
      .toEqual([
        expect.objectContaining({ text: 'repeat prompt' }),
        expect.objectContaining({ text: 'repeat prompt' }),
      ]);
  });

  it('does not let an item_completed submit probe consume the production user event', () => {
    const turnId = '00000000-0000-7000-8000-000000000115';
    writeFileSync(path, line(itemCompleted({
      type: 'UserMessage',
      id: 'msg-user',
      content: [{ type: 'text', text: 'probe must stay read-only' }],
    }, turnId)));

    expect(traexRolloutHasUserInputSince(path, 0, 'probe must stay read-only')).toBe(true);
    expect(drainTraexRollout(path, 0).events).toEqual([
      expect.objectContaining({ kind: 'user', text: 'probe must stay read-only' }),
    ]);
  });

  it('ignores internal role=user injections without a user_message event', () => {
    writeFileSync(path, [
      line(userResponseItem('<environment_context>runtime context</environment_context>')),
      line(userResponseItem('Warning: runtime-generated process limit notice')),
      line(userResponseItem('real terminal input')),
      line(user('real terminal input')),
      line(taskComplete('done')),
    ].join(''));

    expect(drainTraexRollout(path, 0).events).toEqual([
      expect.objectContaining({
        kind: 'user',
        text: 'real terminal input',
      }),
      expect.objectContaining({
        kind: 'assistant_final',
        text: 'done',
      }),
    ]);
  });

  it('emits an empty task_complete so a silent durable turn can settle', () => {
    writeFileSync(path, line(user('finish silently')) + line(taskComplete()));
    const result = drainTraexRollout(path, 0);
    expect(result.events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
    }));
  });

  it('maps a turn_aborted shape to ambiguous with a bounded safe error code', () => {
    writeFileSync(path, line(user('cancel me')) + line(turnAborted('Interrupted by user / unsafe')));
    const result = drainTraexRollout(path, 0);
    expect(result.events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'ambiguous',
      terminalErrorCode: 'traex_turn_aborted:interrupted_by_user_unsafe',
    }));

    const queue = new CodexBridgeQueue();
    queue.mark('cancelled-delivery', 'cancel me', Date.parse('2000-01-01T00:00:00.000Z'), 6);
    queue.ingest(result.events);
    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'cancelled-delivery',
        dispatchAttempt: 6,
        terminalStatus: 'ambiguous',
        terminalErrorCode: 'traex_turn_aborted:interrupted_by_user_unsafe',
      }),
    ]);
  });

  it('does not advance over or emit a crash-partial terminal tail', () => {
    const first = line(user('partial-tail test'));
    const terminal = JSON.stringify(taskComplete('done'));
    writeFileSync(path, first + terminal.slice(0, -8));

    const beforeComplete = drainTraexRollout(path, 0);
    expect(beforeComplete.events.map(event => event.kind)).toEqual(['user']);
    expect(beforeComplete.newOffset).toBe(Buffer.byteLength(first));
    expect(beforeComplete.pendingTail.length).toBeGreaterThan(0);

    appendFileSync(path, terminal.slice(-8) + '\n');
    const afterComplete = drainTraexRollout(path, beforeComplete.newOffset);
    expect(afterComplete.events).toEqual([
      expect.objectContaining({ kind: 'assistant_final', text: 'done' }),
    ]);
  });

  it('preserves TRAE steer attribution: the last typed-ahead turn gets the single completion', () => {
    writeFileSync(path, [
      line(user('first durable prompt', '2000-01-01T00:00:01.000Z')),
      line(user('second steered prompt', '2000-01-01T00:00:02.000Z')),
      line(taskComplete('one merged answer')),
    ].join(''));
    const queue = new CodexBridgeQueue();
    queue.mark('delivery-1', 'first durable prompt', Date.parse('2000-01-01T00:00:00.000Z'), 3);
    queue.mark('delivery-2', 'second steered prompt', Date.parse('2000-01-01T00:00:00.001Z'), 4);
    queue.ingest(drainTraexRollout(path, 0).events);

    expect(queue.drainEmittable()).toEqual([
      expect.objectContaining({
        turnId: 'delivery-2',
        dispatchAttempt: 4,
        finalText: 'one merged answer',
      }),
    ]);
  });

  it('maps a task_complete error payload to a failed terminal (path A: endpoint failure)', () => {
    // Real shape from rollout-…01a0098a….jsonl: traecli writes task_complete
    // with last_agent_message=null AND error when the model endpoint fails.
    writeFileSync(path, [
      line(user('call the model')),
      line(taskCompleteWithError({
        message: 'model endpoint connection failed before receiving an HTTP response: error sending request for url (https://copilot.byteintl.net/api/ide/v2/llm_raw_chat)',
        codex_error_info: { http_connection_failed: { http_status_code: null } },
      })),
    ].join(''));

    const result = drainTraexRollout(path, 0);
    expect(result.events.at(-1)).toMatchObject({
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'failed',
      terminalErrorCode: CODEX_CONNECTION_ERROR_CODE,
    });
    expect(result.events.at(-1)!.terminalErrorSummary).toContain('model endpoint connection failed');
    // The provider URL must not survive into the user-facing summary.
    expect(result.events.at(-1)!.terminalErrorSummary).not.toContain('copilot.byteintl.net');
  });

  it('classifies as failed even when last_agent_message is present alongside the error', () => {
    writeFileSync(path, line(user('partial turn'))
      + line(taskCompleteWithError({ message: 'connection reset by peer' }, 'partial answer')));

    expect(drainTraexRollout(path, 0).events.at(-1)).toMatchObject({
      kind: 'assistant_final',
      text: 'partial answer',
      terminalStatus: 'failed',
      terminalErrorCode: CODEX_CONNECTION_ERROR_CODE,
    });
  });

  it('maps only the exact output-limit failure to the continuation allowlist code', () => {
    writeFileSync(path, [
      line(user('long task')),
      line(taskCompleteWithError({ message: 'model output limit exceeded: max_output_tokens' })),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toMatchObject({
      terminalStatus: 'failed',
      terminalErrorCode: 'codex_output_limit_exceeded',
    });
  });

  it('synthesises the bare sentinel when the last commentary ends with BOTMUX_NO_REPLY (path B: deliberate silence)', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('进度：CI 已绿', 'commentary')),
      line(agentMessage('我已完成状态回报。BOTMUX_NO_REPLY', 'commentary')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: 'BOTMUX_NO_REPLY',
    }));
  });

  it('recognises the current BOTMUX_NOTHING_TO_SEND sentinel as deliberate silence', () => {
    writeFileSync(path, [
      line(user('ambient chatter')),
      line(agentMessage('BOTMUX_NOTHING_TO_SEND', 'commentary')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: 'BOTMUX_NOTHING_TO_SEND',
    }));
  });

  it('retains agent_message state across drain calls (commentary drained before task_complete)', () => {
    // Turns run for minutes while the poller drains on the second scale: the
    // commentary batch and the task_complete almost never share a drain call.
    const firstBatch = line(user('long-running turn'))
      + line(agentMessage('工作中', 'commentary'))
      + line(agentMessage('已通过 botmux send 回报。BOTMUX_NO_REPLY', 'commentary'));
    writeFileSync(path, firstBatch);
    const first = drainTraexRollout(path, 0);
    expect(first.events.map(event => event.kind)).toEqual(['user']);

    appendFileSync(path, line(taskComplete()));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([
      expect.objectContaining({ kind: 'assistant_final', text: 'BOTMUX_NO_REPLY' }),
    ]);
  });

  it('does not treat a commentary without a trailing sentinel as silence', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('随便聊聊，没有结论', 'commentary')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
    }));
  });

  it('reconstructs the final from the last final_answer-phase agent_message (defensive: TRAE dropped the final)', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('思考中', 'commentary')),
      line(agentMessage('这是最终答案', 'final_answer')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '这是最终答案',
    }));
  });

  it('prefers a final_answer reconstruction over a commentary sentinel', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('已回报。BOTMUX_NO_REPLY', 'commentary')),
      line(agentMessage('真正的最终答案', 'final_answer')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '真正的最终答案',
    }));
  });

  it('resets pending agent state at each user_message so a prior turn cannot leak', () => {
    writeFileSync(path, [
      line(user('first turn')),
      line(agentMessage('第一轮已回报。BOTMUX_NO_REPLY', 'commentary')),
      line(taskComplete()),
      line(user('second turn')),
      line(taskComplete()),
    ].join(''));

    const finals = drainTraexRollout(path, 0).events.filter(event => event.kind === 'assistant_final');
    expect(finals[0]).toEqual(expect.objectContaining({ text: 'BOTMUX_NO_REPLY' }));
    expect(finals[1]).toEqual(expect.objectContaining({ text: '' }));
  });

  it('synthesised sentinel final is genuine silence: the empty-completed alert stays suppressed', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('已回报。BOTMUX_NO_REPLY', 'commentary')),
      line(taskComplete()),
    ].join(''));

    const queue = new CodexBridgeQueue();
    queue.mark('delivery-1', 'do the work', Date.parse('2000-01-01T00:00:00.000Z'), 1);
    queue.ingest(drainTraexRollout(path, 0).events);
    const turn = queue.drainEmittable()[0];
    expect(turn.finalText).toBe('BOTMUX_NO_REPLY');
    expect(isBridgeNothingToSendFinal(turn.finalText)).toBe(true);
    expect(shouldEmitEmptyCompletedBridgeFallback(
      {
        markTimeMs: turn.markTimeMs,
        isLocal: false,
        finalText: turn.finalText,
        terminalStatus: turn.terminalStatus,
      },
      undefined,
      [],
      false,
    )).toBe(false);
  });

  it('does not synthesise a bare sentinel in adopt mode (verbatim contract)', () => {
    // adopt posts transcript text verbatim, so a synthesised token would leak
    // the literal sentinel into Lark. Keep the empty final; no alert fires in
    // adopt either (shouldEmitEmptyCompletedBridgeFallback is adopt-gated).
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('已回报。BOTMUX_NO_REPLY', 'commentary')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0, { adoptMode: true }).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
    }));
    // Non-adopt still synthesises (existing behaviour).
    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: 'BOTMUX_NO_REPLY',
    }));
  });

  it('reconstructs a final_answer-phase message in adopt mode (real answer, not synthesis)', () => {
    // final_answer reconstruction is safe in BOTH modes: it is the model's
    // real transcript answer (phase-guaranteed, not tool narration), and adopt
    // posts transcript text verbatim anyway. Only the bare-sentinel synthesis
    // is adopt-gated. adopt is in fact the mode where reconstruction matters
    // most — drain is the only channel to Lark there.
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessage('思考中', 'commentary')),
      line(agentMessage('这是最终答案', 'final_answer')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0, { adoptMode: true }).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '这是最终答案',
    }));
    // Non-adopt reconstructs identically.
    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '这是最终答案',
    }));
  });

  it('reconstructs the final from the last item_completed AgentMessage item (0.201.4+ assistant dialect)', () => {
    // Symmetric to the UserMessage user dialect: TraeX 0.201.4+ can emit the
    // assistant message as an item_completed AgentMessage item. The LAST one
    // is the final candidate; mid-turn items are overwritten.
    writeFileSync(path, [
      line(user('do the work')),
      line(itemCompleted({
        type: 'AgentMessage',
        id: 'msg-agent-mid',
        content: [{ type: 'Text', text: 'mid-turn progress' }],
      }, undefined, '2000-01-01T00:00:02.000Z')),
      line(itemCompleted({
        type: 'AgentMessage',
        id: 'msg-agent-final',
        content: [{ type: 'Text', text: '这是最终答案' }],
      }, undefined, '2000-01-01T00:00:02.500Z')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '这是最终答案',
    }));
  });

  it('accepts the output_text block shape in an AgentMessage item (upstream Responses API dialect)', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(itemCompleted({
        type: 'AgentMessage',
        id: 'msg-agent',
        content: [{ type: 'output_text', text: '这是最终答案' }],
      })),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '这是最终答案',
    }));
  });

  it('reconstructs an AgentMessage item final in adopt mode (real transcript text, not synthesis)', () => {
    // Like the final_answer-phase reconstruction, an AgentMessage item is the
    // model's real transcript answer — safe in BOTH modes. adopt is in fact
    // the mode where it matters most: drain is the only channel to Lark.
    writeFileSync(path, [
      line(user('do the work')),
      line(itemCompleted({
        type: 'AgentMessage',
        id: 'msg-agent',
        content: [{ type: 'Text', text: '这是最终答案' }],
      })),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0, { adoptMode: true }).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '这是最终答案',
    }));
  });

  it('does not treat an item_completed AgentMessage item as a user turn start', () => {
    // Regression guard for the #997 boundary: only UserMessage items start a
    // turn; AgentMessage items are assistant-side and must not emit a user
    // event even when they carry text.
    writeFileSync(path, [
      line(itemCompleted({
        type: 'AgentMessage',
        id: 'msg-agent',
        content: [{ type: 'Text', text: 'assistant text' }],
      })),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.filter(event => event.kind === 'user')).toHaveLength(0);
  });

  it('reconstructs the final from the last phase-less agent_message (phase-dropped dialect, cf. codex >= 0.146)', () => {
    // A dialect that dropped the `phase` field makes commentary and final
    // byte-identical; the last phase-less agent_message is the best final
    // candidate.
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessageNoPhase('中间 commentary')),
      line(agentMessageNoPhase('这是最终答案')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '这是最终答案',
    }));
  });

  it('prefers a final_answer-phase agent_message over a phase-less fallback candidate', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessageNoPhase('别的候选')),
      line(agentMessage('真正的最终答案', 'final_answer')),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '真正的最终答案',
    }));
  });

  it('prefers an AgentMessage item over a phase-less agent_message candidate', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessageNoPhase('phase-less 候选')),
      line(itemCompleted({
        type: 'AgentMessage',
        id: 'msg-agent',
        content: [{ type: 'Text', text: 'item 候选' }],
      })),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: 'item 候选',
    }));
  });

  it('recognises deliberate silence in a phase-less agent_message (sentinel, not a false final)', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(agentMessageNoPhase('已通过 botmux send 回报。BOTMUX_NO_REPLY')),
      line(taskComplete()),
    ].join(''));

    // Non-adopt: synthesise the bare sentinel the fallback gate treats as
    // genuine silence instead of posting the narration as the final.
    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: 'BOTMUX_NO_REPLY',
    }));
    // Adopt: no synthesis (verbatim contract) — the empty final stays empty.
    expect(drainTraexRollout(path, 0, { adoptMode: true }).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
    }));
  });

  it('recognises deliberate silence in an item_completed AgentMessage item (sentinel, not a false final)', () => {
    writeFileSync(path, [
      line(user('do the work')),
      line(itemCompleted({
        type: 'AgentMessage',
        id: 'msg-agent',
        content: [{ type: 'Text', text: '已通过 botmux send 回报。BOTMUX_NO_REPLY' }],
      })),
      line(taskComplete()),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: 'BOTMUX_NO_REPLY',
    }));
    expect(drainTraexRollout(path, 0, { adoptMode: true }).events.at(-1)).toEqual(expect.objectContaining({
      kind: 'assistant_final',
      text: '',
    }));
  });

  it('retains the phase-less agent_message candidate across drain calls (drained before task_complete)', () => {
    // Turns run for minutes while the poller drains on the second scale: the
    // phase-less candidate and the task_complete almost never share a drain.
    const firstBatch = line(user('long-running turn'))
      + line(agentMessageNoPhase('这是最终答案'));
    writeFileSync(path, firstBatch);
    const first = drainTraexRollout(path, 0);
    expect(first.events.map(event => event.kind)).toEqual(['user']);

    appendFileSync(path, line(taskComplete()));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([
      expect.objectContaining({ kind: 'assistant_final', text: '这是最终答案' }),
    ]);
  });

  it('a probe re-drain does not consume the AgentMessage item final candidate', () => {
    // The submit-confirmation probe re-drains the same live rollout; its
    // item_completed processing must not record (or clear) the assistant
    // candidate the production drainer is holding for the still-open turn.
    const firstBatch = line(user('long turn'))
      + line(itemCompleted({
        type: 'AgentMessage',
        id: 'msg-agent',
        content: [{ type: 'Text', text: '这是最终答案' }],
      }));
    writeFileSync(path, firstBatch);
    const first = drainTraexRollout(path, 0);
    expect(first.events.map(event => event.kind)).toEqual(['user']);

    // Submit-confirmation probe re-drains the same rollout.
    expect(traexRolloutHasUserInputSince(path, 0, 'long turn')).toBe(true);

    // Turn completes; the production drain must still see the cached item.
    appendFileSync(path, line(taskComplete()));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([
      expect.objectContaining({ kind: 'assistant_final', text: '这是最终答案' }),
    ]);
  });

  it('a probe re-drain mid-turn does not clear the production pending state', () => {
    // traexRolloutHasUserInputSince re-drains the same live rollout; its
    // user_message processing must not delete the commentary the production
    // drainer is holding for the still-open turn.
    const firstBatch = line(user('long turn'))
      + line(agentMessage('已回报。BOTMUX_NO_REPLY', 'commentary'));
    writeFileSync(path, firstBatch);
    const first = drainTraexRollout(path, 0);
    expect(first.events.map(event => event.kind)).toEqual(['user']);

    // Submit-confirmation probe re-drains the same rollout.
    expect(traexRolloutHasUserInputSince(path, 0, 'long turn')).toBe(true);

    // Turn completes; the production drain must still see the cached commentary.
    appendFileSync(path, line(taskComplete()));
    const second = drainTraexRollout(path, first.newOffset);
    expect(second.events).toEqual([
      expect.objectContaining({ kind: 'assistant_final', text: 'BOTMUX_NO_REPLY' }),
    ]);
  });

  it('maps a 429 task_complete error to the rate-limit failure code', () => {
    writeFileSync(path, [
      line(user('hit the limit')),
      line(taskCompleteWithError({ message: '429 Too Many Requests' })),
    ].join(''));

    expect(drainTraexRollout(path, 0).events.at(-1)).toMatchObject({
      kind: 'assistant_final',
      text: '',
      terminalStatus: 'failed',
      terminalErrorCode: CODEX_RATE_LIMIT_ERROR_CODE,
    });
  });
});

describe('traexRolloutHasUserInputSince', () => {
  it('matches only a complete exact user record appended after the baseline', () => {
    const old = line(user('same thread, old prompt'));
    writeFileSync(path, old);
    const baseline = Buffer.byteLength(old);
    appendFileSync(path, line(user('same thread, later prompt')));

    expect(traexRolloutHasUserInputSince(path, baseline, 'same thread, later prompt')).toBe(true);
    expect(traexRolloutHasUserInputSince(path, baseline, 'same thread, old prompt')).toBe(false);
    expect(traexRolloutHasUserInputSince(path, baseline, 'same thread')).toBe(false);
  });
});

describe('traexHistoryMatchDelta (submit-time history.jsonl verification)', () => {
  let histPath: string;

  function histLine(sessionId: string, text: string): string {
    return `${JSON.stringify({ session_id: sessionId, ts: 1785900000, text })}\n`;
  }

  beforeEach(() => {
    histPath = join(dir, 'history.jsonl');
  });

  it('confirms a submit appended after baseByte and returns its session_id', () => {
    const base = histLine('aaaa1111-0000-7000-8000-000000000001', 'earlier turn');
    writeFileSync(histPath, base);
    const baseByte = Buffer.byteLength(base);
    // The follow-up botmux would paste while a turn is running: parked by TRAE
    // but written to history.jsonl immediately at submit time.
    appendFileSync(histPath, histLine('bbbb2222-0000-7000-8000-000000000002', '<session_id>x</session_id>\n\n<user_message>\nfollow-up while busy\n</user_message>'));

    const match = traexHistoryMatchDelta(histPath, baseByte, '<session_id>x</session_id>\n\n<user_message>\nfollow-up while busy\n</user_message>');
    expect(match.found).toBe(true);
    expect(match.cliSessionId).toBe('bbbb2222-0000-7000-8000-000000000002');
  });

  it('never matches a line at or before baseByte (only the new submit)', () => {
    const base = histLine('aaaa1111-0000-7000-8000-000000000001', 'earlier turn');
    writeFileSync(histPath, base);
    const baseByte = Buffer.byteLength(base);
    expect(traexHistoryMatchDelta(histPath, baseByte, 'earlier turn').found).toBe(false);
  });

  it('returns not-found when the file is absent (lazy-created on first submit)', () => {
    expect(traexHistoryMatchDelta(join(dir, 'nope.jsonl'), 0, 'anything').found).toBe(false);
  });

  it('normalises CRLF/CR so a paste round-tripped through TRAE still matches', () => {
    writeFileSync(histPath, '');
    appendFileSync(histPath, histLine('cccc3333-0000-7000-8000-000000000003', 'line one\nline two'));
    // Expected text arrives with CRLF from the caller; the stored text is LF.
    const match = traexHistoryMatchDelta(histPath, 0, 'line one\r\nline two');
    expect(match.found).toBe(true);
    expect(match.cliSessionId).toBe('cccc3333-0000-7000-8000-000000000003');
  });

  it('ignores a trailing partial (non-newline-terminated) line until it completes', () => {
    writeFileSync(histPath, '');
    // Half-written line — no trailing newline. Must NOT match yet.
    const partial = JSON.stringify({ session_id: 'dddd4444-0000-7000-8000-000000000004', ts: 1785900001, text: 'mid write' });
    writeFileSync(histPath, partial);
    expect(traexHistoryMatchDelta(histPath, 0, 'mid write').found).toBe(false);
    // Completed with a newline on a later poll — now it matches.
    writeFileSync(histPath, partial + '\n');
    expect(traexHistoryMatchDelta(histPath, 0, 'mid write').found).toBe(true);
  });

  it('with an ownership filter, skips a sibling pane\'s identical text and accepts only the owned session', () => {
    writeFileSync(histPath, '');
    const foreignSid = 'ffff0000-0000-7000-8000-00000000000f';
    const ownedSid = '11110000-0000-7000-8000-000000000011';
    // Same exact text submitted by two panes sharing one TRAE_HOME; the
    // sibling's line lands first.
    appendFileSync(histPath, histLine(foreignSid, 'duplicate text'));
    appendFileSync(histPath, histLine(ownedSid, 'duplicate text'));

    const acceptOwned = (sid: string | undefined) => sid?.toLowerCase() === ownedSid.toLowerCase();
    const match = traexHistoryMatchDelta(histPath, 0, 'duplicate text', acceptOwned);
    expect(match.found).toBe(true);
    expect(match.cliSessionId).toBe(ownedSid);

    // If the ONLY line is a foreign pane's, the owned filter rejects it.
    writeFileSync(histPath, histLine(foreignSid, 'only foreign'));
    expect(traexHistoryMatchDelta(histPath, 0, 'only foreign', acceptOwned).found).toBe(false);
  });

  it('traexHistorySize returns 0 for an absent file and the byte size otherwise', () => {
    expect(traexHistorySize(join(dir, 'absent.jsonl'))).toBe(0);
    const body = histLine('eeee5555-0000-7000-8000-000000000055', 'sized');
    writeFileSync(histPath, body);
    expect(traexHistorySize(histPath)).toBe(Buffer.byteLength(body));
  });
});

describe('traexHistorySidIsOwned (ownership gate predicate)', () => {
  const OWNED = 'aaaa1111-0000-7000-8000-000000000001';
  const FOREIGN = 'ffff0000-0000-7000-8000-00000000000f';

  it('accepts an id present in the owned set (case-insensitive)', () => {
    const owned = new Set([OWNED.toLowerCase()]);
    expect(traexHistorySidIsOwned(OWNED, owned)).toBe(true);
    expect(traexHistorySidIsOwned(OWNED.toUpperCase(), owned)).toBe(true);
  });

  it('rejects an id NOT in the owned set (foreign sibling pane)', () => {
    const owned = new Set([OWNED.toLowerCase()]);
    expect(traexHistorySidIsOwned(FOREIGN, owned)).toBe(false);
  });

  it('fails closed when the set is undefined (fd enumeration unavailable)', () => {
    expect(traexHistorySidIsOwned(OWNED, undefined)).toBe(false);
  });

  it('fails closed on an empty set (pid holds no TRAE rollout)', () => {
    expect(traexHistorySidIsOwned(OWNED, new Set())).toBe(false);
  });
});

describe('TRAE pid ownership probe on macOS/BSD', () => {
  it('uses a shell-free lsof call with a hard timeout', () => {
    const start = traexTranscriptSource.indexOf('function traexProcessOpenTargets');
    const end = traexTranscriptSource.indexOf('/** Find the visible top-level rollout', start);
    const body = traexTranscriptSource.slice(start, end);

    expect(body).toContain("execFileSync('lsof', ['-p', String(pid), '-Fn']");
    expect(body).toContain('timeout: TRAEX_LSOF_TIMEOUT_MS');
    expect(body).toContain("killSignal: 'SIGKILL'");
    expect(body).not.toContain('execSync(');
    expect(traexTranscriptSource).toContain('const TRAEX_LSOF_TIMEOUT_MS = 1_000;');
  });

  it.skipIf(process.platform !== 'darwin')('kills a stalled lsof probe within the bounded deadline', () => {
    const fakeLsof = join(dir, 'lsof');
    writeFileSync(fakeLsof, '#!/bin/sh\nsleep 10\n');
    chmodSync(fakeLsof, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = `${dir}:${originalPath ?? ''}`;
    const startedAt = Date.now();
    try {
      expect(findTraexRolloutSetByPid(process.pid)).toBeUndefined();
    } finally {
      process.env.PATH = originalPath;
    }
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
});
