import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { recordDispatchRegistryEntry } from '../src/core/dispatch-registry.js';

const registryModuleUrl = pathToFileURL(fileURLToPath(new URL('../src/core/dispatch-registry.ts', import.meta.url))).href;

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr?.setEncoding('utf-8');
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`registry writer exited code=${code} signal=${signal}: ${stderr}`));
    });
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for registry writer');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function spawnWriter(registryPath: string, seed: string, holdMs: number): ChildProcess {
  const script = `
    import { updateDispatchRegistry } from ${JSON.stringify(registryModuleUrl)};
    await updateDispatchRegistry(${JSON.stringify(registryPath)}, async registry => {
      registry[${JSON.stringify(seed)}] = { orchSessionId: ${JSON.stringify(`session-${seed}`)} };
      await new Promise(resolve => setTimeout(resolve, ${holdMs}));
    });
  `;
  return spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', script], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    stdio: ['ignore', 'ignore', 'pipe'],
  });
}

describe('dispatch registry persistence', () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it('preserves existing report routing entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    writeFileSync(registryPath, JSON.stringify({ seed_old: { orchSessionId: 'session-old' } }));

    await recordDispatchRegistryEntry(registryPath, 'seed_new', { orchSessionId: 'session-new' });

    expect(JSON.parse(readFileSync(registryPath, 'utf-8'))).toEqual({
      seed_old: { orchSessionId: 'session-old' },
      seed_new: { orchSessionId: 'session-new' },
    });
  });

  it('keeps both seeds when two CLI processes overlap their writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');

    // Writer A holds the critical section after reading. Writer B starts while
    // A owns the lock, so an unlocked read-modify-write would deterministically
    // lose one seed when A eventually renames its stale snapshot over B's file.
    const writerA = spawnWriter(registryPath, 'seed_a', 250);
    await waitUntil(() => existsSync(`${registryPath}.lock`));
    const writerB = spawnWriter(registryPath, 'seed_b', 0);

    await Promise.all([waitForExit(writerA), waitForExit(writerB)]);

    expect(JSON.parse(readFileSync(registryPath, 'utf-8'))).toEqual({
      seed_a: { orchSessionId: 'session-seed_a' },
      seed_b: { orchSessionId: 'session-seed_b' },
    });
    expect(existsSync(`${registryPath}.lock`)).toBe(false);
  }, 10_000);

  it('fails closed instead of replacing a malformed registry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'botmux-dispatch-registry-'));
    roots.push(root);
    const registryPath = join(root, 'orchestrate-dispatch.json');
    writeFileSync(registryPath, '[]');

    await expect(recordDispatchRegistryEntry(registryPath, 'seed_new', {}))
      .rejects.toThrow('orchestrate-dispatch.json must contain an object');
    expect(readFileSync(registryPath, 'utf-8')).toBe('[]');
    expect(existsSync(`${registryPath}.lock`)).toBe(false);
  });
});
