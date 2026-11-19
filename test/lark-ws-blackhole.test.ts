import { expect, it } from 'vitest';
import { resolveBunExecutable, spawnSyncBunTsEvalWithRepoImports } from './helpers/ts-runner.js';

it.skipIf(!resolveBunExecutable())('Bun survives a timed-out upgrade, escapes stalled proxy discovery and receives frames again', () => {
  const result = spawnSyncBunTsEvalWithRepoImports("await import('./test/fixtures/lark-ws-blackhole.ts')", {
    encoding: 'utf8', timeout: 12_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stderr)).toBe(0);
  expect(String(result.stdout)).toContain('"reconnected":true');
}, 15_000);

it.skipIf(!resolveBunExecutable())('exits nonzero after rebuilding over a persistently silent CONNECT proxy', () => {
  const result = spawnSyncBunTsEvalWithRepoImports("await import('./test/fixtures/lark-ws-watchdog-exit.ts')", {
    encoding: 'utf8', timeout: 12_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stderr)).toBe(1);
  expect(result.stdout).toContain('proxy-connect=2');
  expect(result.stderr).toContain('rebuilding WSClient 1/1');
  expect(result.stderr).toContain('exiting for supervisor recovery');
}, 15_000);

it.skipIf(!resolveBunExecutable())('the parked Bun daemon exits on an uncaught native WS error', () => {
  const result = spawnSyncBunTsEvalWithRepoImports("await import('./test/fixtures/lark-ws-fatal-probe.ts')", {
    encoding: 'utf8', timeout: 6_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stderr)).toBe(1);
  expect(String(result.stderr)).toContain('[FATAL]');
}, 8_000);
