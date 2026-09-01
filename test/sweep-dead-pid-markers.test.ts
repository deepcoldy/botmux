/**
 * Unit tests for sweepDeadPidMarkers (worker-pool.ts) — the daemon-startup GC
 * that removes dead CLI-pid marker files from `.botmux-cli-pids/`.
 *
 * Why it exists: marker files are named for the PID that wrote them. When that
 * PID exits the file lingers, and the kernel eventually recycles the number onto
 * an unrelated process; a `botmux send` climbing its ancestry then reads a
 * since-exited session's marker and routes into the WRONG bot's session (a real
 * cross-bot leak). Fix A rejects such a marker at read time; this sweep removes
 * the file so the collision can't be attempted and the dir can't grow unbounded
 * (graceful exit unlinks its own marker, but SIGKILL/crash/force-kill do not).
 *
 * Cross-daemon safety contract asserted here: only DEAD-pid markers are removed;
 * a live pid's marker (possibly owned by a peer daemon sharing the data dir) is
 * always kept.
 *
 * Run:  pnpm vitest run test/sweep-dead-pid-markers.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// worker-pool.ts pulls in backends / lark client / registry on import; mock the
// heavy side-effect modules so we can import the pure fs sweep in isolation.
vi.mock('../src/adapters/backend/tmux-backend.js', () => ({
  TmuxBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: vi.fn(), listBotmuxSessions: vi.fn(() => []) },
}));
vi.mock('../src/adapters/backend/herdr-backend.js', () => ({
  HerdrBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: vi.fn(), killAgent: vi.fn(), listBotmuxSessions: vi.fn(() => []) },
}));
vi.mock('../src/adapters/backend/zellij-backend.js', () => ({
  ZellijBackend: { sessionName: (id: string) => `bmx-${id.slice(0, 8)}`, killSession: vi.fn() },
}));
vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ resolvedAllowedUsers: [], config: {} })),
  getAllBots: vi.fn(() => []),
  resolveBrandLabel: vi.fn(() => undefined),
}));
vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(), deleteMessage: vi.fn(), sendEphemeralCard: vi.fn(),
  sendUserMessage: vi.fn(), addReaction: vi.fn(), removeReaction: vi.fn(),
  getMessageChatId: vi.fn(), MessageWithdrawnError: class extends Error {},
}));
vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()), saveFrozenCards: vi.fn(),
}));
vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { sweepDeadPidMarkers, defaultPidLiveness } from '../src/core/worker-pool.js';

// Liveness is INJECTED so the test never depends on which PIDs the host has
// actually allocated. Picking a "surely-dead" literal is unsafe — any value
// below pid_max (4_194_303 on Linux) can collide with a live process on a busy
// runner and flake. Here `LIVE`/`DEAD` are pure labels backed by a fixed set.
const LIVE = 111;
const DEAD = 222;
const alive = new Set([LIVE]);
const fakeLiveness = (pid: number) => alive.has(pid);

describe('sweepDeadPidMarkers()', () => {
  let dir: string;
  let markersDir: string;
  const marker = (pid: number | string) => join(markersDir, String(pid));
  const write = (pid: number | string, body = JSON.stringify({ sessionId: 's' })) => {
    writeFileSync(marker(pid), body);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sweep-'));
    markersDir = join(dir, '.botmux-cli-pids');
    mkdirSync(markersDir, { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('removes a marker whose PID is dead', () => {
    write(DEAD);
    expect(sweepDeadPidMarkers(dir, fakeLiveness)).toBe(1);
    expect(existsSync(marker(DEAD))).toBe(false);
  });

  it('keeps a marker whose PID is alive (never touches a peer daemon’s live session)', () => {
    write(LIVE);
    expect(sweepDeadPidMarkers(dir, fakeLiveness)).toBe(0);
    expect(existsSync(marker(LIVE))).toBe(true);
  });

  it('sweeps only the dead ones in a mixed directory', () => {
    write(LIVE);
    write(DEAD);
    write(DEAD + 1);
    expect(sweepDeadPidMarkers(dir, fakeLiveness)).toBe(2);
    expect(existsSync(marker(LIVE))).toBe(true);
    expect(existsSync(marker(DEAD))).toBe(false);
    expect(existsSync(marker(DEAD + 1))).toBe(false);
  });

  it('ignores non-PID entries (never deletes stray files)', () => {
    writeFileSync(marker('not-a-pid'), 'x');
    writeFileSync(marker('0'), 'x');   // pid 0/1 are not real CLI markers
    writeFileSync(marker('1'), 'x');
    // Guard: even if the fake probe were asked, non-pid names must be skipped
    // before liveness is ever consulted.
    expect(sweepDeadPidMarkers(dir, () => false)).toBe(0);
    expect(existsSync(marker('not-a-pid'))).toBe(true);
    expect(existsSync(marker('0'))).toBe(true);
    expect(existsSync(marker('1'))).toBe(true);
  });

  it('returns 0 and does not throw when the markers dir is absent (fresh install)', () => {
    rmSync(markersDir, { recursive: true, force: true });
    expect(sweepDeadPidMarkers(dir, fakeLiveness)).toBe(0);
  });

  it('is a no-op on an empty markers dir', () => {
    expect(sweepDeadPidMarkers(dir, fakeLiveness)).toBe(0);
  });
});

describe('defaultPidLiveness()', () => {
  it('reports this live process as alive', () => {
    expect(defaultPidLiveness(process.pid)).toBe(true);
  });

  it('reports a PID above pid_max as dead (cannot exist)', () => {
    // 2^22 + 1 exceeds Linux pid_max default; process.kill → ESRCH → dead.
    expect(defaultPidLiveness(4_194_305)).toBe(false);
  });

  it('treats an EPERM probe (alive but not ours to signal) conservatively as alive', () => {
    // Force the EPERM branch deterministically — on a root runner process.kill(1,0)
    // succeeds, so a bare pid-1 assertion would never actually exercise it. Stub
    // process.kill to throw EPERM and confirm the probe keeps the PID (never
    // reports a live-but-unsignalable process as dead → sweep won't delete it).
    const realKill = process.kill;
    try {
      (process as any).kill = () => { const e: any = new Error('operation not permitted'); e.code = 'EPERM'; throw e; };
      expect(defaultPidLiveness(1234)).toBe(true);
    } finally {
      process.kill = realKill;
    }
  });

  it('treats an unknown probe error conservatively as alive (never guesses dead)', () => {
    const realKill = process.kill;
    try {
      (process as any).kill = () => { const e: any = new Error('weird'); e.code = 'EIO'; throw e; };
      expect(defaultPidLiveness(1234)).toBe(true);
    } finally {
      process.kill = realKill;
    }
  });
});
