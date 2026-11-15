import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RemoteRunnerBackend } from '../../src/adapters/backend/remote-runner-backend.js';

/** Only owns disposable provider processes and directories. Each test keeps
 * its protocol event sequence and assertions visible beside the scenario. */
export class RemoteRunnerTestHarness {
  private readonly roots: string[] = [];
  private readonly backends: RemoteRunnerBackend[] = [];

  root(prefix = 'botmux-remote-runner-'): string {
    const root = mkdtempSync(join(tmpdir(), prefix));
    this.roots.push(root);
    return root;
  }

  spawn(backend: RemoteRunnerBackend, provider: string): Promise<void> {
    this.backends.push(backend);
    const ready = new Promise<void>(resolve => backend.onReady(resolve));
    backend.spawn(process.execPath, [provider], { cwd: process.cwd(), cols: 80, rows: 24,
      env: { ...process.env } as Record<string, string> });
    return ready;
  }

  dispose(): void {
    for (const backend of this.backends.splice(0)) backend.kill();
    for (const root of this.roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
}
