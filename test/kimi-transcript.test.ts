import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CotEntry } from '../src/types.js';
import {
  findKimiWireBySessionId,
  findKimiWireForBotmuxSession,
  KimiActivityParser,
  kimiSessionIndexStamp,
  readKimiModelContextWindow,
} from '../src/services/kimi-transcript.js';
import { makeKimiSession, toolTurn, wire, type WireRecord } from './helpers/kimi-wire-fixture.js';

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });
const tmp = () => (root = mkdtempSync(join(tmpdir(), 'kimi-transcript-')));

const BOTMUX = '4c0a8f9e-1b2d-4e3f-8a5b-6c7d8e9f0a1b';
const OTHER = '9d8c7b6a-0000-4000-8000-000000000000';
const envelope = (sid: string, text = 'hello') => `<session_id>${sid}</session_id>\n<botmux_routing>…</botmux_routing>\n${text}`;

function parseAll(records: readonly WireRecord[]): CotEntry[] {
  const parser = new KimiActivityParser();
  return records.flatMap(r => parser.push(r));
}

describe('Kimi wire log → reply-card activity', () => {
  it('streams thinking, narration and tools, but not the closing answer', () => {
    const entries = parseAll(toolTurn(0, envelope(BOTMUX)));
    expect(entries).toEqual([
      { kind: 'thinking', text: 'Need to look at the repo first.' },
      { kind: 'text', text: 'Let me check the files.' },
      { kind: 'tool_call', id: 'tool_a', name: 'Bash', args: '{"command":"ls -la src"}', subject: 'ls -la src' },
      { kind: 'tool_result', id: 'tool_a', result: 'index.ts\nworker.ts' },
      { kind: 'thinking', text: 'Two files. Answer now.' },
      // 'There are two files…' ends the turn: it is the reply, delivered by
      // the reply path, and must not be duplicated in the activity panel.
    ]);
  });

  it('drops text of a failed or interrupted step and of a turn that ends mid-step', () => {
    const entries = parseAll([
      wire.prompt(0, 'x'),
      wire.text('partial answer before a provider error'),
      wire.stepEnd('error'),
      wire.text('half a sentence before Ctrl-C'),
      // Ctrl-C: Kimi writes turn.ended(cancelled) BEFORE agent.turn.ended(aborted).
      wire.turnEnded(0, 'cancelled'),
      wire.agentTurnEnded(0, 'aborted'),
      wire.prompt(1, 'y'),
      wire.toolCall('tool_b', 'Read', { path: '/tmp/a.txt' }),
    ]);
    expect(entries).toEqual([
      { kind: 'tool_call', id: 'tool_b', name: 'Read', args: '{"path":"/tmp/a.txt"}', subject: '/tmp/a.txt' },
    ]);
  });

  it('ignores sub-agent records and joins structured tool output', () => {
    const entries = parseAll([
      wire.think('sub-agent thought', 1, 'agent-0'),
      wire.toolCall('tool_sub', 'Grep', { pattern: 'x' }, undefined, 'agent-0'),
      wire.toolCall('tool_c', 'FetchURL', { url: 'https://example.com' }),
      wire.toolResult('tool_c', [{ type: 'text', text: 'line 1' }, { type: 'image_url' }, { type: 'text', text: 'line 2' }], { isError: false }),
    ]);
    expect(entries).toEqual([
      { kind: 'tool_call', id: 'tool_c', name: 'FetchURL', args: '{"url":"https://example.com"}', subject: 'https://example.com' },
      { kind: 'tool_result', id: 'tool_c', result: 'line 1\nline 2' },
    ]);
  });

  it('bounds tool args and results like the other activity readers', () => {
    const big = 'x'.repeat(5000);
    const [call, result] = parseAll([
      wire.toolCall('tool_d', 'Write', { path: '/tmp/big', content: big }),
      wire.toolResult('tool_d', big),
    ]) as [Extract<CotEntry, { kind: 'tool_call' }>, Extract<CotEntry, { kind: 'tool_result' }>];
    expect(call.args.length).toBeLessThan(700);
    expect(call.subject).toBe('/tmp/big');
    expect(result.result.length).toBeLessThan(900);
  });
});

