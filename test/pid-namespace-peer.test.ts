import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  mapPidNamespacePeerToHost,
  resolvePidNamespaceRoot,
} from '../src/core/pid-namespace-peer.js';

const roots: string[] = [];

function stat(pid: number, start: string): string {
  return `${pid} (fixture) S 1 ${Array(17).fill('0').join(' ')} ${start}\n`;
}

function processFixture(
  procRoot: string,
  pid: number,
  start: string,
  nspids: number[],
  namespace: string,
): void {
  const directory = join(procRoot, String(pid));
  mkdirSync(join(directory, 'ns'), { recursive: true });
  writeFileSync(join(directory, 'stat'), stat(pid, start));
  writeFileSync(join(directory, 'status'), `Name:\tfixture\nNSpid:\t${nspids.join('\t')}\n`);
  symlinkSync(namespace, join(directory, 'ns', 'pid'));
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('PID namespace peer translation', () => {
  it('maps the namespace-local identity to the unique live host process in that namespace', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'botmux-pid-namespace-peer-'));
    roots.push(procRoot);
    processFixture(procRoot, 200, '1000', [200, 1], 'pid:[target]');
    processFixture(procRoot, 321, '2000', [321, 18], 'pid:[target]');
    processFixture(procRoot, 654, '2000', [654, 18], 'pid:[sibling]');

    expect(mapPidNamespacePeerToHost({
      procRoot,
      namespaceRoot: { pid: 200, procStart: '1000' },
      peer: { pid: 18, procStart: '2000' },
    })).toEqual({ pid: 321, procStart: '2000' });
  });

  it('fails closed for a stale namespace root or an ambiguous host mapping', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'botmux-pid-namespace-peer-'));
    roots.push(procRoot);
    processFixture(procRoot, 200, '1000', [200, 1], 'pid:[target]');
    processFixture(procRoot, 321, '2000', [321, 18], 'pid:[target]');
    processFixture(procRoot, 322, '2000', [322, 18], 'pid:[target]');

    expect(mapPidNamespacePeerToHost({
      procRoot,
      namespaceRoot: { pid: 200, procStart: 'stale' },
      peer: { pid: 18, procStart: '2000' },
    })).toBeNull();
    expect(mapPidNamespacePeerToHost({
      procRoot,
      namespaceRoot: { pid: 200, procStart: '1000' },
      peer: { pid: 18, procStart: '2000' },
    })).toBeNull();
  });

  it('finds only the PID-namespace root forked by the unshare parent', () => {
    const procRoot = mkdtempSync(join(tmpdir(), 'botmux-pid-namespace-root-'));
    roots.push(procRoot);
    const parent = 100;
    mkdirSync(join(procRoot, String(parent), 'task', String(parent)), { recursive: true });
    writeFileSync(join(procRoot, String(parent), 'task', String(parent), 'children'), '200\n');
    processFixture(procRoot, 200, '1000', [200, 1], 'pid:[target]');

    expect(resolvePidNamespaceRoot(parent, procRoot)).toEqual({ pid: 200, procStart: '1000' });
    writeFileSync(join(procRoot, String(parent), 'task', String(parent), 'children'), '200 201\n');
    expect(resolvePidNamespaceRoot(parent, procRoot)).toBeNull();
  });
});
