import { describe, expect, it } from 'vitest';
import type { Dirent, Stats } from 'node:fs';
import { listLatestDiagnosticFiles } from '../src/core/plugins/mcp/diagnostics-files.js';

function dirent(name: string): Dirent {
  return { name, isFile: () => true, isDirectory: () => false } as unknown as Dirent;
}

function stat(mtimeMs: number): Stats {
  return { mtimeMs } as Stats;
}

describe('listLatestDiagnosticFiles', () => {
  it('returns at most limit names matching suffix, newest mtime first', () => {
    const fs = {
      readdirSync: () => [dirent('a.json'), dirent('b.json'), dirent('c.json'), dirent('skip.txt')],
      statSync: (p: string) =>
        stat(p.endsWith('a.json') ? 1 : p.endsWith('b.json') ? 3 : p.endsWith('c.json') ? 2 : 0),
    };
    expect(listLatestDiagnosticFiles('/dir', 2, '.json', fs)).toEqual(['b.json', 'c.json']);
  });

  it('skips a file whose stat fails between readdir and sort instead of blanking the page', () => {
    // 写侧 TTL prune 可能在 readdir 之后、stat 之前删掉文件（ENOENT）。
    // 旧实现在 sort 比较器里直接 stat，任一 ENOENT 抛到外层 catch，整页空白。
    const fs = {
      readdirSync: () => [dirent('a.json'), dirent('gone.json'), dirent('b.json')],
      statSync: (p: string) => {
        if (p.endsWith('gone.json')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return stat(p.endsWith('a.json') ? 1 : 2);
      },
    };
    expect(listLatestDiagnosticFiles('/dir', 50, '.json', fs)).toEqual(['b.json', 'a.json']);
  });

  it('returns an empty list when the directory cannot be read', () => {
    const fs = {
      readdirSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
      statSync: stat,
    };
    expect(listLatestDiagnosticFiles('/missing', 50, '.json', fs)).toEqual([]);
  });
});
