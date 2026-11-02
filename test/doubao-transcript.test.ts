/**
 * Unit tests for the Doubao transcript bridge drainer.
 *
 * Layout under a session root:
 *   .sessions/<snowflakeSid>/agents/<agentId>/system/
 *       assignment.md      — append-only `## [ts] 需求` user turns
 *       trajectory.jsonl   — assistant/tool records
 *
 * Every lookup is handed the temp root explicitly so these tests never touch
 * the real logged-in account's session store.
 */
import { describe, it, expect } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  doubaoSystemDirForSession,
  drainDoubaoTranscript,
} from '../src/services/doubao-transcript.js';
import { doubaoBridgeSpec } from '../src/adapters/cli/doubao.js';

const SID = '38459999999999999';
const AGENT = 'm_agent1';

function makeSession(root: string): { roots: string[]; systemDir: string; assignment: string; trajectory: string } {
  const sessionsRoot = join(root, 'agent_mode', '100', 'workspace', '.sessions');
  const systemDir = join(sessionsRoot, SID, 'agents', AGENT, 'system');
  mkdirSync(systemDir, { recursive: true });
  return {
    roots: [sessionsRoot],
    systemDir,
    assignment: join(systemDir, 'assignment.md'),
    trajectory: join(systemDir, 'trajectory.jsonl'),
  };
}

describe('doubao transcript bridge', () => {
  it('resolves the main-agent trajectory path by snowflake session id', () => {
    const root = join(tmpdir(), `doubao-bridge-locate-${process.pid}`);
    const { roots, systemDir, trajectory } = makeSession(root);
    writeFileSync(trajectory, '');
    expect(doubaoSystemDirForSession(SID, roots)).toBe(systemDir);
    // Non-snowflake ids are rejected.
    expect(doubaoSystemDirForSession('abc', roots)).toBeUndefined();
  });

  it('drains user prompt + terminal assistant answer and skips mid-turn rows', () => {
    const root = join(tmpdir(), `doubao-bridge-drain-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    const ts = '2026-11-02T05:40:07.661Z';
    writeFileSync(assignment, [
      '# Assignment',
      '- Agent ID: x',
      '- Role: main',
      '',
      `## [${ts}] 需求`,
      '请运行 date 并告诉我日期',
      '',
    ].join('\n'));
    writeFileSync(trajectory, [
      JSON.stringify({ role: 'assistant', content: '我先运行 date。', tool_calls: [{ id: 't1', type: 'function', function: { name: 'Bash', arguments: {} } }] }),
      JSON.stringify({ role: 'tool', content: '2026-11-02', tool_call_id: 't1' }),
      JSON.stringify({ role: 'assistant', content: '今天是 2026-11-02。' }),
    ].join('\n') + '\n');

    const r1 = doubaoBridgeSpec.drain(trajectory, 0, { adoptMode: false, state: undefined });
    expect(r1.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r1.events[0]!.text).toBe('请运行 date 并告诉我日期');
    expect(r1.events[1]!.text).toBe('今天是 2026-11-02。');
    expect(new Set(r1.events.map(e => e.uuid)).size).toBe(2);
    expect(r1.state).toMatchObject({
      assignmentOffset: expect.any(Number),
      trajectoryOffset: expect.any(Number),
    });

    // Second drain with committed state yields nothing.
    const r2 = doubaoBridgeSpec.drain(trajectory, r1.newOffset, { adoptMode: false, state: r1.state });
    expect(r2.events).toEqual([]);
  });

  it('incrementally picks up an appended second turn', () => {
    const root = join(tmpdir(), `doubao-bridge-inc-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    writeFileSync(assignment, '## [2026-11-02T05:40:07.000Z] 需求\n第一问\n');
    writeFileSync(trajectory, JSON.stringify({ role: 'assistant', content: '第一答' }) + '\n');
    const r1 = drainDoubaoTranscript(trajectory, 0);
    expect(r1.events).toHaveLength(2);

    writeFileSync(assignment, '## [2026-11-02T05:42:00.000Z] 需求\n第二问\n', { flag: 'a' });
    writeFileSync(trajectory, JSON.stringify({ role: 'assistant', content: '第二答' }) + '\n', { flag: 'a' });
    const r2 = drainDoubaoTranscript(trajectory, r1.newOffset, { state: r1.state });
    expect(r2.events.map(e => e.kind)).toEqual(['user', 'assistant_final']);
    expect(r2.events[0]!.text).toBe('第二问');
    expect(r2.events[1]!.text).toBe('第二答');
  });

  it('ignores assistant rows with empty content or only tool_calls narration', () => {
    const root = join(tmpdir(), `doubao-bridge-skip-${process.pid}`);
    const { assignment, trajectory } = makeSession(root);
    writeFileSync(assignment, '## [2026-11-02T05:40:07.000Z] 需求\n问题\n');
    writeFileSync(trajectory, [
      JSON.stringify({ role: 'assistant', content: '' }),
      JSON.stringify({ role: 'assistant', content: '中间旁白', tool_calls: [{ id: 't1' }] }),
    ].join('\n') + '\n');
    const r = drainDoubaoTranscript(trajectory, 0);
    expect(r.events.map(e => e.kind)).toEqual(['user']);
  });
});
