import { describe, expect, it } from 'vitest';
import {
  parseSendInvocation,
  validateClientSendInvocation,
  validateHostSendInvocation,
} from '../src/cli/send-invocation.js';

function fakeStat(files: readonly string[]) {
  return (token: string) => (files.includes(token) ? 'file' as const : 'not-file' as const);
}

function client(argv: string[], files: readonly string[] = []) {
  return validateClientSendInvocation(parseSendInvocation(argv), {
    cwd: '/repo',
    statFile: fakeStat(files),
  });
}

function host(argv: string[], uploads: readonly string[] = []) {
  return validateHostSendInvocation(parseSendInvocation(argv), {
    uploads: uploads.map(name => ({ name })),
  });
}

describe('parseSendInvocation', () => {
  it('keeps one value per attachment flag and exposes the extra path as positional', () => {
    const invocation = parseSendInvocation(['--files', 'a', 'b', '--response-kind', 'final']);
    expect(invocation.flags['--files']).toEqual(['a']);
    expect(invocation.positionals).toEqual(['b']);
    expect(invocation.attachmentOccurrences).toEqual([{ flag: '--files', value: 'a', form: 'space' }]);
    expect(invocation.bodySource).toBe('positional');
  });

  it('preserves attachment order across alias spellings', () => {
    const result = client(['--images', 'a', '--image', 'b']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.attachments.images).toEqual(['a', 'b']);
  });

  it('recognizes the equals form', () => {
    const invocation = parseSendInvocation(['--files=a']);
    expect(invocation.flags['--files']).toEqual(['a']);
    expect(invocation.attachmentOccurrences).toEqual([{ flag: '--files', value: 'a', form: 'equals' }]);
  });

  it('treats a lone dash as stdin and keeps it positional otherwise', () => {
    expect(parseSendInvocation(['-']).bodySource).toBe('stdin');
    expect(parseSendInvocation(['-', 'extra']).bodySource).toBe('positional');
    expect(parseSendInvocation(['-', 'extra']).positionals).toEqual(['-', 'extra']);
  });

  it('records raw exact -- before any help handling', () => {
    const invocation = parseSendInvocation(['--help', '--']);
    expect(invocation.freeHelpRequested).toBe(true);
    expect(invocation.rawDoubleDashToken).toBe(true);
  });

  it('does not treat a value-position --help as free help', () => {
    const invocation = parseSendInvocation(['--mention', '--help']);
    expect(invocation.freeHelpRequested).toBe(false);
    expect(invocation.arityErrors).toHaveLength(1);
    expect(invocation.arityErrors[0]).toContain('--mention 缺少值');
  });

  it('rejects unknown flags, missing values, and --version deterministically', () => {
    expect(parseSendInvocation(['--version']).arityErrors[0]).toContain('未知参数 --version');
    expect(parseSendInvocation(['--files']).arityErrors[0]).toContain('--files 缺少值');
    expect(parseSendInvocation(['--files', 'a', '--files']).arityErrors[0]).toContain('--files 缺少值');
    expect(parseSendInvocation(['--mention', '--help']).arityErrors[0]).toContain('--mention 缺少值');
  });

  it('treats bare attention/urgent as boolean in PR-1', () => {
    const attention = parseSendInvocation(['--attention', 'blocked']);
    expect(attention.flags['--attention']).toEqual([]);
    expect(attention.positionals).toEqual(['blocked']);
    const urgent = parseSendInvocation(['--urgent', 'app']);
    expect(urgent.flags['--urgent']).toEqual([]);
    expect(urgent.positionals).toEqual(['app']);
  });

  it('keeps a content-file dash as a content-file source for validation', () => {
    expect(parseSendInvocation(['--content-file', '-']).bodySource).toBe('content-file');
  });
});

