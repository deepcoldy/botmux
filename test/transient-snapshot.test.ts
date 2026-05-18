/**
 * Tests for transient-snapshot helper.
 *
 * The helper short-circuits to null for non-TmuxPipeBackend inputs so the
 * caller can fall back to the long-lived renderer. For TmuxPipeBackend it
 * pulls capture-pane + display-message via the backend's own methods.
 *
 * We don't render real PNGs here — that path is exercised by the
 * screenshot-renderer test. Here we verify the routing + the dimensions
 * end up correct after clamping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawnSync: vi.fn(),
}));

vi.mock('node:fs', async () => {
  const actual: any = await vi.importActual('node:fs');
  return {
    ...actual,
    openSync: vi.fn(() => 7),
    createReadStream: vi.fn(() => {
      const handlers: Record<string, Array<(...a: any[]) => void>> = {};
      return {
        on(event: string, cb: any) { (handlers[event] ??= []).push(cb); return this; },
        emit(event: string, ...args: any[]) { for (const cb of handlers[event] ?? []) cb(...args); },
        destroy: vi.fn(),
      };
    }),
    unlinkSync: vi.fn(),
    constants: actual.constants,
  };
});

// captureToPng would try to use the canvas — stub it for tests so we can
// verify the wiring without actually rendering a PNG.
vi.mock('../src/utils/screenshot-renderer.js', () => ({
  captureToPng: vi.fn(() => Buffer.from('FAKE_PNG_BYTES')),
}));

import { execSync, spawnSync } from 'node:child_process';
import { TmuxPipeBackend } from '../src/adapters/backend/tmux-pipe-backend.js';
import { snapshotToPng, snapshotToText, tryCapturePipeSnapshot } from '../src/utils/transient-snapshot.js';
import { captureToPng } from '../src/utils/screenshot-renderer.js';

const mockedExecSync = vi.mocked(execSync);
const mockedSpawnSync = vi.mocked(spawnSync);
const mockedCaptureToPng = vi.mocked(captureToPng);

function spawnedBackend() {
  const be = new TmuxPipeBackend('bmx-test', { ownsSession: true });
  be.spawn('', [], { cwd: '/tmp', cols: 160, rows: 50, env: process.env as Record<string, string> });
  return be;
}

beforeEach(() => {
  mockedExecSync.mockReset();
  mockedSpawnSync.mockReset();
  mockedSpawnSync.mockReturnValue({ status: 0 } as any);
  mockedExecSync.mockReturnValue(Buffer.from('') as any);
  mockedCaptureToPng.mockClear();
});

describe('tryCapturePipeSnapshot', () => {
  it('returns null for non-TmuxPipeBackend inputs', () => {
    expect(tryCapturePipeSnapshot(null, 160, 50)).toBeNull();
    expect(tryCapturePipeSnapshot({}, 160, 50)).toBeNull();
    expect(tryCapturePipeSnapshot('not a backend', 160, 50)).toBeNull();
  });

  it('returns null when the backend can\'t produce a snapshot', () => {
    const be = spawnedBackend();
    mockedExecSync.mockReset();
    // getPaneSize ok, alternate_on probe ok, capture-pane fails
    mockedExecSync
      .mockReturnValueOnce('200 60\n' as any)
      .mockReturnValueOnce('0\n' as any)
      .mockImplementationOnce(() => { throw new Error('boom'); });
    expect(tryCapturePipeSnapshot(be, 160, 50)).toBeNull();
  });

  it('uses live pane dimensions when available', () => {
    const be = spawnedBackend();
    mockedExecSync.mockReset();
    mockedExecSync
      .mockReturnValueOnce('200 60\n' as any)         // getPaneSize
      .mockReturnValueOnce('0\n' as any)              // alternate_on probe
      .mockReturnValueOnce('snapshot ansi\n' as any); // capture-pane
    const snap = tryCapturePipeSnapshot(be, 160, 50);
    expect(snap).not.toBeNull();
    expect(snap!.cols).toBe(200);
    expect(snap!.rows).toBe(60);
    expect(snap!.ansi).toBe('snapshot ansi\r\n');
  });

  it('falls back to default dimensions when getPaneSize returns null', () => {
    const be = spawnedBackend();
    mockedExecSync.mockReset();
    mockedExecSync
      .mockImplementationOnce(() => { throw new Error('no server'); })  // getPaneSize fails
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('fallback\n' as any);
    const snap = tryCapturePipeSnapshot(be, 160, 50);
    expect(snap!.cols).toBe(160);
    expect(snap!.rows).toBe(50);
  });

  it('clamps oversized pane dimensions to MAX bounds', () => {
    const be = spawnedBackend();
    mockedExecSync.mockReset();
    mockedExecSync
      .mockReturnValueOnce('9999 9999\n' as any)
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('clamped\n' as any);
    const snap = tryCapturePipeSnapshot(be, 160, 50);
    // MAX_RENDER_COLS=320, MAX_RENDER_ROWS=100 (see render-dimensions.ts)
    expect(snap!.cols).toBe(320);
    expect(snap!.rows).toBe(100);
  });

  it('asks tmux for viewport-only (no -S flag, otherwise tmux concatenates scrollback)', () => {
    const be = spawnedBackend();
    mockedExecSync.mockReset();
    mockedExecSync
      .mockReturnValueOnce('200 60\n' as any)
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('content\n' as any);
    tryCapturePipeSnapshot(be, 160, 50);
    const captureCall = mockedExecSync.mock.calls.find(c => String(c[0]).includes('capture-pane'));
    expect(String(captureCall![0])).not.toContain('-S');
  });
});

describe('snapshotToPng', () => {
  it('returns null for non-pipe backends so caller falls back to legacy renderer', async () => {
    const result = await snapshotToPng({}, 160, 50);
    expect(result).toBeNull();
    expect(mockedCaptureToPng).not.toHaveBeenCalled();
  });

  it('renders a PNG through a transient terminal seeded with capture-pane output', async () => {
    const be = spawnedBackend();
    mockedExecSync.mockReset();
    mockedExecSync
      .mockReturnValueOnce('200 60\n' as any)
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('hello world\n' as any);
    const result = await snapshotToPng(be, 160, 50);
    expect(result).not.toBeNull();
    expect(result!.png.toString()).toBe('FAKE_PNG_BYTES');
    expect(result!.ansi).toBe('hello world\r\n');
    expect(mockedCaptureToPng).toHaveBeenCalledTimes(1);
    // Transient renderer must be sized off the live pane, not the fallback.
    const opts = mockedCaptureToPng.mock.calls[0][1];
    expect(opts).toEqual({ cols: 200, rows: 60, startY: 0 });
  });
});

describe('snapshotToText', () => {
  it('returns null for non-pipe backends', async () => {
    const result = await snapshotToText({}, 160, 50, { filter: true });
    expect(result).toBeNull();
  });

  it('returns filtered viewport text from a transient terminal', async () => {
    const be = spawnedBackend();
    mockedExecSync.mockReset();
    mockedExecSync
      .mockReturnValueOnce('200 60\n' as any)
      .mockReturnValueOnce('0\n' as any)
      .mockReturnValueOnce('line one\nline two\n' as any);
    const result = await snapshotToText(be, 160, 50, { filter: true });
    expect(result).not.toBeNull();
    expect(result!.content).toContain('line one');
    expect(result!.content).toContain('line two');
  });
});
