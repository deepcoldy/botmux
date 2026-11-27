import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { spawnTsScript } from './helpers/ts-runner.js';

const fixture = fileURLToPath(new URL('./fixtures/bridge-marker-once-race.ts', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function waitFor(condition: () => boolean, description: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, 10); timer.unref?.(); });
  }
}

describe('bridge reply marker replay idempotency', () => {
  it('serializes concurrent lock-free replay check-and-append under the journal lock', async () => {
    const root = mkdtempSync(join(tmpdir(), 'bridge-marker-once-race-'));
    roots.push(root);
    const dataDir = join(root, 'data');
    const barrier = join(root, 'barrier');
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(barrier, { recursive: true });
    const children = Array.from({ length: 6 }, () => {
      const child = spawnTsScript(fixture, [], {
        env: {
          ...process.env,
          BOTMUX_TEST_MARKER_DATA_DIR: dataDir,
          BOTMUX_TEST_MARKER_BARRIER: barrier,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      const exited = new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', code => code === 0 ? resolve() : reject(new Error(`marker race child exited ${code}: ${stderr}`)));
      });
      return { child, exited };
    });
    try {
      await waitFor(() => children.every(({ child }) => existsSync(join(barrier, `${child.pid}.ready`))), 'all replay children to be ready');
      writeFileSync(join(barrier, 'release'), 'release');
      await Promise.all(children.map(({ exited }) => exited));
    } finally {
      if (!existsSync(join(barrier, 'release'))) writeFileSync(join(barrier, 'release'), 'release');
      for (const { child } of children) if (child.exitCode === null) child.kill('SIGTERM');
    }
    const markers = readFileSync(join(dataDir, 'turn-sends', 'sid.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({
      turnId: 'om_A', messageId: 'om_final', responseKind: 'final', sentAtMs: 1000,
    });
  }, 30_000);
});
