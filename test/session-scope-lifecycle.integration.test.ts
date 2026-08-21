import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  probeSessionScopeCapabilities,
  sessionScopeUnitName,
  stopSessionScope,
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

describe.skipIf(!capabilities.cleanupSupported || !tmuxAvailable)(
  'real tmux pane systemd-scope lifecycle',
  () => {
    it('places the pane child/grandchild in the scope and kills both on scope stop', () => {
      const dir = mkdtempSync(join(tmpdir(), 'botmux-session-scope-'));
      const sessionId = `integration-${process.pid}-${Date.now()}`;
      const tmuxSession = `bmx-scope-${process.pid}-${Date.now()}`;
      const unit = sessionScopeUnitName(sessionId);
      const rootScript = join(dir, 'root.sh');
      const childScript = join(dir, 'child.sh');
      const grandchildScript = join(dir, 'grandchild.sh');
      writeFileSync(rootScript, `#!/bin/sh\necho $$ > "$1/root.pid"\nsh "$1/child.sh" "$1" &\nwait\n`);
      writeFileSync(childScript, `#!/bin/sh\necho $$ > "$1/child.pid"\nsh "$1/grandchild.sh" "$1" &\nwait\n`);
      writeFileSync(grandchildScript, `#!/bin/sh\necho $$ > "$1/grandchild.pid"\nsleep 300\n`);
      try {
        // The pane command itself is systemd-run. This is the production
        // boundary: the shared tmux server is deliberately outside the scope.
        execFileSync('tmux', [
          'new-session', '-d', '-s', tmuxSession,
          'systemd-run', '--user', '--scope', '--quiet', '--collect',
          `--unit=${unit}`, '--property=KillMode=control-group', '--',
          'sh', rootScript, dir,
        ]);
        const pidFiles = ['root.pid', 'child.pid', 'grandchild.pid'].map(name => join(dir, name));
        waitFor(() => pidFiles.every(existsSync));
        const pids = pidFiles.map(path => Number(readFileSync(path, 'utf8').trim()));
        expect(pids.every(pid => pid > 1)).toBe(true);
        for (const pid of pids) {
          expect(readFileSync(`/proc/${pid}/cgroup`, 'utf8')).toContain(unit);
        }

        stopSessionScope(sessionId);
        waitFor(() => pids.every(pid => !existsSync(`/proc/${pid}`)));
      } finally {
        try { execFileSync('tmux', ['kill-session', '-t', tmuxSession], { stdio: 'ignore' }); } catch { /* already gone */ }
        try { stopSessionScope(sessionId); } catch { /* user manager went away */ }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  },
);
