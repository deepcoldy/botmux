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

it.skipIf(!resolveBunExecutable())('survives exhausted recovery over a silent CONNECT proxy and cancels retired sockets', () => {
  const result = spawnSyncBunTsEvalWithRepoImports("await import('./test/fixtures/lark-ws-watchdog-exit.ts')", {
    encoding: 'utf8', timeout: 12_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stderr)).toBe(0);
  const outcome = JSON.parse(String(result.stdout).trim().split('\n').at(-1)!);
  expect(outcome).toMatchObject({ alive: true, maxSockets: 1, remainingSockets: 0 });
  expect(outcome.connects).toBeGreaterThanOrEqual(3);
}, 15_000);

it.skipIf(!resolveBunExecutable())('the parked Bun daemon exits on an uncaught native WS error', () => {
  const result = spawnSyncBunTsEvalWithRepoImports("await import('./test/fixtures/lark-ws-fatal-probe.ts')", {
    encoding: 'utf8', timeout: 6_000,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stderr)).toBe(1);
  expect(String(result.stderr)).toContain('[FATAL]');
}, 8_000);
