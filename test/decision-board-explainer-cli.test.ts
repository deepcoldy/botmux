/**
 * `botmux board attach` 附图文说明的 CLI 侧：按扩展名分流、大小上限和报错文案、人读输出。
 */
import { describe, expect, it } from 'vitest';
import { formatBoardResult, readBoardAttachFiles, readBoardExplainerFiles, splitBoardAttachPaths } from '../src/cli/board-command.js';

const MB = 1024 * 1024;

describe('splitBoardAttachPaths', () => {
  it('截图和说明页 / 视频分开，扩展名不分大小写', () => {
    expect(splitBoardAttachPaths(['a.png', 'x.HTML', 'b.webp', 'demo.mp4', 'c.htm', 'd.WebM'])).toEqual({
      ok: true, images: ['a.png', 'b.webp'], explainers: ['x.HTML', 'demo.mp4', 'c.htm', 'd.WebM'],
    });
  });

  it.each(['notes.pdf', 'a.svg', 'clip.mov', 'page.xhtml', 'noext'])('不认的文件 %s 报错并列出支持的类型', p => {
    expect(splitBoardAttachPaths(['a.png', p])).toEqual({
      ok: false, error: `只支持截图（png / jpg / gif / webp）、说明页（.html）和视频（.mp4 / .webm）：${p}`,
    });
  });

  it('一次最多 4 个说明页 / 视频，截图不计入', () => {
    expect(splitBoardAttachPaths(['1.html', '2.mp4', '3.webm', '4.html', 'a.png', 'b.png']).ok).toBe(true);
    expect(splitBoardAttachPaths(['1.html', '2.mp4', '3.webm', '4.html', '5.html'])).toEqual({
      ok: false, error: '一次最多附 4 个说明页 / 视频，分几次 attach',
    });
  });
});

describe('readBoardExplainerFiles', () => {
  const read = (p: string) => Buffer.from(`content of ${p}`);

  it('按扩展名定 MIME，取文件名不带目录', () => {
    const r = readBoardExplainerFiles(['/tmp/x/说明.html', '/tmp/demo.mp4', 'rec.webm'], read, () => 100);
    expect(r).toEqual({ ok: true, files: [
      { name: '说明.html', mime: 'text/html', bytes: read('/tmp/x/说明.html') },
      { name: 'demo.mp4', mime: 'video/mp4', bytes: read('/tmp/demo.mp4') },
      { name: 'rec.webm', mime: 'video/webm', bytes: read('rec.webm') },
    ] });
  });

  it('说明页 10MB、视频 50MB 正好放行，多 1 字节就拒，报错里写上限和压缩办法，且不读文件', () => {
    const never = () => { throw new Error('超限文件不该被读'); };
    expect(readBoardExplainerFiles(['a.html'], read, () => 10 * MB).ok).toBe(true);
    expect(readBoardExplainerFiles(['a.mp4'], read, () => 50 * MB).ok).toBe(true);

    const html = readBoardExplainerFiles(['a.html'], never, () => 10 * MB + 1);
    expect(html.ok).toBe(false);
    expect(!html.ok && html.error).toMatch(/10MB/);
    expect(!html.ok && html.error).toContain('a.html');

    const video = readBoardExplainerFiles(['/tmp/big.webm'], never, () => 50 * MB + 1);
    expect(video.ok).toBe(false);
    expect(!video.ok && video.error).toMatch(/50MB/);
    expect(!video.ok && video.error).toContain('ffmpeg');
    expect(!video.ok && video.error).toContain('/tmp/big.webm');
  });

  it('空文件、读不到的文件报错', () => {
    expect(readBoardExplainerFiles(['a.html'], read, () => 0)).toEqual({ ok: false, error: '文件是空的：a.html' });
    expect(readBoardExplainerFiles(['gone.mp4'], read, () => { throw new Error('ENOENT'); })).toEqual({ ok: false, error: '读不到文件：gone.mp4' });
  });

  it('截图读取照旧：说明页仍不归它管', () => {
    expect(readBoardAttachFiles(['a.html'], read, () => 1)).toEqual({ ok: false, error: '只支持 png / jpg / gif / webp：a.html' });
  });
});

describe('formatBoardResult attach', () => {
  it('只有截图：输出和以前一样；老 daemon 不回 mime 也一样', () => {
    expect(formatBoardResult('attach', { seq: 3, files: [{ id: 'a', mime: 'image/png' }, { id: 'b', mime: 'image/jpeg' }] })).toBe('#3 已附 2 张图');
    expect(formatBoardResult('attach', { seq: 3, files: [{ id: 'a' }] })).toBe('#3 已附 1 张图');
  });

  it('带说明页 / 视频：分别计数，附上事项链接', () => {
    expect(formatBoardResult('attach', {
      seq: 7, appLink: 'https://applink.example/board/7',
      files: [{ mime: 'text/html' }, { mime: 'video/mp4' }, { mime: 'image/png' }],
    })).toMatch(/^#7 \D*2\D*1\D*\nhttps:\/\/applink\.example\/board\/7$/);
    const single = formatBoardResult('attach', { seq: 7, files: [{ mime: 'video/webm' }] });
    expect(single).toMatch(/^#7 \D*1\D*$/);
    expect(single).not.toContain('截图');
  });
});
