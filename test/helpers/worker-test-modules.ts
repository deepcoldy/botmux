import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll } from 'vitest';
// @ts-expect-error Build metadata helper is shared with the JavaScript build entry.
import { createWorkerSnapshot, workerSourceIdentity, workerArtifactIdentity, snapshotPermissions, UnsupportedWorkerInput } from './worker-module-snapshot.mjs';
import { resolveNodeExecutable, spawnNodeTsScript } from './ts-runner.js';

const snapshots = new Map<string, { root: string; source: { id: string; revision: string }; artifact: { id: string; revision: string } }>();
const failedSnapshots = new Map<string, unknown>();
function removeSnapshot(root: string): void {
  if (!existsSync(root)) return;
  snapshotPermissions(root, false);
  rmSync(root, { recursive: true, force: true });
}
export function disposeWorkerTestModules(): void {
  for (const snapshot of snapshots.values()) removeSnapshot(snapshot.root);
  snapshots.clear();
  failedSnapshots.clear();
}
/** Owners register cleanup once per test file, after their worker teardown. */
export function useWorkerTestModulesCleanup(): void {
  afterAll(() => {
    try { disposeWorkerTestModules(); }
    finally { process.removeListener('exit', disposeWorkerTestModules); }
  });
}
process.once('exit', disposeWorkerTestModules);

/** Resolve once per fixture: bootstrap and hooks share one frozen module tree. */
export function workerTestModules(options: { root?: string; forceSource?: boolean; afterSourceCopy?: (root: string) => void } = {}) {
  const root = options.root ?? process.cwd();
  const command = resolveNodeExecutable();
  if (!command) throw new Error('node not found on PATH; worker fixtures require Node');
  let source: { id: string; revision: string } | undefined;
  if (!options.forceSource && process.env.BOTMUX_TEST_WORKER_SOURCE !== '1') {
    try { source = workerSourceIdentity(root); }
    catch (error) { if (!(error instanceof UnsupportedWorkerInput)) throw error; }
  }
  const compiled = !!source;
  const key = source ? JSON.stringify([root, source]) : '';
  let snapshot = source ? snapshots.get(key) : undefined;
  if (source && !snapshot) {
    if (failedSnapshots.has(key)) throw failedSnapshots.get(key);
    try { snapshot = createWorkerSnapshot(root, command, options.afterSourceCopy); }
    catch (error) { failedSnapshots.set(key, error); throw error; }
    snapshots.set(key, snapshot!);
  }
  return {
    compiled,
    scriptExtension: compiled ? 'mjs' : 'mts',
    path(relative: string): string {
      const module = compiled ? relative.replace(/\.([cm]?)tsx?$/, (_match, prefix: string) => `.${prefix}js`) : relative;
      return join(snapshot?.root ?? root, compiled ? 'dist' : 'src', module);
    },
    spawn(script: string, args: readonly string[] = [], spawnOptions: SpawnOptions = {}): ChildProcess {
      if (!compiled) return spawnNodeTsScript(script, args, spawnOptions);
      if (JSON.stringify(workerSourceIdentity(root)) !== JSON.stringify(snapshot!.source)
        || JSON.stringify(workerArtifactIdentity(snapshot!.root)) !== JSON.stringify(snapshot!.artifact)) {
        throw new Error('worker fixture inputs changed after selection; rerun the test');
      }
      return spawn(command, [script, ...args], spawnOptions);
    },
  };
}
