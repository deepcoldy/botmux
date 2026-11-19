import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hashes = new Map();
export class UnsupportedWorkerInput extends Error {}
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

function fingerprint(root, directory, inputs) {
  const paths = [];
  function visit(relative) {
    for (const item of readdirSync(join(root, directory, relative), { withFileTypes: true })) {
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new UnsupportedWorkerInput('worker fixture source/artifact symlinks require source execution');
      if (item.isDirectory()) visit(path);
      else if (item.isFile()) paths.push([path, join(root, directory, path)]);
    }
  }
  visit(''); paths.sort(([a], [b]) => a.localeCompare(b));
  for (const name of inputs) paths.push([`@root/${name}`, join(root, name)]);
  let settled = true;
  const nowNs = BigInt(Date.now()) * 1_000_000n;
  const signature = paths.map(([path, absolute]) => {
    const stat = statSync(absolute, { bigint: true });
    if (stat.mtimeNs === undefined || stat.ctimeNs === undefined) settled = false;
    else if (nowNs - stat.ctimeNs < 1_000_000_000n || nowNs - stat.mtimeNs < 1_000_000_000n) settled = false;
    return `${path}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  }).join('\n');
  const revision = createHash('sha256').update(signature).digest('hex');
  const key = `${root}\0${directory}`;
  const previous = hashes.get(key);
  if (settled && previous?.revision === revision) return previous;
  const hash = createHash('sha256');
  for (const [path, absolute] of paths) {
    const bytes = readFileSync(absolute);
    hash.update(`${Buffer.byteLength(path)}:${path}:${bytes.length}:`); hash.update(bytes);
  }
  const result = { id: hash.digest('hex'), revision };
  if (settled) hashes.set(key, result);
  else hashes.delete(key);
  return result;
}
export function workerSourceIdentity(root) {
  const inputs = ['package.json', 'bun.lock', ...readdirSync(root).filter(name => /^tsconfig.*\.json$/.test(name)).sort()];
  // Preserve the identity used by source execution when the normal build exists.
  if (existsSync(join(root, 'dist', '.runtime-build-id'))) inputs.push('dist/.runtime-build-id');
  return fingerprint(root, 'src', inputs);
}
export function workerArtifactIdentity(root) { return fingerprint(root, 'dist', ['package.json']); }

export function snapshotPermissions(root, readonly) {
  chmodSync(root, readonly ? 0o555 : 0o700);
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) snapshotPermissions(path, readonly);
    else if (entry.isFile() && readonly) chmodSync(path, (statSync(path).mode & 0o111) | 0o444);
  }
}
function copyAssets(source, output) {
  mkdirSync(output, { recursive: true });
  for (const item of readdirSync(source, { withFileTypes: true })) {
    const from = join(source, item.name), to = join(output, item.name);
    if (item.isDirectory()) copyAssets(from, to);
    else if (!/\.(?:[cm]?tsx?)$/.test(item.name)) cpSync(from, to);
  }
}

/** Each test process emits into its own source copy, never the checkout's dist. */
export function createWorkerSnapshot(root, node, afterSourceCopy) {
  const identity = workerSourceIdentity(root);
  const target = mkdtempSync(join(tmpdir(), 'botmux-worker-modules-'));
  try {
    cpSync(join(root, 'src'), join(target, 'src'), { recursive: true });
    for (const name of ['package.json', 'bun.lock', ...readdirSync(root).filter(name => /^tsconfig.*\.json$/.test(name))]) {
      cpSync(join(root, name), join(target, name));
    }
    if (existsSync(join(root, 'dist', '.runtime-build-id'))) {
      mkdirSync(join(target, 'dist')); cpSync(join(root, 'dist', '.runtime-build-id'), join(target, 'dist', '.runtime-build-id'));
    }
    if (workerSourceIdentity(target).id !== identity.id || JSON.stringify(workerSourceIdentity(root)) !== JSON.stringify(identity)) {
      throw new Error('worker source changed while snapshotting; rerun the test');
    }
    snapshotPermissions(join(target, 'src'), true);
    afterSourceCopy?.(target);
    const dependencies = existsSync(join(root, 'node_modules')) ? join(root, 'node_modules') : join(repoRoot, 'node_modules');
    symlinkSync(dependencies, join(target, 'node_modules'), 'junction');
    const emitted = spawnSync(node, [join(repoRoot, 'scripts', 'tsc.mjs'), '--noCheck', '--noEmit', 'false',
      '--declaration', 'false', '--declarationMap', 'false', '--incremental', 'false',
      '--rootDir', join(target, 'src'), '--outDir', join(target, 'dist'), '-p', join(target, 'tsconfig.json')],
      { cwd: target, env: process.env, encoding: 'utf8', timeout: 60_000, detached: process.platform !== 'win32' });
    // The compiler wrapper launches its own child. A timeout must stop that
    // private process group before its temporary output is removed.
    if (emitted.error && process.platform !== 'win32' && emitted.pid) {
      try { process.kill(-emitted.pid, 'SIGKILL'); } catch { /* already exited */ }
    }
    if (emitted.error || emitted.status !== 0) throw new Error(`worker fixture emit failed (status=${emitted.status}, signal=${emitted.signal}): ${emitted.error ?? emitted.stderr + emitted.stdout}`);
    if (JSON.stringify(workerSourceIdentity(root)) !== JSON.stringify(identity)) {
      throw new Error('worker source changed during fixture compilation; rerun the test');
    }
    copyAssets(join(target, 'src'), join(target, 'dist'));
    snapshotPermissions(target, true);
    return { root: target, source: identity, artifact: workerArtifactIdentity(target) };
  } catch (error) {
    snapshotPermissions(target, false);
    rmSync(target, { recursive: true, force: true });
    throw error;
  }
}
