import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CotEntry } from '../src/types.js';
import { KimiActivityObserver } from '../src/services/kimi-cot.js';
import { makeKimiSession, setLastPrompt, toJsonl, toolTurn, wire } from './helpers/kimi-wire-fixture.js';

let root: string | undefined;
const observers: KimiActivityObserver[] = [];
afterEach(() => {
  for (const o of observers.splice(0)) o.stop();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});
const tmp = () => (root = mkdtempSync(join(tmpdir(), 'kimi-cot-')));

const BOTMUX = '4c0a8f9e-1b2d-4e3f-8a5b-6c7d8e9f0a1b';
const envelope = (text: string) => `<session_id>${BOTMUX}</session_id>\n${text}`;

function observe(home: string, opts: { resume: boolean }) {
  const background: CotEntry[] = [];
  const observer = new KimiActivityObserver({
    botmuxSessionId: BOTMUX,
    markerSessionId: BOTMUX,
    workingDir: home,
    env: { KIMI_CODE_HOME: home },
    resume: opts.resume,
    onEntries: entries => background.push(...entries),
    pollIntervalMs: 60_000,
  });
  observers.push(observer);
  observer.start();
  return { observer, background };
}

const kinds = (entries: readonly CotEntry[]) => entries.map(e => e.kind);

