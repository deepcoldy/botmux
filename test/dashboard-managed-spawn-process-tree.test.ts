import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { killBotLifecycleProcessTree } from '../src/dashboard/managed-spawn.js';

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe('bot lifecycle subprocess timeout cleanup', () => {
  it.skipIf(process.platform === 'win32')('kills the dependency-installer process group, not only the direct CLI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-lifecycle-process-tree-'));
    const marker = join(dir, 'installer.pid');
    const childSource = `
      const { spawn } = require('node:child_process');
      const { writeFileSync } = require('node:fs');
      const installer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30_000)'], { stdio: 'ignore' });
      writeFileSync(process.env.PROBE_MARKER, String(installer.pid));
      setTimeout(() => {}, 30_000);
    `;
    const child = spawn(process.execPath, ['-e', childSource], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PROBE_MARKER: marker },
    });
    try {
      const deadline = Date.now() + 5_000;
      while (!existsSync(marker) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(existsSync(marker)).toBe(true);
      const installerPid = Number(readFileSync(marker, 'utf8'));
      expect(installerPid).toBeGreaterThan(1);
      expect(alive(installerPid)).toBe(true);

      const exited = new Promise<void>(resolve => { child.once('exit', () => resolve()); });
      killBotLifecycleProcessTree(child);
      await exited;
      const goneDeadline = Date.now() + 3_000;
      while (alive(installerPid) && Date.now() < goneDeadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(alive(installerPid)).toBe(false);
    } finally {
      killBotLifecycleProcessTree(child);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
