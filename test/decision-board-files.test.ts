/**
 * 决策看板附件口径（files.ts）：哪些类型算图文说明、文件头怎么认、HTML 的硬性要求和提醒、超限提示、
 * 文件名、HTML 的 CSP、视频 Range 的切法。
 */
import { describe, expect, it } from 'vitest';
import {
  BOARD_HTML_CSP,
  BOARD_HTML_MAX_BYTES,
  BOARD_VIDEO_MAX_BYTES,
  boardExplainerHtmlWarnings,
  boardExplainerMaxBytes,
  boardExplainerTooLargeText,
  boardFileKind,
  checkBoardExplainerHtml,
  isBoardExplainerMime,
  isSingleByteRange,
  normalizeBoardFileName,
  parseByteRange,
  sniffBoardExplainer,
} from '../src/core/decision-board/files.js';

const bytes = (...parts: Array<string | number[]>) => Buffer.concat(parts.map(p => (typeof p === 'string' ? Buffer.from(p) : Buffer.from(p))));
const MP4_HEAD = bytes([0, 0, 0, 0x18], 'ftypisom', [0, 0, 2, 0], 'isomiso2');
const WEBM_HEAD = bytes([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81]);

describe('白名单', () => {
  it('截图照旧算图片；只有 HTML 和 mp4 / webm 算图文说明，其它一律不认', () => {
    for (const m of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) expect(boardFileKind(m)).toBe('image');
    expect(boardFileKind('text/html')).toBe('html');
    expect(boardFileKind('TEXT/HTML')).toBe('html');
    expect(boardFileKind('video/mp4')).toBe('video');
    expect(boardFileKind('video/webm')).toBe('video');
    for (const m of ['image/svg+xml', 'text/plain', 'application/xhtml+xml', 'video/quicktime', 'application/pdf', '']) {
      expect(boardFileKind(m)).toBeUndefined();
      expect(isBoardExplainerMime(m)).toBe(false);
    }
    expect(isBoardExplainerMime('image/png')).toBe(false);
  });

  it('大小上限：说明页和视频各自一个上限，超限提示里写明上限、文件名，视频还教怎么压', () => {
    expect(boardExplainerMaxBytes('text/html')).toBe(BOARD_HTML_MAX_BYTES);
    expect(boardExplainerMaxBytes('video/webm')).toBe(BOARD_VIDEO_MAX_BYTES);
    expect(boardExplainerMaxBytes('video/mp4')).toBe(BOARD_VIDEO_MAX_BYTES);
    const mb = (n: number) => `${n / 1024 / 1024}MB`;
    expect(boardExplainerTooLargeText('video/mp4', 'demo.mp4')).toContain(mb(BOARD_VIDEO_MAX_BYTES));
    expect(boardExplainerTooLargeText('video/mp4', 'demo.mp4')).toMatch(/demo\.mp4.*ffmpeg/);
    expect(boardExplainerTooLargeText('text/html', 'a.html')).toContain(mb(BOARD_HTML_MAX_BYTES));
    expect(boardExplainerTooLargeText('text/html', 'a.html')).toContain('a.html');
  });
});

describe('文件头', () => {
  it('按内容认类型，不信扩展名', () => {
    expect(sniffBoardExplainer('video/mp4', MP4_HEAD)).toBe(true);
    expect(sniffBoardExplainer('video/webm', WEBM_HEAD)).toBe(true);
    expect(sniffBoardExplainer('text/html', bytes('<!doctype html>'))).toBe(true);
    expect(sniffBoardExplainer('text/html', bytes([0xef, 0xbb, 0xbf], '\r\n  <html>'))).toBe(true);
    // 改了扩展名的 png、互相冒充的视频、纯文本都不认。
    const png = bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    expect(sniffBoardExplainer('video/mp4', png)).toBe(false);
    expect(sniffBoardExplainer('video/webm', MP4_HEAD)).toBe(false);
    expect(sniffBoardExplainer('video/mp4', WEBM_HEAD)).toBe(false);
    expect(sniffBoardExplainer('text/html', bytes('hello <b>'))).toBe(false);
    expect(sniffBoardExplainer('text/html', png)).toBe(false);
    expect(sniffBoardExplainer('image/png', png)).toBe(false);
  });
});

