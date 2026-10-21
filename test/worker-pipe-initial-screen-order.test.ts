import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cliAdapterBindsOwnershipPid } from '../src/adapters/cli/ownership-pid.js';
import { loadWorkerFunction } from './helpers/worker-function-harness.js';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('worker close fence for bridge fallback', () => {
  // Close teardown clears the bridge send markers. A fallback read that races
  // it would see "no explicit botmux send" and re-post the turn's answer; the
  // close fence makes both the marker read and the final_output IPC inert.
  function closeFenceHarness() {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-close-fence-'));
    tempDirs.push(dir);
    const markerPath = join(dir, 'bridge-send-markers.jsonl');
    writeFileSync(markerPath, `${JSON.stringify({ sentAtMs: 1_700_000_000_000 })}\nnot json\n`);
    const ipc = vi.fn();
    const scope: Record<string, unknown> = {
      closeRequested: false,
      bridgeMarkerPath: () => markerPath,
      existsSync,
      readFileSync,
      log: vi.fn(),
      workerIpcPayload: (msg: unknown) => msg,
      isWorkflowWorker: () => false,
      workflowFinalOutputSent: false,
      process: { send: ipc },
    };
    const readSendMarkers = loadWorkerFunction<() => unknown[]>('readSendMarkers', scope);
    const send = loadWorkerFunction<(msg: { type: string }) => void>('send', scope);
    return { scope, ipc, readSendMarkers, send };
  }

  it('reads explicit send markers and forwards final_output while the session is open', () => {
    const h = closeFenceHarness();
    expect(h.readSendMarkers()).toEqual([{ sentAtMs: 1_700_000_000_000 }]);
    h.send({ type: 'final_output' });
    expect(h.ipc).toHaveBeenCalledWith({ type: 'final_output' });
  });

  it('reports no markers and drops only final_output once close was requested', () => {
    const h = closeFenceHarness();
    h.scope.closeRequested = true;
    expect(h.readSendMarkers()).toEqual([]);
    h.send({ type: 'final_output' });
    expect(h.ipc).not.toHaveBeenCalled();
    h.send({ type: 'session_close_ready' });
    expect(h.ipc).toHaveBeenCalledWith({ type: 'session_close_ready' });
  });
});

describe('managed CLI pid/cwd binding', () => {
  it('binds the managed pid for reasonix, whose session lookup is per-process', () => {
    // Both worker wiring sites (immediate pid and late zellij pid) gate on this
    // one predicate, so reasonix losing it would unbind both paths at once.
    expect(cliAdapterBindsOwnershipPid('reasonix', undefined)).toBe(true);
    expect(cliAdapterBindsOwnershipPid('pi', undefined)).toBe(false);
  });
});
