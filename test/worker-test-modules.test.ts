import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workerTestModules, useWorkerTestModulesCleanup } from './helpers/worker-test-modules.js';
useWorkerTestModulesCleanup();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0))
  rmSync(root, { recursive: true, force: true }); });
const source = (value: string) => `const value: string = ${JSON.stringify(value)}; console.log(JSON.stringify({value,bun:!!process.versions.bun,node:!!process.versions.node}));`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'worker-module-source-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'dist'));
  writeFileSync(join(root, 'package.json'), '{"type":"module","version":"1.0.0"}');
  writeFileSync(join(root, 'bun.lock'), 'fixture lock v1');
  writeFileSync(join(root, 'tsconfig.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', skipLibCheck: true }, include: ['src/**/*'] }));
  writeFileSync(join(root, 'src', 'worker.ts'), source('original'));
  writeFileSync(join(root, 'dist', 'worker.js'), 'console.log("stale checkout dist");');
  return root;
}
async function execute(modules: ReturnType<typeof workerTestModules>) {
  const child = modules.spawn(modules.path('worker.ts'), [], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout?.on('data', bytes => { output += bytes; });
  child.stderr?.on('data', bytes => { errors += bytes; });
  await new Promise<void>((ok, bad) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); bad(new Error('fixture did not exit')); }, 10000);
    child.once('error', error => { clearTimeout(timer); bad(error); });
    child.once('close', code => { clearTimeout(timer); code === 0 ? ok() : bad(new Error(`exit ${code}: ${errors}`)); });
  });
  return { compiled: modules.compiled, ...JSON.parse(output.trim()) };
}
const expected = (compiled: boolean, value = 'original') => ({ compiled, value, bun: false, node: true });
describe('isolated compiled worker source snapshots', () => {
  it('does not repeat a failed compilation for unchanged inputs in one test file', () => {
    const root = fixture();
    let attempts = 0;
    const options = { root, afterSourceCopy: () => { attempts++; throw new Error('compiler unavailable'); } };
    expect(() => workerTestModules(options)).toThrow('compiler unavailable');
    expect(() => workerTestModules(options)).toThrow('compiler unavailable');
    expect(attempts).toBe(1);
    writeFileSync(join(root, 'src', 'worker.ts'), source('modified'));
    expect(() => workerTestModules(options)).toThrow('compiler unavailable');
    expect(attempts).toBe(2);
  });
  it('emits current source and runs Node even with absent or stale checkout dist', async () => {
    const root = fixture();
    rmSync(join(root, 'dist'), { recursive: true });
    expect(await execute(workerTestModules({ root }))).toEqual(expected(true));
  });
  it('uses current source rather than the checkout build', async () => {
    const root = fixture();
    expect(await execute(workerTestModules({ root }))).toEqual(expected(true));
  });
  it('invalidates same-size source edits with restored mtime', async () => {
    const root = fixture(), path = join(root, 'src', 'worker.ts'), fixed = new Date(1000);
    utimesSync(path, fixed, fixed);
    const before = statSync(path, { bigint: true });
    const selected = workerTestModules({ root });
    writeFileSync(path, source('modified'));
    utimesSync(path, fixed, fixed);
    expect(statSync(path, { bigint: true }).size).toBe(before.size);
    expect(statSync(path, { bigint: true }).mtimeNs).toBe(before.mtimeNs);
    await expect(execute(selected)).rejects.toThrow(/inputs changed after selection/);
    expect(await execute(workerTestModules({ root }))).toEqual(expected(true, 'modified'));
  });
  it('invalidates dependency inputs even when their byte length is unchanged', async () => {
    const root = fixture(), selected = workerTestModules({ root });
    writeFileSync(join(root, 'bun.lock'), 'fixture lock v2');
    await expect(execute(selected)).rejects.toThrow(/inputs changed after selection/);
    expect(await execute(workerTestModules({ root }))).toEqual(expected(true));
  });
  it('cannot bind original inputs to another compilation generation', () => {
    const root = fixture();
    let second: ReturnType<typeof workerTestModules> | undefined;
    expect(() => workerTestModules({ root, afterSourceCopy: () => {
        writeFileSync(join(root, 'src', 'worker.ts'), source('modified'));
        second = workerTestModules({ root });
      } })).toThrow(/source changed during fixture compilation/);
    expect(second?.compiled).toBe(true);
  });
  it('invalidates additions and deletions of executable source files', async () => {
    const root = fixture(), first = workerTestModules({ root });
    writeFileSync(join(root, 'src', 'added.mts'), 'export const added=true;');
    await expect(execute(first)).rejects.toThrow(/inputs changed after selection/);
    const second = workerTestModules({ root });
    rmSync(join(root, 'src', 'added.mts'));
    await expect(execute(second)).rejects.toThrow(/inputs changed after selection/);
  });
  it('uses source execution for linked source inputs', async () => {
    const root = fixture(), path = join(root, 'src', 'worker.ts'), target = join(root, 'linked-worker.ts');
    writeFileSync(target, readFileSync(path));
    rmSync(path);
    symlinkSync(target, path);
    expect(await execute(workerTestModules({ root }))).toEqual(expected(false));
  });
  it('refuses mutations of its own read-only compiled snapshot', async () => {
    const root = fixture(), selected = workerTestModules({ root }), path = selected.path('worker.ts');
    chmodSync(path, 0o644);
    writeFileSync(path, 'console.log("modified snapshot");');
    await expect(execute(selected)).rejects.toThrow(/inputs changed after selection/);
  });
  it('keeps hooks and worker on one snapshot across a checkout dist replacement', async () => {
    const root = fixture();
    writeFileSync(join(root, 'src', 'hook.ts'), 'export const value="A";');
    writeFileSync(join(root, 'src', 'value.ts'), 'export const value="A";');
    writeFileSync(join(root, 'src', 'worker.ts'), `import {value as hook} from './hook.js'; process.send?.({hook}); process.once('message',async()=>{const {value:worker}=await import('./value.js'); process.send?.({hook,worker},()=>process.exit(0));});`);
    const selected = workerTestModules({ root });
    const child = selected.spawn(selected.path('worker.ts'), [], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    try {
      const first = await new Promise<any>(ok => child.once('message', ok));
      expect(first).toEqual({ hook: 'A' });
      writeFileSync(join(root, 'dist', 'value.js'), 'export const value="B";');
      const next = new Promise<any>(ok => child.once('message', ok));
      child.send({ continue: true });
      expect(await next).toEqual({ hook: 'A', worker: 'A' });
    }
    finally {
      if (child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await new Promise<void>(ok => child.exitCode !== null || child.signalCode !== null ? ok() : child.once('exit', () => ok()));
    }
  });
  it('can force source execution for reproduction', async () => {
    const root = fixture();
    expect(await execute(workerTestModules({ root, forceSource: true }))).toEqual(expected(false));
  });
});
