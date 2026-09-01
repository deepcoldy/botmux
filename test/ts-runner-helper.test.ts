import { describe, it, expect } from 'bun:test';
import { resolve } from 'node:path';
import {
  isBunRuntime,
  tsRunnerPrefix,
  tsEvalArgs,
  spawnSyncTsScript,
  spawnSyncTsEval,
  spawnSyncTsEvalWithRepoImports,
} from './helpers/ts-runner.js';

/**
 * Contract test for the runtime-aware test spawner. This has to hold under BOTH
 * runtimes, because CI now runs the suite under Node today and the dev/bun path
 * uses the same helper: the assertions below are written so the SAME test file
 * passes whether the parent is node or bun.
 */

const FIXTURE = resolve('test/fixtures/ts-runner-echo.ts');

describe('tsRunnerPrefix / tsEvalArgs — shape per runtime', () => {
  it('uses the current executable and only adds a loader flag on Node', () => {
    const { command, prefixArgs } = tsRunnerPrefix();
    expect(command).toBe(process.execPath);
    // Bun runs TypeScript natively; Node needs tsx. Asserting both branches
    // keeps this meaningful on whichever runtime happens to execute it.
    if (isBunRuntime()) expect(prefixArgs).toEqual([]);
    else expect(prefixArgs).toEqual(['--import', 'tsx']);
  });

  it('inline eval only needs --input-type=module on Node', () => {
    const { command, args } = tsEvalArgs('console.log(1)');
    expect(command).toBe(process.execPath);
    if (isBunRuntime()) expect(args).toEqual(['-e', 'console.log(1)']);
    else expect(args).toEqual(['--input-type=module', '-e', 'console.log(1)']);
  });
});

describe('spawning actually works on this runtime', () => {
  it('runs a TypeScript file and passes argv through', () => {
    const r = spawnSyncTsScript(FIXTURE, ['alpha', 'beta'], { encoding: 'utf-8' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    // Proves the child actually transpiled+ran and saw its args at the same
    // positions on both runtimes — the whole point of the helper.
    const out = JSON.parse(String(r.stdout).trim());
    expect(out).toMatchObject({ ok: true, args: ['alpha', 'beta'] });
  });

  it('evaluates an inline ES module (import syntax proves ESM mode)', () => {
    const src = "import { join } from 'node:path'; console.log(JSON.stringify({ joined: join('a','b') }));";
    const r = spawnSyncTsEval(src, { encoding: 'utf-8' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(JSON.parse(String(r.stdout).trim())).toEqual({ joined: 'a/b' });
  });

  it('propagates a non-zero child exit status', () => {
    const r = spawnSyncTsEval('process.exit(3)', { encoding: 'utf-8' });
    expect(r.status).toBe(3);
  });

  it('evaluates a snippet that IMPORTS a repo module via a .js specifier', () => {
    // The trap this guards: plain `node --input-type=module -e` cannot resolve
    // './src/**/x.js' when the file on disk is x.ts — it dies with
    // ERR_MODULE_NOT_FOUND. Only the loader-prefixed variant works on Node
    // (Bun resolves TypeScript natively either way), so a caller that reached
    // for the plain spawnTsEval here would break the Node path silently.
    const src = "import { resolveBotmuxDataDir } from './src/core/data-dir.js';"
      + " console.log(JSON.stringify({ kind: typeof resolveBotmuxDataDir }));";
    const r = spawnSyncTsEvalWithRepoImports(src, { cwd: resolve('.'), encoding: 'utf-8' });
    expect(r.error).toBeUndefined();
    expect(r.status).toBe(0);
    expect(JSON.parse(String(r.stdout).trim())).toEqual({ kind: 'function' });
  });
});
