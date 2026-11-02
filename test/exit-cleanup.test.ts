import { afterEach, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnTsEvalWithRepoImports } from './helpers/ts-runner.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** A child that registers cleanups writing marker files, says READY, then idles. */
function child(dir: string, extra = ''): ReturnType<typeof spawnTsEvalWithRepoImports> {
  return spawnTsEvalWithRepoImports(`
import { appendFileSync } from 'node:fs';
import { onTestProcessExit } from './test/helpers/exit-cleanup.js';
const log = (s) => appendFileSync(${JSON.stringify(join(dir, 'log'))}, s + '\\n');
onTestProcessExit(() => log('first'));
const forget = onTestProcessExit(() => log('forgotten'));
onTestProcessExit(() => { throw new Error('one failing cleanup'); });
onTestProcessExit(() => log('last'));
forget();
${extra}
console.log('READY');
setInterval(() => {}, 1000);
`, { stdio: ['ignore', 'pipe', 'pipe'] });
}

async function ready(proc: ReturnType<typeof child>): Promise<void> {
  let out = '';
  await new Promise<void>((resolve, reject) => {
    proc.stdout!.on('data', (c) => { out += String(c); if (out.includes('READY')) resolve(); });
    proc.once('exit', () => reject(new Error(`exited early: ${out}`)));
  });
}

describe('onTestProcessExit', () => {
  it('runs every registered cleanup once, newest first, on SIGTERM — and the process still dies of SIGTERM', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exit-cleanup-'));
    dirs.push(dir);
    const proc = child(dir);
    await ready(proc);
    proc.kill('SIGTERM');
    const [code, signal] = await once(proc, 'exit');
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGTERM' });
    // The unregistered one never runs; one throwing does not stop the rest.
    expect(readFileSync(join(dir, 'log'), 'utf8')).toBe('last\nfirst\n');
  }, 30_000);

  it('runs on a plain exit too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exit-cleanup-'));
    dirs.push(dir);
    const proc = child(dir, 'setTimeout(() => process.exit(3), 50);');
    const [code] = await once(proc, 'exit');
    expect(code).toBe(3);
    expect(readFileSync(join(dir, 'log'), 'utf8')).toBe('last\nfirst\n');
  }, 30_000);

  it('leaves the outcome to another SIGTERM handler instead of re-raising over it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'exit-cleanup-'));
    dirs.push(dir);
    const proc = child(dir, `process.on('SIGTERM', () => { log('owner'); setTimeout(() => process.exit(0), 50); });`);
    await ready(proc);
    proc.kill('SIGTERM');
    const [code, signal] = await once(proc, 'exit');
    expect({ code, signal }).toEqual({ code: 0, signal: null });
    expect(existsSync(join(dir, 'log'))).toBe(true);
    expect(readFileSync(join(dir, 'log'), 'utf8').split('\n').filter(Boolean).sort()).toEqual(['first', 'last', 'owner']);
  }, 30_000);
});