describe('说明页正文', () => {
  it('必须是 UTF-8，不能带 meta refresh（各种写法都拦）', () => {
    expect(checkBoardExplainerHtml(bytes('<p>你好</p>'))).toMatchObject({ ok: true, text: '<p>你好</p>' });
    expect(checkBoardExplainerHtml(bytes('<p>', [0xc4, 0xe3], '</p>'))).toMatchObject({ ok: false, reason: expect.stringContaining('UTF-8') });
    for (const meta of [
      '<meta http-equiv="refresh" content="0;url=https://x">',
      "<META HTTP-EQUIV='Refresh' CONTENT='1'>",
      '<meta content="0" http-equiv=refresh>',
    ]) {
      expect(checkBoardExplainerHtml(bytes(`<head>${meta}</head>`))).toMatchObject({ ok: false, reason: expect.stringContaining('refresh') });
    }
    expect(checkBoardExplainerHtml(bytes('<meta http-equiv="content-type" content="text/html; charset=utf-8">'))).toMatchObject({ ok: true });
  });

  it('meta refresh 换上下文、换编码也拦得住；正文里把等号转义后可以提到它', () => {
    for (const html of [
      '<meta content="0;url=https://x" data-x="a>b" http-equiv="refresh">',
      '<meta http-equiv="&#114;efresh" content="0;url=https://x">',
      '<meta http-equiv=&#x52;EFRESH content=0>',
      '<meta http-equiv="&#0000114efresh" content=0>',
      '<meta http-equiv=" refresh " content=0>',
      '<meta http-equiv = \n refresh content=0>',
      '<script>"</script><meta http-equiv=refresh content=0>',
      '<!--><meta http-equiv=refresh content=0>',
      '<body><svg><style><meta http-equiv=refresh content=0></style></svg></body>',
    ]) {
      expect(checkBoardExplainerHtml(bytes(html)), html).toMatchObject({ ok: false, reason: expect.stringContaining('refresh') });
    }
    for (const html of [
      '<meta http-equiv="refreshx" content=0>',
      '<meta http-equiv="ref resh" content=0>',
      '<meta http-equiv / =refresh content=0>',
      '<p><code>&lt;meta http-equiv&#61;"refresh"&gt;</code></p>',
    ]) {
      expect(checkBoardExplainerHtml(bytes(html)), html).toMatchObject({ ok: true });
    }
  });

  it('恶意构造的大文件也在线性时间内校验完（校验跑在 daemon 的事件循环上）', () => {
    const n = 200_000;
    const inputs = [
      '<meta '.repeat(n / 6),
      '<a '.repeat(n / 3),
      `<img src=${' '.repeat(n)}>`,
      `<div style="background:url(${' '.repeat(n)}">`,
      '<a onx'.repeat(n / 6),
      'http-equiv='.repeat(n / 11),
      'http-equiv="'.repeat(n / 12),
      `http-equiv=&#${'0'.repeat(n)}`,
      `<meta http-equiv="${' '.repeat(n)}`,
    ];
    const startedAt = performance.now();
    for (const html of inputs) {
      checkBoardExplainerHtml(bytes(html));
      boardExplainerHtmlWarnings(html);
    }
    expect(performance.now() - startedAt).toBeLessThan(2_000);
  }, 60_000);

  it('外链和脚本不拒收，只提醒；data: 图片和内联样式不提醒', () => {
    expect(boardExplainerHtmlWarnings('<style>p{color:red}</style><img src="data:image/png;base64,AAAA">')).toEqual([]);
    const ext = boardExplainerHtmlWarnings('<img src="https://cdn.x/a.png"><link href="//cdn.x/a.css"><div style="background:url(https://x/b.png)">');
    expect(ext).toHaveLength(1);
    expect(ext[0]).toMatch(/3 处外链/);
    expect(boardExplainerHtmlWarnings('<script>alert(1)</script>')[0]).toMatch(/脚本/);
    expect(boardExplainerHtmlWarnings('<button onclick="x()">x</button>')[0]).toMatch(/脚本/);
    // 正文里的 "one = two" 不是事件属性。
    expect(boardExplainerHtmlWarnings('<p>some one = two</p>')).toEqual([]);
  });
});

