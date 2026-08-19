/**
 * NON-LINUX EMULATION PROBE setup (evidence tooling, not part of `pnpm test`).
 *
 * Forces two conditions that a Mac has and this Linux devbox does not:
 *   1. process.platform === 'darwin'
 *   2. the real /proc does not exist -- every read of it fails ENOENT
 *
 * (2) is the hard part. An earlier version of this file reassigned
 * fs.readFileSync on the imported namespace object. That does NOT work: a module
 * doing `import { readFileSync } from 'node:fs'` binds the function directly, so
 * a namespace reassignment is invisible to it and the test happily reads the
 * host's REAL /proc. The probe then looked green for the wrong reason. It is
 * mocked through vi.mock here instead, which replaces the module record itself
 * and therefore also intercepts named imports.
 *
 * Anything that still needs the host's /proc fails loudly under this project.
 *
 * This is an EMULATION. Results must be reported as "procRoot injection plus
 * platform and fs mocking, no Darwin hardware" -- it says nothing about real
 * macOS fs semantics, process/signal behaviour, or terminal behaviour.
 */
import { vi } from 'vitest';

Object.defineProperty(process, 'platform', { value: 'darwin' });

function isRealProc(p: unknown): boolean {
  return typeof p === 'string' && (p === '/proc' || p.startsWith('/proc/'));
}

function enoent(p: unknown): Error {
  const e = new Error(`ENOENT: no such file or directory, open '${String(p)}'`);
  (e as NodeJS.ErrnoException).code = 'ENOENT';
  return e;
}

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  const wrapped = {
    ...real,
    readFileSync: (p: never, ...rest: never[]) => {
      if (isRealProc(p)) throw enoent(p);
      return (real.readFileSync as (...a: never[]) => unknown)(p, ...rest);
    },
    readdirSync: (p: never, ...rest: never[]) => {
      if (isRealProc(p)) throw enoent(p);
      return (real.readdirSync as (...a: never[]) => unknown)(p, ...rest);
    },
    existsSync: (p: never) => (isRealProc(p) ? false : real.existsSync(p)),
    statSync: (p: never, ...rest: never[]) => {
      if (isRealProc(p)) throw enoent(p);
      return (real.statSync as (...a: never[]) => unknown)(p, ...rest);
    },
  };
  return { ...wrapped, default: wrapped };
});
