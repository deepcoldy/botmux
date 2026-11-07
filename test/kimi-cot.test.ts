import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CotEntry } from '../src/types.js';
import { KimiActivityObserver } from '../src/services/kimi-cot.js';
import { makeKimiSession, toJsonl, toolTurn, wire } from './helpers/kimi-wire-fixture.js';

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

function observe(home: string, opts: { resume: boolean; spawnStartMs?: number }) {
  const background: CotEntry[] = [];
  const observer = new KimiActivityObserver({
    botmuxSessionId: BOTMUX,
    markerSessionId: BOTMUX,
    workingDir: home,
    env: { KIMI_CODE_HOME: home },
    resume: opts.resume,
    spawnStartMs: opts.spawnStartMs ?? Date.now(),
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
    const { observer } = observe(home, { resume: false, spawnStartMs });
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
    const s = makeKimiSession(home, { id: 'session_a', workDir: home, lastPrompt: envelope('x'), records: [wire.metadata()] });
    const { observer } = observe(home, { resume: true });
    const line = toJsonl([wire.toolCall('tool_z', 'Bash', { command: 'pwd' })]);
    appendFileSync(s.wirePath, line.slice(0, 40));
    expect(observer.drain()).toEqual([]);
    appendFileSync(s.wirePath, line.slice(40));
    expect(observer.drain()).toEqual([{ kind: 'tool_call', id: 'tool_z', name: 'Bash', args: '{"command":"pwd"}', subject: 'pwd' }]);
    expect(observer.drain()).toEqual([]);
  });

  it('does not replay history after the log shrinks, and stops cleanly', () => {
    const home = tmp();
    const s = makeKimiSession(home, { id: 'session_a', workDir: home, lastPrompt: envelope('x'), records: toolTurn(0, envelope('x')) });
    const { observer } = observe(home, { resume: true });
    truncateSync(s.wirePath, 10);
    expect(observer.drain()).toEqual([]);
    s.append(toolTurn(1, envelope('y')));
    // Followed from the shrunken end: only what was appended afterwards.
    expect(kinds(observer.drain())).toEqual(['thinking', 'text', 'tool_call', 'tool_result', 'thinking']);
    observer.stop();
    s.append(toolTurn(2, envelope('z')));
    expect(observer.drain()).toEqual([]);
  });
});