describe('Kimi session lookup by botmux session', () => {
  it('picks the newest session of this working dir that carries the marker', () => {
    const home = tmp();
    const work = join(home, 'work');
    mkdirSync(work);
    const env = { KIMI_CODE_HOME: home };
    const older = makeKimiSession(home, { id: 'session_a', workDir: work, lastPrompt: envelope(BOTMUX) });
    makeKimiSession(home, { id: 'session_b', workDir: work, lastPrompt: envelope(OTHER) });
    const newer = makeKimiSession(home, { id: 'session_c', workDir: work, lastPrompt: envelope(BOTMUX) });
    makeKimiSession(home, { id: 'session_d', workDir: join(home, 'elsewhere'), lastPrompt: envelope(BOTMUX) });
    expect(findKimiWireForBotmuxSession(BOTMUX, work, { env })).toBe(newer.wirePath);
    expect(findKimiWireForBotmuxSession(OTHER, work, { env })).toBe(join(home, 'sessions', 'wd_work_0123456789ab', 'session_b', 'agents', 'main', 'wire.jsonl'));
    expect(findKimiWireForBotmuxSession('nobody', work, { env })).toBeUndefined();
    expect(findKimiWireBySessionId('session_a', env)).toBe(older.wirePath);
    expect(findKimiWireBySessionId('not-a-kimi-id', env)).toBeUndefined();
  });

  it('skips a session whose latest prompt belongs to another botmux session', () => {
    const home = tmp();
    const env = { KIMI_CODE_HOME: home };
    const ours = makeKimiSession(home, { id: 'session_a', workDir: home, lastPrompt: envelope(BOTMUX), records: [wire.prompt(0, envelope(BOTMUX))] });
    // Newer, another conversation; our marker only shows up in its tool output.
    const theirs = makeKimiSession(home, {
      id: 'session_b', workDir: home, lastPrompt: envelope(OTHER),
      records: [wire.prompt(0, envelope(OTHER)), wire.toolResult('t', `grep hit: ${envelope(BOTMUX)}`)],
    });
    expect(findKimiWireForBotmuxSession(BOTMUX, home, { env })).toBe(ours.wirePath);
    expect(findKimiWireForBotmuxSession(OTHER, home, { env })).toBe(theirs.wirePath);
  });

  it('falls back to the wire log when state.json has no botmux prompt', () => {
    const home = tmp();
    const env = { KIMI_CODE_HOME: home };
    const s = makeKimiSession(home, { id: 'session_a', workDir: home, lastPrompt: null, records: [wire.metadata(), wire.prompt(0, envelope(BOTMUX))] });
    makeKimiSession(home, { id: 'session_b', workDir: home, lastPrompt: 'typed locally', records: [wire.prompt(0, 'typed locally')] });
    expect(findKimiWireForBotmuxSession(BOTMUX, home, { env })).toBe(s.wirePath);
  });

  it('does not re-read an unchanged large log that has no marker', () => {
    const home = tmp();
    const env = { KIMI_CODE_HOME: home };
    // A hand-typed session: no botmux prompt in state.json and a log larger
    // than the head probe, so only a whole-log read can decide it.
    const filler = JSON.stringify({ type: 'filler', text: 'x'.repeat(1000) }) + '\n';
    const head = filler.repeat(300);
    const s = makeKimiSession(home, { id: 'session_a', workDir: home, lastPrompt: null, records: [] });
    const tailMarker = `<session_id>${BOTMUX}</session_id>\n`;
    const tailNoMarker = 'y'.repeat(tailMarker.length - 1) + '\n';
    writeFileSync(s.wirePath, head + tailNoMarker);
    const pinned = new Date('2026-01-01T00:00:00Z');
    utimesSync(s.wirePath, pinned, pinned);
    expect(findKimiWireForBotmuxSession(BOTMUX, home, { env })).toBeUndefined();

    // Same size, same mtime, but now the marker IS past the probe. A cached
    // miss answers without reading the log again, so it stays a miss…
    writeFileSync(s.wirePath, head + tailMarker);
    utimesSync(s.wirePath, pinned, pinned);
    expect(readFileSync(s.wirePath, 'utf8')).toContain(tailMarker);
    expect(findKimiWireForBotmuxSession(BOTMUX, home, { env })).toBeUndefined();

    // …and any write (Kimi only appends) moves size/mtime and re-reads it.
    appendFileSync(s.wirePath, filler);
    expect(findKimiWireForBotmuxSession(BOTMUX, home, { env })).toBe(s.wirePath);
  });

  it('never follows an index entry outside Kimi\'s sessions dir', () => {
    const home = tmp();
    const env = { KIMI_CODE_HOME: home };
    const outside = join(home, 'outside', 'session_x');
    mkdirSync(join(outside, 'agents', 'main'), { recursive: true });
    writeFileSync(join(outside, 'state.json'), JSON.stringify({ lastPrompt: envelope(BOTMUX) }));
    writeFileSync(join(home, 'session_index.jsonl'), JSON.stringify({ sessionId: 'session_x', sessionDir: outside, workDir: home }) + '\n');
    expect(findKimiWireForBotmuxSession(BOTMUX, home, { env })).toBeUndefined();
  });
});

