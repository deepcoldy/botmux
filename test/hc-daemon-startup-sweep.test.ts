/**
 * The daemon's hc ownership rules (startup sweep, crash-diagnostic reclaim and
 * suspend precheck). hc runs one core per uid shared by every daemon, so a
 * terminal is this daemon's only when its `botmux_sid` label is a session id of
 * its own store or runtime, and every kill goes through the label-verified
 * killHcTerminal. hc itself is never run here: cli-ops is the seam.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';
import type { HcBotmuxTerminal, HcBotmuxTerminalSweep, HcKillOutcome, HcTarget } from '../src/adapters/backend/hc/cli-ops.js';

const { hcCollect, hcKill, getBotMock, getAllBotsMock } = vi.hoisted(() => ({
  hcCollect: vi.fn(),
  hcKill: vi.fn(),
  getBotMock: vi.fn(),
  getAllBotsMock: vi.fn(),
}));

vi.mock('../src/adapters/backend/hc/cli-ops.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/adapters/backend/hc/cli-ops.js')>(),
  collectBotmuxHcTerminals: hcCollect,
  killHcTerminal: hcKill,
}));
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: {
    sessionName: (id: string) => `bmx-${id.slice(0, 8)}`,
    killSession: vi.fn(),
    listBotmuxSessions: vi.fn(() => []),
  },
}));
vi.mock('../src/adapters/backend/herdr-backend.js', () => ({
  HerdrBackend: {
    sessionName: (id: string) => `bmx-${id.slice(0, 8)}`,
    killSession: vi.fn(),
    killAgent: vi.fn(),
    killAgents: vi.fn(),
    listBotmuxSessions: vi.fn(() => []),
  },
}));
vi.mock('../src/adapters/backend/zellij-backend.js', () => ({
  ZellijBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: vi.fn() },
}));
vi.mock('../src/adapters/backend/zmx-backend.js', () => ({
  ZmxBackend: {
    sessionName: (id: string) => `bmx-${id.slice(0, 8)}`,
    killManagedSession: vi.fn(),
    listBotmuxSessions: vi.fn(() => []),
  },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: getBotMock,
  getBotBrand: vi.fn(() => 'feishu'),
  getAllBots: getAllBotsMock,
  resolveBrandLabel: vi.fn(() => undefined),
}));
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: vi.fn(),
  sendUserMessage: vi.fn(),
  addReaction: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));
vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
  deleteFrozenCards: vi.fn(),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { config } from '../src/config.js';
import { destroySuspendBackingVerified, killStalePids, killWorker } from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';

const CLOSED = '11111111-0000-4000-8000-000000000001';
const ACTIVE = '22222222-0000-4000-8000-000000000002';
const FOREIGN = '33333333-0000-4000-8000-000000000003';
const RUNTIME = '44444444-0000-4000-8000-000000000004';
const QUARANTINED = '55555555-0000-4000-8000-000000000005';
const BOUND = '66666666-0000-4000-8000-000000000006';

let dataDir: string;
let runtimeDir: string;
let defaultSocket: string;
const previous = { dataDir: config.session.dataDir, backendType: config.daemon.backendType, cliId: config.daemon.cliId };

const hcTarget = (sid: string, socket = defaultSocket): HcTarget => ({
  backendType: 'hc', sessionName: `bmx-${sid.slice(0, 8)}`, hcSession: 'botmux', socket,
});
const terminal = (sid: string, socket = defaultSocket): HcBotmuxTerminal => ({
  sessionId: sid, target: hcTarget(sid, socket), address: 'w1:1', state: 'live',
});
const row = (sessionId: string, over: Record<string, unknown> = {}) => ({
  sessionId, status: 'active', backendType: 'hc', cliId: 'claude-code', larkAppId: 'app_hc',
  persistentBackendTarget: hcTarget(sessionId), ...over,
}) as any;
const listing = (...terminals: HcBotmuxTerminal[]): HcBotmuxTerminalSweep => ({ terminals, failures: [] });
const killedSessionIds = () => hcKill.mock.calls.map(([, sid]) => sid);

beforeEach(() => {
  vi.clearAllMocks();
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-hc-sweep-'));
  runtimeDir = mkdtempSync('/tmp/hcs-');
  defaultSocket = join(runtimeDir, 'herdr-core', 'botmux.sock');
  mkdirSync(join(runtimeDir, 'herdr-core'));
  writeFileSync(defaultSocket, '');
  vi.stubEnv('XDG_RUNTIME_DIR', runtimeDir);
  config.session.dataDir = dataDir;
  config.daemon.cliId = 'claude-code';
  getAllBotsMock.mockReturnValue([{ config: { larkAppId: 'app_hc', cliId: 'claude-code', backendType: 'hc' } }]);
  getBotMock.mockReturnValue({ resolvedAllowedUsers: [], config: { larkAppId: 'app_hc', cliId: 'claude-code', backendType: 'hc' } });
  hcCollect.mockReturnValue(listing());
  hcKill.mockImplementation((target: HcTarget): HcKillOutcome => ({ result: 'killed', address: `${target.sessionName}:1` }));
  sessionStore.init('hc-sweep-test');
});
afterEach(() => {
  vi.unstubAllEnvs();
  config.session.dataDir = previous.dataDir;
  config.daemon.backendType = previous.backendType;
  config.daemon.cliId = previous.cliId;
  sessionStore.init('test-app');
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(runtimeDir, { recursive: true, force: true });
});

describe('hc startup sweep', () => {
  it('ends a terminal of its own closed session, never an active one or another store\'s', () => {
    const active = row(ACTIVE);
    sessionStore.updateSession(active);
    sessionStore.updateSession(row(CLOSED, { status: 'closed' }));
    hcCollect.mockReturnValue(listing(terminal(CLOSED), terminal(ACTIVE), terminal(FOREIGN)));

    killStalePids([active]);

    expect(hcCollect).toHaveBeenCalledWith([{ hcSession: 'botmux', socket: defaultSocket }]);
    expect(hcKill.mock.calls).toEqual([[hcTarget(CLOSED), CLOSED]]);
  });

  it('lists only cores whose socket exists, since listing a gone core would start one', () => {
    const goneSocket = join(runtimeDir, 'gone', 'herdr-core', 'botmux.sock');
    sessionStore.updateSession(row(CLOSED, { status: 'closed', persistentBackendTarget: hcTarget(CLOSED, goneSocket) }));

    killStalePids([]);
    expect(hcCollect).toHaveBeenCalledWith([{ hcSession: 'botmux', socket: defaultSocket }]);

    hcCollect.mockClear();
    rmSync(defaultSocket);
    killStalePids([]);
    expect(hcCollect).not.toHaveBeenCalled();
  });

  it('also sweeps the core a stored session was frozen onto', () => {
    const otherSocket = join(runtimeDir, 'other.sock');
    writeFileSync(otherSocket, '');
    sessionStore.updateSession(row(CLOSED, { status: 'closed', persistentBackendTarget: hcTarget(CLOSED, otherSocket) }));
    hcCollect.mockReturnValue(listing(terminal(CLOSED, otherSocket)));

    killStalePids([]);

    expect(hcCollect.mock.calls[0]![0]).toEqual(expect.arrayContaining([
      { hcSession: 'botmux', socket: defaultSocket }, { hcSession: 'botmux', socket: otherSocket },
    ]));
    expect(hcKill.mock.calls).toEqual([[hcTarget(CLOSED, otherSocket), CLOSED]]);
  });

  it('keeps the terminals of runtime and restore-quarantined sessions', () => {
    const runtime = row(RUNTIME);
    sessionStore.updateSession(row(QUARANTINED, { restoreQuarantinedAt: '2026-11-08T00:00:00Z' }));
    hcCollect.mockReturnValue(listing(terminal(RUNTIME), terminal(QUARANTINED)));

    killStalePids([], new Map([['runtime', { session: runtime } as unknown as DaemonSession]]));

    expect(hcKill).not.toHaveBeenCalled();
  });

  it('on a CLI change ends only its own settled, non-runtime terminals', () => {
    writeFileSync(join(dataDir, 'last-cli-id-hc'), 'codex', 'utf8');
    const active = row(ACTIVE);
    const runtime = row(RUNTIME);
    sessionStore.updateSession(active);
    hcCollect.mockReturnValue(listing(terminal(ACTIVE), terminal(RUNTIME), terminal(FOREIGN)));

    killStalePids([active], new Map([['runtime', { session: runtime } as unknown as DaemonSession]]));

    expect(killedSessionIds()).toEqual([ACTIVE]);
    expect(readFileSync(join(dataDir, 'last-cli-id-hc'), 'utf8')).toBe('claude-code');
  });

  it('ends an active terminal running another CLI than its bot, unless the session is instance-bound', () => {
    const mismatched = row(ACTIVE, { cliId: 'codex' });
    const bound = row(BOUND, { cliId: 'codex', cliInstanceBinding: { version: 1, source: 'pool' } });
    sessionStore.updateSession(mismatched);
    sessionStore.updateSession(bound);
    hcCollect.mockReturnValue(listing(terminal(ACTIVE), terminal(BOUND)));

    killStalePids([mismatched, bound]);

    expect(killedSessionIds()).toEqual([ACTIVE]);
  });

  it('never contacts an hc core when no bot, default or session uses hc', () => {
    getAllBotsMock.mockReturnValue([{ config: { larkAppId: 'app_tmux', cliId: 'claude-code', backendType: 'tmux' } }]);
    sessionStore.updateSession(row(CLOSED, { status: 'closed', backendType: 'tmux', persistentBackendTarget: undefined }));

    killStalePids([]);

    expect(hcCollect).not.toHaveBeenCalled();
  });
});

describe('hc crash diagnostic', () => {
  const SID = '77777777-0000-4000-8000-000000000007';
  const diagnostic = (): HcTarget => ({ ...hcTarget(SID), sessionName: 'bmx-diag-77777777' });
  const hcSession = (over: Partial<DaemonSession> = {}): DaemonSession => ({
    larkAppId: 'app_hc', chatId: 'oc_hc', chatType: 'group', scope: 'chat', worker: null,
    session: { sessionId: SID, status: 'active', backendType: 'hc', persistentBackendTarget: hcTarget(SID) },
    initConfig: { backendType: 'hc' },
    ...over,
  } as unknown as DaemonSession);

  it('is reclaimed on its session\'s core through the label-verified kill when a workerless session closes', () => {
    hcKill.mockImplementation((target: HcTarget): HcKillOutcome => (target.sessionName === 'bmx-diag-77777777'
      ? { result: 'mismatch', address: 'w9:1', owner: FOREIGN }
      : { result: 'killed', address: 'w1:1' }));

    expect(() => killWorker(hcSession())).not.toThrow();

    expect(hcKill).toHaveBeenCalledWith(diagnostic(), SID);
    expect(hcKill).toHaveBeenCalledWith(hcTarget(SID), SID);
  });

  it('must be proven gone on that core before a suspend', () => {
    const kill = vi.fn();
    const probe = vi.fn(() => 'missing' as const);

    expect(destroySuspendBackingVerified(hcSession({ crashDiagnosticParked: true }), { kill, probe })).toBe(true);

    expect(kill.mock.calls[0]).toEqual([diagnostic(), SID]);
    expect(probe.mock.calls[0]).toEqual([diagnostic()]);
    expect(kill).toHaveBeenLastCalledWith(hcTarget(SID), SID);
  });

  it.each(['exists', 'unknown'] as const)('refuses the suspend when it stays %s, before touching the CLI terminal', state => {
    const kill = vi.fn((target: HcTarget) => {
      if (target.sessionName === 'bmx-diag-77777777') throw new Error('held by another session');
    });
    const probe = vi.fn((target: HcTarget) => (target.sessionName === 'bmx-diag-77777777' ? state : 'missing'));

    expect(destroySuspendBackingVerified(hcSession({ crashDiagnosticParked: true }), { kill, probe })).toBe(false);

    expect(kill.mock.calls.map(([target]) => target.sessionName)).toEqual(['bmx-diag-77777777', 'bmx-diag-77777777']);
  });
});
