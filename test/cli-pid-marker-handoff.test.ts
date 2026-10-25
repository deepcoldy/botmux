import { describe, expect, it } from 'vitest';
import { cliSurvivesWorkerExit, handsCliPidMarkerToSuccessor } from '../src/core/cli-pid-marker-handoff.js';

describe('cliSurvivesWorkerExit', () => {
  it('keeps a persistent pane CLI running past the worker, sandboxed or not; a PTY CLI dies with it', () => {
    for (const backendType of ['tmux', 'zellij', 'herdr', 'zmx']) {
      expect(cliSurvivesWorkerExit({ backendType, persistentSessionName: 'bmx-1' })).toBe(true);
    }
    expect(cliSurvivesWorkerExit({ backendType: 'pty', persistentSessionName: 'bmx-1' })).toBe(false);
    expect(cliSurvivesWorkerExit({ backendType: 'tmux', persistentSessionName: undefined })).toBe(false);
  });
});

// A parent-exit worker leaves its CLI PID marker (the executing-turn record)
// only for a CLI that keeps running and will be reattached by a successor.
describe('handsCliPidMarkerToSuccessor', () => {
  const surviving = {
    cliSurvivesExit: true,
    cliRunning: true,
    adoptMode: false,
    codexApp: false,
    rpcEngineEngaged: false,
  };

  it('hands the marker on for a running CLI in a surviving pane', () => {
    expect(handsCliPidMarkerToSuccessor(surviving)).toBe(true);
  });

  it('keeps deleting it for a dying or exited CLI', () => {
    expect(handsCliPidMarkerToSuccessor({ ...surviving, cliSurvivesExit: false })).toBe(false);
    expect(handsCliPidMarkerToSuccessor({ ...surviving, cliRunning: false })).toBe(false);
  });

  it('keeps deleting it for an adopted pane, Codex App and an RPC engine', () => {
    expect(handsCliPidMarkerToSuccessor({ ...surviving, adoptMode: true })).toBe(false);
    expect(handsCliPidMarkerToSuccessor({ ...surviving, codexApp: true })).toBe(false);
    expect(handsCliPidMarkerToSuccessor({ ...surviving, rpcEngineEngaged: true })).toBe(false);
  });
});
