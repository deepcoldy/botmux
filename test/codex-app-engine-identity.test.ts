import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { verifyCodexAppEngineIdentity } from '../src/services/codex-app-engine-identity.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function processTree() {
  const root = mkdtempSync(join(tmpdir(), 'codex-engine-proc-'));
  roots.push(root);
  const add = (pid: number, start: string, nspid = [pid], children: number[] = [], task = pid) => {
    const directory = join(root, String(pid));
    mkdirSync(join(directory, 'task', String(task)), { recursive: true });
    writeFileSync(join(directory, 'stat'), `${pid} (runner with ) spaces) S 1 ${'0 '.repeat(17)}${start} 0\n`);
    writeFileSync(join(directory, 'status'), `Name:\trunner\nNSpid:\t${nspid.join('\t')}\n`);
    writeFileSync(join(directory, 'task', String(task), 'children'), children.join(' '));
  };
  add(100, '111', [100], [123]);
  add(123, '456');
  return { root, add, verify: (value: unknown, rootPid: number | undefined = 100, readProcFile?: (path: string) => string) => (
    verifyCodexAppEngineIdentity(value, rootPid, root, readProcFile)
  ) };
}

describe('signed Codex App engine identity', () => {
  it('accepts the signed child only while its kernel birth token still matches', () => {
    const tree = processTree();
    expect(tree.verify({ pid: 123, procStart: '456' }))
      .toEqual({ pid: 123, procStart: '456' });
    expect(tree.verify({ pid: 123, procStart: '455' })).toBeUndefined();
    expect(tree.verify({ pid: 124, procStart: '456' })).toBeUndefined();
    tree.add(123, '789'); // recycled PID cannot inherit the signed birth token
    expect(tree.verify({ pid: 123, procStart: '456' })).toBeUndefined();
  });

  it('translates only the owned subtree, ignoring a colliding host PID outside it', () => {
    const tree = processTree();
    tree.add(100, '111', [100], [123]);
    tree.add(123, '222', [123, 1], [456]);
    tree.add(456, '789', [456, 7]);
    tree.add(7, '789'); // an unrelated host process with the same signed pair
    expect(tree.verify({ pid: 7, procStart: '789' })).toEqual({ pid: 456, procStart: '789' });
    expect(tree.verify({ pid: 7, procStart: '789' }, 999)).toBeUndefined();
    expect(verifyCodexAppEngineIdentity({ pid: 7, procStart: '789' }, undefined, tree.root)).toBeUndefined();
  });

  it('walks children spawned by a non-leader task and nested PID namespaces', () => {
    const tree = processTree();
    tree.add(123, '456', [123, 1], [], 123);
    tree.add(123, '456', [123, 1], [456], 124);
    tree.add(456, '789', [456, 20, 7]);
    expect(tree.verify({ pid: 7, procStart: '789' })).toEqual({ pid: 456, procStart: '789' });
    expect(tree.verify({ pid: 20, procStart: '789' })).toBeUndefined();
    expect(tree.verify({ pid: 456, procStart: '789' })).toBeUndefined();
  });

  it('rejects an ambiguous match in sibling namespaces and a missing live process', () => {
    const tree = processTree();
    tree.add(100, '111', [100], [123, 456]);
    tree.add(123, '789', [123, 7]);
    tree.add(456, '789', [456, 7]);
    expect(tree.verify({ pid: 7, procStart: '789' })).toBeUndefined();
    rmSync(join(tree.root, '456'), { recursive: true });
    expect(tree.verify({ pid: 7, procStart: '789' })).toEqual({ pid: 123, procStart: '789' });
    rmSync(join(tree.root, '123'), { recursive: true });
    expect(tree.verify({ pid: 7, procStart: '789' })).toBeUndefined();
  });

  it('fails closed when the owned tree cannot be completely searched within the budget', () => {
    const tree = processTree();
    tree.add(100, '111', [100], Array.from({ length: 256 }, (_, i) => 200 + i));
    for (let pid = 200; pid < 456; pid++) tree.add(pid, '789');
    expect(tree.verify({ pid: 200, procStart: '789' })).toBeUndefined();
  });

  it('keeps a stable engine attested when an unrelated leaf exits during the scan', () => {
    const tree = processTree();
    tree.add(100, '111', [100], [123, 200]);
    tree.add(200, '222');
    let leafExited = false;
    const proof = { pid: 123, procStart: '456' };
    expect(tree.verify(proof, 100, path => {
      const result = readFileSync(path, 'utf8');
      if (path === join(tree.root, '200', 'stat')) {
        rmSync(join(tree.root, '200'), { recursive: true });
        leafExited = true;
      }
      return result;
    })).toEqual(proof);
    expect(leafExited).toBe(true);
  });

  it.each(['exit', 'reuse'] as const)('rejects ancestor %s after reading its child list', mode => {
    const tree = processTree();
    tree.add(100, '111', [100], [200]);
    tree.add(200, '222', [200], [123]);
    let ancestorChanged = false;
    expect(tree.verify({ pid: 123, procStart: '456' }, 100, path => {
      const result = readFileSync(path, 'utf8');
      if (!ancestorChanged && path === join(tree.root, '200', 'task', '200', 'children')) {
        ancestorChanged = true;
        if (mode === 'exit') rmSync(join(tree.root, '200'), { recursive: true });
        else tree.add(200, '333', [200], [123]);
      }
      return result;
    })).toBeUndefined();
    expect(ancestorChanged).toBe(true);
  });

  it('rejects a matched engine exiting while unrelated children are scanned', () => {
    const tree = processTree();
    tree.add(100, '111', [100], [123, 200]);
    tree.add(200, '222');
    expect(tree.verify({ pid: 123, procStart: '456' }, 100, path => {
      const result = readFileSync(path, 'utf8');
      if (path === join(tree.root, '200', 'stat')) rmSync(join(tree.root, '123'), { recursive: true });
      return result;
    })).toBeUndefined();
  });

  it.each([
    { value: null }, { value: [] }, { value: {} },
    { value: { pid: 1, procStart: '456' } }, { value: { pid: 1.5, procStart: '456' } },
    { value: { pid: '123', procStart: '456' } }, { value: { pid: 123, procStart: 456 } },
    { value: { pid: 123, procStart: '456\n' } }, { value: { pid: 123, procStart: '456', extra: true } },
  ])(
    'rejects malformed process proof %j', ({ value }) => {
      expect(processTree().verify(value)).toBeUndefined();
    },
  );
});
