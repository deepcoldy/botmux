import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalPath = process.env.PATH;
const roots: string[] = [];

afterEach(() => {
  process.env.PATH = originalPath;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

function fixture(): { empty: string; withHerdr: string } {
  const root = mkdtempSync(join(tmpdir(), 'herdr-exe-'));
  roots.push(root);
  const empty = join(root, 'empty');
  const withHerdr = join(root, 'bin');
  mkdirSync(empty);
  mkdirSync(join(empty, 'herdr')); // a directory named herdr must not match
  mkdirSync(withHerdr);
  writeFileSync(join(withHerdr, 'herdr'), '#!/bin/sh\n');
  chmodSync(join(withHerdr, 'herdr'), 0o755);
  return { empty, withHerdr };
}

describe('herdrExecutable', () => {
  it('resolves herdr to the first executable file on PATH, so spawns skip the per-entry posix_spawn attempts', async () => {
    const { empty, withHerdr } = fixture();
    process.env.PATH = [empty, withHerdr].join(delimiter);
    const { herdrExecutable } = await import('../src/utils/herdr-executable.js');
    expect(herdrExecutable()).toBe(join(withHerdr, 'herdr'));
  });

  it('resolves once per process', async () => {
    const { empty, withHerdr } = fixture();
    process.env.PATH = [empty, withHerdr].join(delimiter);
    const { herdrExecutable } = await import('../src/utils/herdr-executable.js');
    const first = herdrExecutable();
    process.env.PATH = empty;
    expect(herdrExecutable()).toBe(first);
  });

  it('falls back to the bare name when herdr is not on PATH', async () => {
    const { empty } = fixture();
    process.env.PATH = empty;
    const { herdrExecutable } = await import('../src/utils/herdr-executable.js');
    expect(herdrExecutable()).toBe('herdr');
  });
});