describe('validateClientSendInvocation', () => {
  it('accepts a lone dash as stdin', () => {
    const result = client(['-']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.plan.invocation.bodySource).toBe('stdin');
  });

  it('rejects a dash mixed with other body tokens', () => {
    expect(client(['-', 'extra'])).toMatchObject({ ok: false });
    expect(client(['--content-file', 'body.md', '-'])).toMatchObject({ ok: false });
  });

  it('rejects extra attachment-looking paths even when the path does not exist', () => {
    expect(client(['--files', 'a', 'b'], ['a', 'b'])).toMatchObject({
      ok: false,
      message: expect.stringContaining('额外路径'),
    });
    expect(client(['--images', 'p1', 'p2'], ['p1', 'p2'])).toMatchObject({ ok: false });
    expect(client(['--files', 'a', '正文'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', 'missing'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', 'missing.sql'], ['a'])).toMatchObject({ ok: false });
    expect(client(['--files', 'a', './my report.sql'], ['a'])).toMatchObject({ ok: false });
    expect(client(['--files', 'a', './报告.sql'], ['a'])).toMatchObject({ ok: false });
    expect(client(['--files', 'a', 'C:\\my dir\\x.sql'], ['a'])).toMatchObject({ ok: false });
    expect(client(['--files', 'a', '\\\\srv\\my share\\x.sql'], ['a'])).toMatchObject({ ok: false });
    expect(client(['--files', 'a', '\\srv\\my share\\x.sql'], ['a'])).toMatchObject({ ok: false });
    expect(client(['--files', 'a', '\\my dir\\x.sql'], ['a'])).toMatchObject({ ok: false });
    expect(client(['--files', 'a', '详见 ./out.sql 第 3 行'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', 'see report.sql'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', '/help 是命令'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', './build.sh 跑过了'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', '~/ 是 home 目录'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', 'C:\\ 是系统盘'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', '\\srv 是共享根'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', '见 https://x.y/z.md'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', '结论：a/b 两种方案'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', 'https://x.y/z.md'], ['a'])).toMatchObject({ ok: true });
    expect(client(['--files', 'a', 'a/b'], ['a'])).toMatchObject({ ok: true });
  });

  it('rejects --content-file - and card positional arguments before reading files', () => {
    expect(client(['--content-file', '-'])).toMatchObject({
      ok: false,
      message: expect.stringContaining("--content-file 不支持 '-'"),
    });
    expect(client(['--card-file', 'card.json', 'extra'])).toMatchObject({
      ok: false,
      message: expect.stringContaining('不接受正文参数'),
    });
  });

  it('rejects hand-written riff placeholders in every token role', () => {
    for (const argv of [
      ['--files', 'riff-upload:0'],
      ['--files=RIFF-UPLOAD:1'],
      ['--mention', 'riff-upload:2'],
      ['riff-upload:3'],
    ]) {
      expect(client(argv)).toMatchObject({ ok: false });
    }
  });

  it('allows a real relative path that merely contains the prefix', () => {
    expect(client(['--files', './riff-upload:0'], ['./riff-upload:0'])).toMatchObject({ ok: true });
  });

  it('rejects raw exact -- before help', () => {
    expect(client(['--help', '--'])).toMatchObject({
      ok: false,
      message: expect.stringContaining("'--' 分隔符尚未支持"),
    });
    expect(client(['--', '--help'])).toMatchObject({ ok: false });
  });
});

describe('validateHostSendInvocation', () => {
  it('accepts a placeholder bijection and never stats', () => {
    expect(host(['--files', 'riff-upload:0'], ['a'])).toMatchObject({
      ok: true,
      plan: { uploadIndexes: [0] },
    });
    expect(host(['--files', 'riff-upload:0', '--files', 'riff-upload:1'], ['a', 'b'])).toMatchObject({
      ok: true,
      plan: { uploadIndexes: [0, 1] },
    });
  });

  it('rejects out-of-range, leading-zero, signed, float, uppercase, and duplicate indexes', () => {
    for (const value of [
      'riff-upload:99',
      'riff-upload:00',
      'riff-upload:+1',
      'riff-upload:-1',
      'riff-upload:1.0',
      'RIFF-UPLOAD:0',
      'riff-upload:0 ',
      ' riff-upload:0',
      'riff-upload:0\n',
    ]) {
      expect(host(['--files', value], ['a'])).toMatchObject({ ok: false });
    }
    expect(host(['--files', 'riff-upload:0', '--files', 'riff-upload:0'], ['a'])).toMatchObject({ ok: false });
  });

  it('rejects positional placeholders, real paths, equals file values, and unreferenced uploads', () => {
    expect(host(['riff-upload:0'], ['a'])).toMatchObject({ ok: false });
    expect(host(['--files', '/tmp/a'], ['a'])).toMatchObject({ ok: false });
    expect(host(['--files=riff-upload:0'], ['a'])).toMatchObject({ ok: false });
    expect(host(['--files', 'riff-upload:0'], ['a', 'b'])).toMatchObject({ ok: false });
    expect(host(['--mention', 'riff-upload:0'], ['a'])).toMatchObject({ ok: false });
  });

  it('does not run the client positional-file heuristic (client owns ④)', () => {
    // The host never stats; a real extra positional is accepted here and is
    // caught by the spawned CLI's client validator when it exists as a file.
    expect(host(['--files', 'riff-upload:0', '/tmp/a'], ['a'])).toMatchObject({ ok: true });
  });
});
