import './helpers/require-fenced-data-dir.js';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real files plus a coarse filesystem clock. The stat signature stays the same
// for same-size edits inside one second, so these tests exercise byte hashing.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, statSync: (path: Parameters<typeof actual.statSync>[0], options?: { bigint?: boolean }) => {
    const stat = actual.statSync(path, options as { bigint: true });
    if (!options?.bigint) return stat;
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, {
      mtimeNs: 1_000_000_000n, ctimeNs: 1_000_000_000n,
    });
  } };
});
// @ts-expect-error JavaScript snapshot helper has no TypeScript declaration.
import { workerSourceIdentity, workerArtifactIdentity } from './helpers/worker-module-snapshot.mjs';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'worker-snapshot-clock-')); roots.push(root);
  mkdirSync(join(root, 'src')); mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'bun.lock'), 'lock v1');
  writeFileSync(join(root, 'tsconfig.json'), '{}');
  writeFileSync(join(root, 'src', 'worker.ts'), 'console.log("original");');
  writeFileSync(join(root, 'dist', 'worker.js'), 'console.log("original");');
  return root;
}

it('does not reuse a hash captured before its coarse timestamp quantum settled', () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(1_100));
  const root = fixture(), before = workerSourceIdentity(root);
  vi.setSystemTime(new Date(1_200));
  writeFileSync(join(root, 'src', 'worker.ts'), 'console.log("modified");');
  // No call during the edit window. This was the old-cache failure sequence.
  vi.setSystemTime(new Date(2_100));
  const after = workerSourceIdentity(root);
  expect(after.revision).toBe(before.revision);
  expect(after.id).not.toBe(before.id);
});

it.each([
  ['source', 'src/worker.ts', 'console.log("modified");'],
  ['dependency', 'bun.lock', 'lock v2'],
  ['artifact', 'dist/worker.js', 'console.log("modified");'],
] as const)('hashes %s bytes when coarse metadata cannot distinguish an edit', (kind, relative, next) => {
  vi.useFakeTimers(); vi.setSystemTime(new Date(1_100));
  const root = fixture(), identity = kind === 'artifact' ? workerArtifactIdentity : workerSourceIdentity;
  const path = join(root, relative), before = identity(root);
  expect(Buffer.byteLength(next)).toBe(readFileSync(path).byteLength);
  vi.setSystemTime(new Date(1_200)); writeFileSync(path, next);
  const after = identity(root);
  expect(after.revision).toBe(before.revision);
  expect(after.id).not.toBe(before.id);
});
