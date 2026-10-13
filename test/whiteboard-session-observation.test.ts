import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from '../src/types.js';
import type { DaemonSession } from '../src/core/types.js';
import { resolveSessionById } from '../src/cli/resolve-session-by-id.js';
import { seedPersistedSessionRows } from './helpers/session-store-disk.js';

vi.mock('../src/core/cost-calculator.js', () => ({ getSessionTokenUsage: vi.fn(() => null) }));
import { composeRowFromActive, composeRowFromClosed, composeRowFromPersistedActive } from '../src/core/dashboard-rows.js';

const session: Session = {
  sessionId: 'whiteboard_session', larkAppId: 'cli_board', chatId: 'oc_board', rootMessageId: 'om_board',
  status: 'active', scope: 'chat', chatType: 'group', title: 'Board session', createdAt: '2026-09-01T00:00:00.000Z',
};
const modes = [
  ['live', (s: Session) => composeRowFromActive({
    session: s, larkAppId: s.larkAppId, chatId: s.chatId, chatType: s.chatType, workingDir: s.workingDir,
  } as DaemonSession, { includeTokenUsage: false })],
  ['persisted-active', (s: Session) => composeRowFromPersistedActive(s, { includeTokenUsage: false })],
  ['closed', (s: Session) => composeRowFromClosed({ ...s, status: 'closed' }, { includeTokenUsage: false })],
] as const;

describe.each(modes)('whiteboard session observation: %s', (_mode, compose) => {
  it.each(['board_current', undefined])('preserves current binding %s through the daemon resolver', async whiteboardId => {
    const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-observation-'));
    try {
      // The daemon may have rebound or cleared the board since a cached/store
      // snapshot. Missing projection fields must not be repaired from stale data.
      seedPersistedSessionRows(dataDir, 'cli_board', {
        [session.sessionId]: { ...session, whiteboardId: 'board_stale' },
      });
      const result = await resolveSessionById(session.sessionId, {
        dataDir, env: { BOTMUX_LARK_APP_ID: 'cli_board' },
        findDaemon: () => ({ larkAppId: 'cli_board', ipcPort: 9 }), loadSecret: () => 'secret',
        fetchIpc: async () => new Response(JSON.stringify({ session: compose({ ...session, whiteboardId }) })),
        loadSnapshot: () => { throw new Error('An authoritative daemon row must not fall back to stale storage'); },
      });
      expect(result).toMatchObject({ ok: true, source: 'daemon', session: { sessionId: session.sessionId } });
      if (!result.ok) throw new Error(result.reason);
      expect(result.session.whiteboardId).toBe(whiteboardId);
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
});

describe('offline whiteboard session observation', () => {
  it('retains the same binding when only the native store is available', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'whiteboard-observation-'));
    try {
      seedPersistedSessionRows(dataDir, 'cli_board', { [session.sessionId]: { ...session, whiteboardId: 'board_current' } });
      const result = await resolveSessionById(session.sessionId, {
        dataDir, env: { BOTMUX_LARK_APP_ID: 'cli_board' }, findDaemon: () => undefined,
      });
      expect(result).toMatchObject({ ok: true, source: 'store', session: { whiteboardId: 'board_current' } });
    } finally { rmSync(dataDir, { recursive: true, force: true }); }
  });
});