describe('Kimi session index change stamp', () => {
  const env = (home: string) => ({ KIMI_CODE_HOME: home });
  // A fixed instant with millisecond precision, so utimes round-trips exactly.
  const pinMtime = (path: string) => utimesSync(path, STAMP_PIN_DATE, STAMP_PIN_DATE);
  const STAMP_PIN_DATE = new Date('2025-06-01T08:30:00.000Z');

  it('changes when state.json is rewritten inside the same millisecond (size component)', () => {
    const home = tmp();
    const s = makeKimiSession(home, {
      id: 'session_a', workDir: home, lastPrompt: envelope(BOTMUX),
      records: [wire.metadata(), wire.prompt(0, envelope(BOTMUX))],
    });
    const statePath = join(s.dir, 'state.json');
    pinMtime(statePath);
    const before = kimiSessionIndexStamp(env(home));
    // A longer prompt rewrites state.json while the mtime is pinned to the
    // same instant: two writes landing in one millisecond, the flake shape.
    writeFileSync(statePath, JSON.stringify({
      id: 'session_a', lastPrompt: envelope(BOTMUX, 'x'.repeat(200)),
    }));
    pinMtime(statePath);
    expect(statSync(statePath).mtimeMs).toBe(STAMP_PIN_DATE.getTime());
    expect(kimiSessionIndexStamp(env(home))).not.toBe(before);
  });

  it('stays equal when neither mtime nor size of the newest state changes', () => {
    const home = tmp();
    const s = makeKimiSession(home, {
      id: 'session_a', workDir: home, lastPrompt: envelope(BOTMUX),
      records: [wire.prompt(0, envelope(BOTMUX))],
    });
    const statePath = join(s.dir, 'state.json');
    pinMtime(statePath);
    const before = kimiSessionIndexStamp(env(home));
    const originalSize = statSync(statePath).size;
    // Equal-length rewrite with the mtime pinned: neither stamp component has
    // a signal, so the stamp intentionally stays equal (the fresh re-resolve
    // path remains the backstop for this shape).
    const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    state.lastPrompt = envelope(BOTMUX, 'y'.repeat(5));
    writeFileSync(statePath, JSON.stringify(state));
    pinMtime(statePath);
    expect(statSync(statePath).size).toBe(originalSize);
    expect(kimiSessionIndexStamp(env(home))).toBe(before);
  });
});

describe('Kimi model context window', () => {
  it('reads max_context_size of the alias section only', () => {
    const home = tmp();
    const env = { KIMI_CODE_HOME: home };
    writeFileSync(join(home, 'config.toml'), [
      'default_model = "kimi-code/k3.1-pro-highspeed"',
      '[models."kimi-code/k3-256k"]',
      'model = "k3-256k"',
      'max_context_size = 262144',
      '',
      '[models."kimi-code/k3.1-pro-highspeed"]',
      'model = "k3.1-pro-highspeed"',
      'max_context_size = 1_048_576 # 1M',
      '[secondary_model]',
      'max_context_size = 1',
    ].join('\n'));
    expect(readKimiModelContextWindow('kimi-code/k3.1-pro-highspeed', env)).toBe(1_048_576);
    expect(readKimiModelContextWindow('kimi-code/k3-256k', env)).toBe(262_144);
    expect(readKimiModelContextWindow('kimi-code/unknown', env)).toBeUndefined();
    expect(readKimiModelContextWindow(undefined, env)).toBeUndefined();
  });
});