describe('Kimi activity observer', () => {
  it('on resume follows the resumed session from its end, never replaying history', () => {
    const home = tmp();
    const s = makeKimiSession(home, {
      id: 'session_a', workDir: home, lastPrompt: envelope('old'),
      records: [wire.metadata(), ...toolTurn(0, envelope('old'))], createdAt: Date.now() - 3_600_000,
    });
    const { observer } = observe(home, { resume: true });
    expect(observer.boundWirePath).toBe(s.wirePath);
    expect(observer.drain()).toEqual([]);
    s.append(toolTurn(1, envelope('new')));
    expect(kinds(observer.drain())).toEqual(['thinking', 'text', 'tool_call', 'tool_result', 'thinking']);
    expect(observer.drain()).toEqual([]);
  });

  it('on a fresh spawn waits for the session Kimi creates and reads its first turn in full', () => {
    const home = tmp();
    const spawnStartMs = Date.now();
    // A previous generation of the same botmux session must not be followed.
    makeKimiSession(home, {
      id: 'session_old', workDir: home, lastPrompt: envelope('old'),
      records: toolTurn(0, envelope('old')), createdAt: spawnStartMs - 3_600_000,
    });
    const { observer } = observe(home, { resume: false });
    expect(observer.drain()).toEqual([]);
    expect(observer.boundWirePath).toBeUndefined();
    const fresh = makeKimiSession(home, {
      id: 'session_new', workDir: home, records: toolTurn(0, envelope('first')), createdAt: spawnStartMs + 100,
    });
    expect(kinds(observer.drain())).toEqual(['thinking', 'text', 'tool_call', 'tool_result', 'thinking']);
    expect(observer.boundWirePath).toBe(fresh.wirePath);
  });

  it('a resume that finds no session behaves like a fresh spawn', () => {
    const home = tmp();
    const { observer } = observe(home, { resume: true });
    expect(observer.boundWirePath).toBeUndefined();
    makeKimiSession(home, { id: 'session_new', workDir: home, records: toolTurn(0, envelope('first')) });
    expect(observer.drain().length).toBeGreaterThan(0);
  });

  it('consumes a record only once it is complete, exactly once', () => {
    const home = tmp();
    const s = makeKimiSession(home, { id: 'session_a', workDir: home, lastPrompt: envelope('x'), records: [wire.metadata(), wire.prompt(0, envelope('x'))] });
    const { observer } = observe(home, { resume: true });
    expect(observer.boundWirePath).toBe(s.wirePath);
    const line = toJsonl([wire.toolCall('tool_z', 'Bash', { command: 'pwd' })]);
    appendFileSync(s.wirePath, line.slice(0, 40));
    expect(observer.drain()).toEqual([]);
    appendFileSync(s.wirePath, line.slice(40));
    expect(observer.drain()).toEqual([{ kind: 'tool_call', id: 'tool_z', name: 'Bash', args: '{"command":"pwd"}', subject: 'pwd' }]);
    expect(observer.drain()).toEqual([]);
  });

  it('does not replay history after the log shrinks, and stops cleanly', () => {
    const home = tmp();
    const s = makeKimiSession(home, {
      id: 'session_a', workDir: home, lastPrompt: envelope('x'),
      records: [...toolTurn(0, envelope('x')), ...toolTurn(1, envelope('x2'))],
    });
    const { observer } = observe(home, { resume: true });
    // Shrinks but still holds a whole earlier turn: that turn is history.
    truncateSync(s.wirePath, Buffer.byteLength(toJsonl(toolTurn(0, envelope('x')))));
    expect(observer.drain()).toEqual([]);
    s.append(toolTurn(1, envelope('y')));
    // Followed from the shrunken end: only what was appended afterwards.
    expect(kinds(observer.drain())).toEqual(['thinking', 'text', 'tool_call', 'tool_result', 'thinking']);
    observer.stop();
    s.append(toolTurn(2, envelope('z')));
    expect(observer.drain()).toEqual([]);
  });

  it('follows a new Kimi generation of the same botmux session (`/new` passed through)', () => {
    const home = tmp();
    const a = makeKimiSession(home, {
      id: 'session_a', workDir: home, lastPrompt: envelope('old'),
      records: toolTurn(0, envelope('old')), createdAt: Date.now() - 60_000,
    });
    const { observer } = observe(home, { resume: true });
    expect(observer.boundWirePath).toBe(a.wirePath);
    // The last step of the old generation lands, then `/new` starts session_b.
    a.append([wire.toolCall('tool_tail', 'Read', { path: '/tmp/tail' })]);
    const b = makeKimiSession(home, { id: 'session_b', workDir: home, lastPrompt: envelope('after new'), records: [] });
    b.append([wire.prompt(0, envelope('after new')), wire.toolCall('tool_b', 'Bash', { command: 'whoami' })]);
    const entries = observer.drain();
    expect(entries.map(e => e.kind === 'tool_call' ? e.id : e.kind)).toEqual(['tool_tail', 'tool_b']);
    expect(observer.boundWirePath).toBe(b.wirePath);
    // Never moves back to the old generation.
    a.append([wire.toolCall('tool_late', 'Read', { path: '/tmp/late' })]);
    expect(observer.drain()).toEqual([]);
  });

  it('never binds a previous generation that already existed when the spawn started', () => {
    const home = tmp();
    const spawnStartMs = Date.now();
    // Crashed seconds before this spawn: inside any clock slack, still history.
    makeKimiSession(home, {
      id: 'session_dead', workDir: home, lastPrompt: envelope('dead'),
      records: toolTurn(0, envelope('dead')), createdAt: spawnStartMs - 3_000,
    });
    const { observer } = observe(home, { resume: false });
    expect(observer.drain()).toEqual([]);
    // Another conversation's session changes the index: still not ours.
    makeKimiSession(home, { id: 'session_other', workDir: home, lastPrompt: '<session_id>someone-else</session_id>\nhi', records: [] });
    expect(observer.drain()).toEqual([]);
    expect(observer.boundWirePath).toBeUndefined();
    const fresh = makeKimiSession(home, { id: 'session_new', workDir: home, records: toolTurn(0, envelope('first')) });
    expect(kinds(observer.drain())).toEqual(['thinking', 'text', 'tool_call', 'tool_result', 'thinking']);
    expect(observer.boundWirePath).toBe(fresh.wirePath);
  });

  it('binds a `/new` session whenever its first prompt arrives, however late', () => {
    const home = tmp();
    const a = makeKimiSession(home, { id: 'session_a', workDir: home, records: toolTurn(0, envelope('old')) });
    const { observer } = observe(home, { resume: true });
    expect(observer.boundWirePath).toBe(a.wirePath);
    // `/new` indexes an empty session at once; an abandoned one, then another.
    makeKimiSession(home, { id: 'session_b', workDir: home, records: [] });
    const c = makeKimiSession(home, { id: 'session_c', workDir: home, records: [] });
    for (let i = 0; i < 5; i++) expect(observer.drain()).toEqual([]);
    expect(observer.boundWirePath).toBe(a.wirePath);
    // Minutes later the user writes: Kimi records the prompt in session_c.
    c.append([wire.prompt(0, envelope('later')), wire.toolCall('tool_c', 'Bash', { command: 'date' })]);
    setLastPrompt(c.dir, envelope('later'));
    expect(observer.drain().map(e => e.kind === 'tool_call' ? e.id : e.kind)).toEqual(['tool_c']);
    expect(observer.boundWirePath).toBe(c.wirePath);
    // The abandoned older one is out of the race: no moving back.
    setLastPrompt(join(home, 'sessions', 'wd_work_0123456789ab', 'session_b'), envelope('stray'));
    expect(observer.drain()).toEqual([]);
    expect(observer.boundWirePath).toBe(c.wirePath);
  });
});
