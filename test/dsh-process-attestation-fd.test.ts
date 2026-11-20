import './helpers/require-fenced-data-dir.js';
import { closeSync, mkdtempSync, readlinkSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDshProcessAttestationFd } from '../src/services/dsh-process-attestation.js';

vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, closeSync: vi.fn(actual.closeSync), unlinkSync: vi.fn(actual.unlinkSync) };
});
const roots: string[] = [];
const originalClose = vi.mocked(closeSync).getMockImplementation()!;
const originalUnlink = vi.mocked(unlinkSync).getMockImplementation()!;
const originalTmpdir = process.env.TMPDIR;
afterEach(() => {
  vi.mocked(closeSync).mockImplementation(originalClose).mockClear();
  vi.mocked(unlinkSync).mockImplementation(originalUnlink).mockClear();
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('DSH attestation fd setup degradation', () => {
  it('returns no proof instead of throwing when the temporary directory is unusable', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-attestation-fd-')); roots.push(root);
    const blocker = join(root, 'not-a-directory');
    writeFileSync(blocker, 'x');
    process.env.TMPDIR = blocker;
    expect(createDshProcessAttestationFd()).toBeUndefined();
    expect(closeSync).not.toHaveBeenCalled();
  });

  it('closes an already opened proof when later setup fails', () => {
    const before = new Set(readdirSync('/proc/self/fd'));
    vi.mocked(unlinkSync).mockImplementationOnce(() => { throw new Error('forced unlink failure'); });
    expect(createDshProcessAttestationFd()).toBeUndefined();
    expect(closeSync).toHaveBeenCalledTimes(1);
    const closedFd = vi.mocked(closeSync).mock.calls[0]![0];
    expect(() => readlinkSync(`/proc/self/fd/${closedFd}`)).toThrow();
    expect(new Set(readdirSync('/proc/self/fd'))).toEqual(before);
  });
});
