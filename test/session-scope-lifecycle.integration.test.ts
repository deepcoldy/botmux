import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  probeSessionScopeCapabilities,
  sessionScopeUnitName,
  stopSessionScope,
  userSystemdBusEnv,
  wrapCommandInSessionScope,
} from '../src/core/session-scope.js';

const capabilities = probeSessionScopeCapabilities();
let tmuxAvailable = false;
try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); tmuxAvailable = true; } catch { /* optional host integration */ }

function waitFor(predicate: () => boolean, timeoutMs = 8_000): void {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  }
  throw new Error('timed out waiting for scope lifecycle evidence');
}

function readReadyPids(paths: string[]): number[] | undefined {
  if (!paths.every(existsSync)) return undefined;
  const contents = paths.map(path => readFileSync(path, 'utf8'));
  // Shell redirection creates the file before echo writes the PID and newline.
  if (!contents.every(text => /^[1-9]\d*\n$/.test(text))) return undefined;
  const pids = contents.map(text => Number(text.trim()));
  return pids.every(pid => Number.isSafeInteger(pid) && pid > 1) ? pids : undefined;
}

it('waits for complete PID contents after shell redirection creates the files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-scope-pid-test-'));
  const paths = ['root.pid', 'child.pid', 'grandchild.pid'].map(name => join(dir, name));
  try {
    expect(readReadyPids(paths)).toBeUndefined();
    writeFileSync(paths[0], '123\n');
    writeFileSync(paths[1], '456\n');
    writeFileSync(paths[2], '');
    expect(readReadyPids(paths)).toBeUndefined();
    writeFileSync(paths[2], '789');
    expect(readReadyPids(paths)).toBeUndefined();
    writeFileSync(paths[2], '789\n');
    expect(readReadyPids(paths)).toEqual([123, 456, 789]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('real tmux pane systemd-scope lifecycle', () => {
  const unavailableReason = !tmuxAvailable
    ? 'tmux is unavailable'
    : !capabilities.cleanupSupported
      ? capabilities.reason ?? 'session scope cleanup is unsupported'
      : undefined;

  if (unavailableReason) {
    it(`reports integration unavailable: ${unavailableReason}`, () => {
      console.warn(`[session-scope integration unavailable] ${unavailableReason}`);
      expect(unavailableReason).toBeTruthy();
    });
  } else {
    it('places the pane child/grandchild in the scope and kills both on scope stop', () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-session-scope-'));
      const sessionId = `integration-${process.pid}-${Date.now()}`;
      const tmuxSession = `bmx-scope-${process.pid}-${Date.now()}`;
      const unit = sessionScopeUnitName(sessionId);
      const rootScript = join(dir, 'root.sh');
      const childScript = join(dir, 'child.sh');
      const grandchildScript = join(dir, 'grandchild.sh');
      const scoped = wrapCommandInSessionScope(
        sessionId,
        'sh',
        [rootScript, dir],
        undefined,
        capabilities,
        userSystemdBusEnv(),
      );
      writeFileSync(rootScript, `#!/bin/sh\necho $$ > "$1/root.pid"\nsh "$1/child.sh" "$1" &\nwait\n`);
      writeFileSync(childScript, `#!/bin/sh\necho $$ > "$1/child.pid"\nsh "$1/grandchild.sh" "$1" &\nwait\n`);
      writeFileSync(grandchildScript, `#!/bin/sh\necho $$ > "$1/grandchild.pid"\nsleep 300\n`);
      try {
        // The pane command itself is systemd-run. This is the production
        // boundary: the shared tmux server is deliberately outside the scope.
        execFileSync('tmux', [
          'new-session', '-d', '-s', tmuxSession,
          scoped.bin, ...scoped.args,
        ]);
        const pidFiles = ['root.pid', 'child.pid', 'grandchild.pid'].map(name => join(dir, name));
        let pids: number[] = [];
        waitFor(() => {
          pids = readReadyPids(pidFiles) ?? [];
          return pids.length === pidFiles.length;
        });
        expect(pids.every(pid => pid > 1)).toBe(true);
        for (const pid of pids) {
          expect(readFileSync(`/proc/${pid}/cgroup`, 'utf8')).toContain(unit);
        }

        stopSessionScope(sessionId);
        waitFor(() => pids.every(pid => !existsSync(`/proc/${pid}`)));
        console.info('[session-scope integration executed] child and grandchild were scoped and stopped');
      } finally {
        try { execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' }); } catch { /* already gone */ }
        try { stopSessionScope(sessionId); } catch { /* user manager went away */ }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
