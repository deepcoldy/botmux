import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claimCliPidMarkerFile,
  releaseCliPidMarkerFile,
  updateCliPidMarkerFile,
  type CliPidMarkerRecord,
} from '../src/core/cli-pid-marker.js';

describe('CLI PID marker ownership', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'botmux-cli-pid-marker-'));
    path = join(dir, '16493');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function marker(overrides: Partial<CliPidMarkerRecord> = {}): CliPidMarkerRecord {
    return {
      sessionId: 'session-a',
      turnId: 'turn-a',
      dispatchAttempt: 1,
      procStart: '100',
      workerPid: 1001,
      ...overrides,
    };
  }

  it('claims, updates each turn, and releases its own marker', () => {
    expect(claimCliPidMarkerFile(path, marker())).toEqual({ written: true });
    expect(updateCliPidMarkerFile(path, marker({ turnId: 'turn-b', dispatchAttempt: 2 }))).toEqual({ written: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      sessionId: 'session-a',
      turnId: 'turn-b',
      dispatchAttempt: 2,
      workerPid: 1001,
    });
    expect(releaseCliPidMarkerFile(path, marker())).toBe(true);
    expect(existsSync(path)).toBe(false);
  });

  it('lets a restored worker reclaim the same session and fences the old generation', () => {
    expect(claimCliPidMarkerFile(path, marker())).toEqual({ written: true });
    expect(claimCliPidMarkerFile(path, marker({ workerPid: 2002 }))).toEqual({ written: true });

    expect(updateCliPidMarkerFile(path, marker({ turnId: 'stale-turn' }))).toEqual({
      written: false,
      ownerSessionId: 'session-a',
      ownerWorkerPid: 2002,
    });
    expect(releaseCliPidMarkerFile(path, marker())).toBe(false);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ workerPid: 2002, turnId: 'turn-a' });
    expect(releaseCliPidMarkerFile(path, marker({ workerPid: 2002 }))).toBe(true);
  });

  it('does not overwrite a marker owned by another session on the same process', () => {
    expect(claimCliPidMarkerFile(path, marker())).toEqual({ written: true });
    expect(claimCliPidMarkerFile(path, marker({ sessionId: 'session-b', workerPid: 2002 }))).toEqual({
      written: false,
      ownerSessionId: 'session-a',
      ownerWorkerPid: 1001,
    });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ sessionId: 'session-a' });
  });

  it('replaces a different-session marker only when proc starttime proves PID reuse', () => {
    expect(claimCliPidMarkerFile(path, marker())).toEqual({ written: true });
    expect(claimCliPidMarkerFile(path, marker({
      sessionId: 'session-b',
      procStart: '200',
      workerPid: 2002,
    }))).toEqual({ written: true });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      sessionId: 'session-b',
      procStart: '200',
      workerPid: 2002,
    });
  });
});
