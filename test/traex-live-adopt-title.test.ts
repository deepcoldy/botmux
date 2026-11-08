/**
 * Live /adopt candidates for TraeX read the native thread title from the real
 * state DB (`readTraexThreadTitle`). Live discovery never runs the rollout
 * parser, so the botmux-origin rule must hold on this path too: a thread that
 * botmux spawned must fall back to the project dir instead of rendering its
 * Lark envelope (or a name derived from it) as the card title.
 *
 * Drives the herdr branch end to end (herdr CLI mocked, sqlite real) so the
 * call-site wiring — pane label first, TraeX native title second — is covered
 * together with the filter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/herdr-executable.js', () => ({ herdrExecutable: () => 'herdr' }));
vi.mock('node:child_process', () => {
  const actual = require('node:child_process') as typeof import('node:child_process');
  return { ...actual, execSync: vi.fn(), execFileSync: vi.fn() };
});

import { execFileSync, execSync } from 'node:child_process';
import { discoverAdoptableSessions } from '../src/core/session-discovery.js';
import { buildAdoptEntries } from '../src/im/lark/card-builder.js';
import { openDatabaseSyncNow } from '../src/services/sqlite-compat.js';

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExecSync = vi.mocked(execSync);

const NATIVE_SID = '01a14a68-b8a9-74e0-bc4e-8ad73a773028';
const BOTMUX_SID = '01a14a6b-ace0-7080-971b-d41592af5438';
const LABELLED_SID = '01a14a6c-0000-7000-8000-000000000003';
const MESSY_SID = '01a14a6d-0000-7000-8000-000000000004';
const ENVELOPE = '<session_id>4f6c2e1a-1111-4222-8333-944455556666</session_id>\n<user_message>\n请只回复两个字：收到。\n</user_message>';

let traeHome: string;
let previousTraeHome: string | undefined;

/** TraeX 0.210.1 `threads` subset as measured: display name in `name`, first
 *  prompt only in `preview`, envelope-bearing title on botmux threads. */
function writeThreads(): void {
  mkdirSync(join(traeHome, 'cli'), { recursive: true });
  const db = openDatabaseSyncNow(join(traeHome, 'cli', 'state_5.sqlite'))!;
  db.exec([
    'CREATE TABLE threads (',
    '  id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, updated_at INTEGER NOT NULL, cwd TEXT NOT NULL,',
    "  title TEXT NOT NULL, first_user_message TEXT NOT NULL DEFAULT '', preview TEXT NOT NULL DEFAULT '', name TEXT",
    ');',
  ].join('\n'));
  const insert = db.prepare('INSERT INTO threads VALUES (?, ?, 1792249771, ?, ?, ?, ?, ?)');
  insert.run(NATIVE_SID, '/r1.jsonl', '/work/proj-native', '', '', '请只回复两个字：收到。', '回复确认收到');
  insert.run(BOTMUX_SID, '/r2.jsonl', '/work/proj-botmux', ENVELOPE, ENVELOPE, ENVELOPE, '确认收到消息');
  insert.run(LABELLED_SID, '/r3.jsonl', '/work/proj-label', '', '', 'label beats me', 'Native name under a label');
  insert.run(MESSY_SID, '/r4.jsonl', '/work/proj-messy', '', '', 'external prompt', `Explain <botmux_routing>\n${'长'.repeat(90)}`);
  db.close();
}

function installHerdr(agents: Array<{ paneId: string; sid: string; cwd: string; label?: string }>): void {
  mockedExecFileSync.mockImplementation(((cmd: string, args: string[]) => {
    if (cmd !== 'herdr') throw new Error(`unexpected cmd ${cmd}`);
    if (args[0] === 'session' && args[1] === 'list') {
      return JSON.stringify({ sessions: [{ name: 'work', running: true }] });
    }
    if (args.includes('agent') && args.includes('list')) {
      return JSON.stringify({ result: { agents: agents.map(a => ({
        agent: 'traex',
        pane_id: a.paneId,
        terminal_id: `t-${a.paneId}`,
        cwd: a.cwd,
        agent_session: { kind: 'session_id', value: a.sid },
      })) } });
    }
    if (args.includes('pane') && args.includes('list')) {
      return JSON.stringify({ result: { panes: agents.map(a => ({
        pane_id: a.paneId,
        cwd: a.cwd,
        ...(a.label ? { label: a.label } : {}),
      })) } });
    }
    if (args.includes('pane') && args.includes('process-info')) {
      return JSON.stringify({ result: { process_info: { foreground_processes: [] } } });
    }
    return '';
  }) as any);
}

beforeEach(() => {
  vi.resetAllMocks();
  // No tmux: discovery falls back to herdr-only enumeration.
  mockedExecSync.mockImplementation(() => { throw new Error('no tmux'); });
  previousTraeHome = process.env.TRAE_HOME;
  traeHome = mkdtempSync(join(tmpdir(), 'traex-live-title-'));
  process.env.TRAE_HOME = traeHome;
  writeThreads();
});

afterEach(() => {
  if (previousTraeHome === undefined) delete process.env.TRAE_HOME;
  else process.env.TRAE_HOME = previousTraeHome;
  rmSync(traeHome, { recursive: true, force: true });
});

describe('live TraeX /adopt titles', () => {
  it('shows the native name for an external thread and the project dir for a botmux-origin one', () => {
    installHerdr([
      { paneId: 'w1:p1', sid: NATIVE_SID, cwd: '/work/proj-native' },
      { paneId: 'w1:p2', sid: BOTMUX_SID, cwd: '/work/proj-botmux' },
    ]);

    const sessions = discoverAdoptableSessions('traex');
    const native = sessions.find(s => s.herdrPaneId === 'w1:p1')!;
    const botmux = sessions.find(s => s.herdrPaneId === 'w1:p2')!;
    expect(native).toMatchObject({ sessionId: NATIVE_SID, title: '回复确认收到' });
    expect(botmux.sessionId).toBe(BOTMUX_SID);
    expect('title' in botmux).toBe(false);

    const entries = buildAdoptEntries(sessions, [], 'traex');
    expect(entries.map(e => e.title)).toEqual(['回复确认收到', 'proj-botmux']);
    for (const entry of entries) expect(entry.title).not.toContain('<');
  });

  it('cleans the native name with the shared live-title policy (one line, no tags, 80 code points)', () => {
    installHerdr([{ paneId: 'w1:p4', sid: MESSY_SID, cwd: '/work/proj-messy' }]);

    const [session] = discoverAdoptableSessions('traex');
    expect(session!.title).toBe(`Explain botmux_routing ${'长'.repeat(56)}…`);
    expect(Array.from(session!.title!)).toHaveLength(80);
  });

  it('keeps a manual herdr pane label ahead of the TraeX native name', () => {
    installHerdr([{ paneId: 'w1:p3', sid: LABELLED_SID, cwd: '/work/proj-label', label: 'release-check' }]);

    expect(discoverAdoptableSessions('traex')).toEqual([
      expect.objectContaining({ sessionId: LABELLED_SID, title: 'release-check' }),
    ]);
  });
});