describe('CSP', () => {
  it('sandbox 不带任何 allow-*；默认全拦，只放 data: 图片和内联样式', () => {
    const directives = new Map(BOARD_HTML_CSP.split(';').map(d => d.trim().split(/\s+/)).map(([k, ...v]) => [k!, v]));
    expect(directives.get('sandbox')).toEqual([]);
    expect(BOARD_HTML_CSP).not.toMatch(/allow-/);
    expect(directives.get('default-src')).toEqual(["'none'"]);
    expect(directives.get('img-src')).toEqual(['data:']);
    expect(directives.get('style-src')).toEqual(["'unsafe-inline'"]);
    expect(directives.has('script-src')).toBe(false);
    expect(directives.get('form-action')).toEqual(["'none'"]);
    expect(directives.get('base-uri')).toEqual(["'none'"]);
  });
});

describe('文件名', () => {
  it('只留文件名本身，扩展名按类型定', () => {
    expect(normalizeBoardFileName('/tmp/x/改前改后.htm', 'text/html', 'explainer')).toBe('改前改后.html');
    expect(normalizeBoardFileName('..\\..\\evil name<>.mp4', 'video/mp4', 'explainer')).toBe('evil-name.mp4');
    expect(normalizeBoardFileName('', 'video/webm', 'explainer')).toBe('explainer.webm');
    expect(normalizeBoardFileName('...', 'text/html', 'explainer')).toBe('explainer.html');
    expect(normalizeBoardFileName(42, 'text/html', 'explainer')).toBe('explainer.html');
  });
});

describe('Range', () => {
  const size = 1000;
  it.each([
    [undefined, { kind: 'none' }],
    ['items=0-1', { kind: 'none' }],
    ['bytes=', { kind: 'none' }],
    ['bytes=-', { kind: 'none' }],
    ['bytes=5-2', { kind: 'none' }],
    ['bytes=0-1,5-6', { kind: 'none' }],
    ['bytes=abc-', { kind: 'none' }],
    ['bytes=0-99', { kind: 'range', start: 0, end: 99 }],
    ['bytes=0-', { kind: 'range', start: 0, end: 999 }],
    ['bytes=900-5000', { kind: 'range', start: 900, end: 999 }],
    ['bytes=-100', { kind: 'range', start: 900, end: 999 }],
    ['bytes=-5000', { kind: 'range', start: 0, end: 999 }],
    ['bytes=999-', { kind: 'range', start: 999, end: 999 }],
    ['bytes=1000-', { kind: 'unsatisfiable' }],
    ['bytes=1000-1001', { kind: 'unsatisfiable' }],
    ['bytes=-0', { kind: 'unsatisfiable' }],
  ] as const)('%s', (header, expected) => {
    expect(parseByteRange(header, size)).toEqual(expected);
  });

  it('每次最多回 maxChunk 字节（open-ended 和后缀范围也一样），播放器按 Content-Range 接着要', () => {
    expect(parseByteRange('bytes=0-', size, 256)).toEqual({ kind: 'range', start: 0, end: 255 });
    expect(parseByteRange('bytes=500-', size, 256)).toEqual({ kind: 'range', start: 500, end: 755 });
    expect(parseByteRange('bytes=-600', size, 256)).toEqual({ kind: 'range', start: 400, end: 655 });
    expect(parseByteRange('bytes=10-20', size, 256)).toEqual({ kind: 'range', start: 10, end: 20 });
  });

  it.each([
    '', 'items=0-1', 'bytes=', 'bytes=-', 'bytes=5-2', 'bytes=0-1,5-6', 'bytes=0-1,', 'bytes=abc-', 'bytes=0x10-',
    'bytes=0-99', 'bytes=0-', 'bytes=-100', 'bytes=1-1', 'bytes=1000-', 'bytes=-0', 'BYTES=0-1', ' bytes = 0 - 1 ',
    `bytes=${'9'.repeat(16)}-`,
  ])('Dashboard 认定的单段 Range 和 daemon 的解析一致：%j', header => {
    expect(isSingleByteRange(header)).toBe(parseByteRange(header, size).kind !== 'none');
  });
});
