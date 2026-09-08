/**
 * cot-subject — 工具调用主题提取（转写层与气泡渲染层共用）。
 *
 * 关键回归：主题必须能从**未截断**的完整 input 上取到——长命令 / 大 content 的
 * Write 不再退化成裸类别标签。
 */
import { describe, it, expect } from 'vitest';

import {
  COT_SUBJECT_MAX_CHARS,
  COT_TOOL_TITLE_SUBJECT_MAX_CHARS,
  boundSubjectForTitle,
  boundSubjectForTransport,
  recoverSubjectFromTruncatedJson,
  subjectFromArgsString,
  subjectFromInputObject,
} from '../src/services/cot-subject.js';

describe('subjectFromInputObject', () => {
  it('picks command first', () => {
    expect(subjectFromInputObject({ command: 'ls -la', description: '列目录' })).toBe('ls -la');
  });
  it('argv array → last element (local_shell_call)', () => {
    expect(subjectFromInputObject({ command: ['bash', '-lc', 'pnpm build'] })).toBe('pnpm build');
  });
  it('cmd / file_path / pattern / query / url in priority order', () => {
    expect(subjectFromInputObject({ cmd: 'free -h' })).toBe('free -h');
    expect(subjectFromInputObject({ file_path: '/a/b.ts', content: 'x'.repeat(50_000) })).toBe('/a/b.ts');
    expect(subjectFromInputObject({ pattern: 'TODO', path: '/src' })).toBe('/src');
    expect(subjectFromInputObject({ query: 'feishu cot' })).toBe('feishu cot');
    expect(subjectFromInputObject({ type: 'open_page', url: 'https://x.y/z' })).toBe('https://x.y/z');
  });
  it('description / prompt as last resort', () => {
    expect(subjectFromInputObject({ description: '子任务', prompt: '做点事' })).toBe('子任务');
    expect(subjectFromInputObject({ prompt: '做点事' })).toBe('做点事');
  });
  it('blank / unknown / non-object → empty', () => {
    expect(subjectFromInputObject({ command: '   ' })).toBe('');
    expect(subjectFromInputObject({ taskId: '1' })).toBe('');
    expect(subjectFromInputObject(undefined)).toBe('');
    expect(subjectFromInputObject('str')).toBe('');
    expect(subjectFromInputObject(['a'])).toBe('');
  });
  it('collapses whitespace to one line', () => {
    expect(subjectFromInputObject({ command: 'cat <<EOF\n  a\n\tb\nEOF' })).toBe('cat <<EOF a b EOF');
  });
  it('keeps a 700-char command intact (no 600 truncation at this layer)', () => {
    const cmd = 'echo ' + 'x'.repeat(695);
    expect(subjectFromInputObject({ command: cmd })).toBe(cmd);
  });
});

describe('subjectFromArgsString', () => {
  it('valid JSON → object path', () => {
    expect(subjectFromArgsString('{"command":"git log --oneline"}')).toBe('git log --oneline');
    expect(subjectFromArgsString('{"command":["bash","-lc","ls"],"workdir":"/x"}')).toBe('ls');
  });
  it('truncated JSON → regex recovery of a complete leading field', () => {
    expect(subjectFromArgsString('{"file_path":"/a/b.ts","content":"xxxxxxxx')).toBe('/a/b.ts');
  });
  it('truncated JSON with the value itself cut → empty', () => {
    expect(subjectFromArgsString('{"command":"echo aaaaaaaaaa')).toBe('');
  });
  it('bare script string → collapsed as-is', () => {
    expect(subjectFromArgsString('const a = 1;\nconsole.log(a)')).toBe('const a = 1; console.log(a)');
  });
  it('apply_patch text → first file path', () => {
    const patch = '*** Begin Patch\n*** Update File: src/a/b.ts\n@@\n-x\n+y\n*** End Patch';
    expect(subjectFromArgsString(patch)).toBe('src/a/b.ts');
  });
  it('empty → empty', () => {
    expect(subjectFromArgsString('')).toBe('');
    expect(subjectFromArgsString('   ')).toBe('');
  });
});

describe('recoverSubjectFromTruncatedJson', () => {
  it('skips bad escapes and moves to the next field', () => {
    expect(recoverSubjectFromTruncatedJson('{"command":"a\\q","file_path":"/p"}')).toBe('/p');
  });
  it('undefined when nothing complete', () => {
    expect(recoverSubjectFromTruncatedJson('{"command":"abc')).toBeUndefined();
  });
});

describe('bounds', () => {
  it('title: display truncated at 80, full intact', () => {
    const long = 'a'.repeat(COT_TOOL_TITLE_SUBJECT_MAX_CHARS + 1) + '.ts';
    const r = boundSubjectForTitle(long);
    expect(r.display).toBe('a'.repeat(COT_TOOL_TITLE_SUBJECT_MAX_CHARS) + '…');
    expect(r.full).toBe(long);
  });
  it('title: short subject identical in both', () => {
    expect(boundSubjectForTitle('ls')).toEqual({ display: 'ls', full: 'ls' });
    expect(boundSubjectForTitle('')).toEqual({ display: '', full: '' });
  });
  it('transport: truncated at 1000 with ellipsis', () => {
    const s = 'b'.repeat(COT_SUBJECT_MAX_CHARS + 5);
    expect(boundSubjectForTransport(s)).toBe('b'.repeat(COT_SUBJECT_MAX_CHARS) + '…');
    expect(boundSubjectForTransport('short')).toBe('short');
  });
});
