import { describe, expect, it } from 'vitest';
import { issueWorkingDirs } from '../src/im/lark/issue-command-deps.js';

describe('Issue 领取仓库来源', () => {
  it('没有显式扫描根时回退到固定默认目录', () => {
    expect(issueWorkingDirs({ defaultWorkingDir: '~/botmux' })).toEqual(['~/botmux']);
  });

  it('显式扫描根存在时不混入固定默认目录', () => {
    expect(issueWorkingDirs({
      workingDir: '~/workspace',
      workingDirs: ['~/workspace', '~/other-workspace'],
      defaultWorkingDir: '~/botmux',
    })).toEqual(['~/workspace', '~/other-workspace']);
  });

  it('空白配置不会制造无效候选', () => {
    expect(issueWorkingDirs({
      workingDir: ' ',
      workingDirs: ['', '  '],
      defaultWorkingDir: ' ',
    })).toEqual([]);
  });
});
