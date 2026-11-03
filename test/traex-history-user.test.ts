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
});
