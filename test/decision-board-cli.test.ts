/**
 * `botmux board` 的参数解析、截图读取与人读输出。
 */
import { describe, expect, it } from 'vitest';
import { formatBoardResult, parseBoardArgs, readBoardAttachFiles } from '../src/cli/board-command.js';

function parsed(argv: string[]) {
  const r = parseBoardArgs(argv);
  if (!r.ok || r.help) throw new Error(`unexpected: ${JSON.stringify(r)}`);
  return r.parsed;
}

describe('parseBoardArgs', () => {
  it('无子命令或 --help 给帮助', () => {
    expect(parseBoardArgs([])).toEqual({ ok: true, help: true });
    expect(parseBoardArgs(['add', '--help'])).toEqual({ ok: true, help: true });
  });

  it('add：标题是位置参数，字段 flag 映射到 patch 字段，选项与关联原样传 spec', () => {
    const p = parsed(['add', 'PR #12 合不合', '--key', 'pr:o/r#12', '--ask', '合不合？',
      '--option', 'A=合 → 无风险', '--option', 'B=不合', '--recommend', 'A', '--reason', '双审过了',
      '--link', 'pr=o/r#12', '--link', 'chat=oc_x', '--state', 'decide', '--stage=在审']);
    expect(p.action).toBe('add');
    expect(p.request).toEqual({
      action: 'add',
      title: 'PR #12 合不合',
      fields: { key: 'pr:o/r#12', state: 'decide', stage: '在审', question: '合不合？', recommend: 'A', recommendReason: '双审过了' },
      options: ['A=合 → 无风险', 'B=不合'],
      links: ['pr=o/r#12', 'chat=oc_x'],
    });
  });

  it('set：至少改一个字段；--clear-ask 只给 set', () => {
    expect(parseBoardArgs(['set', '12'])).toMatchObject({ ok: false });
    expect(parsed(['set', '#12', '--clear-ask']).request).toEqual({ action: 'set', ref: '#12', clearAsk: true, fields: {} });
    expect(parseBoardArgs(['add', 't', '--clear-ask'])).toMatchObject({ ok: false });
    expect(parsed(['set', '3', '--title', '新标题', '--json']).json).toBe(true);
  });

  it('--unlink：只给 set，可重复，原样传 spec；只有 --unlink 也算改了字段', () => {
    expect(parsed(['set', '3', '--unlink', 'doc=https://x/d.md|看板文档', '--unlink=pr=o/r#1', '--link', 'pr=o/r#2']).request)
      .toEqual({ action: 'set', ref: '3', fields: {}, links: ['pr=o/r#2'], unlinks: ['doc=https://x/d.md|看板文档', 'pr=o/r#1'] });
    expect(parseBoardArgs(['add', 't', '--unlink', 'pr=o/r#1'])).toMatchObject({ ok: false });
    expect(parseBoardArgs(['history', '3', 'x', '--unlink', 'pr=o/r#1'])).toMatchObject({ ok: false });
    expect(parseBoardArgs(['set', '3', '--unlink'])).toMatchObject({ ok: false });
  });

  it('history：一句话可以不加引号；--handled 只给 history', () => {
    expect(parsed(['history', '5', '已按', 'A', '合了', '--handled']).request)
      .toEqual({ action: 'history', ref: '5', text: '已按 A 合了', handled: true });
    expect(parseBoardArgs(['show', '5', '--handled'])).toMatchObject({ ok: false });
  });

  it('attach：图片路径进 attachPaths，不进请求体', () => {
    const p = parsed(['attach', '5', 'a.png', 'b.jpg', '--note', '复现截图']);
    expect(p.attachPaths).toEqual(['a.png', 'b.jpg']);
    expect(p.request).toEqual({ action: 'attach', ref: '5', note: '复现截图' });
  });

  it('未知参数、不支持的组合、缺值都拒绝', () => {
    expect(parseBoardArgs(['list', '--verbose'])).toMatchObject({ ok: false });
    expect(parseBoardArgs(['list', '--view', 'nope'])).toMatchObject({ ok: false });
    expect(parseBoardArgs(['show'])).toMatchObject({ ok: false });
    expect(parseBoardArgs(['add', 't', '--key'])).toMatchObject({ ok: false });
    expect(parseBoardArgs(['pending', '--key', 'x'])).toMatchObject({ ok: false });
    expect(parseBoardArgs(['frobnicate'])).toMatchObject({ ok: false });
  });
});

describe('readBoardAttachFiles', () => {
  it('按扩展名定 MIME，超过 10MB 或不是图片的拒绝', () => {
    const ok = readBoardAttachFiles(['/x/a.PNG'], () => Buffer.from('abc'), () => 3);
    expect(ok).toEqual({ ok: true, files: [{ name: 'a.PNG', mimeType: 'image/png', dataBase64: Buffer.from('abc').toString('base64') }] });
    expect(readBoardAttachFiles(['/x/a.svg'], () => Buffer.alloc(0), () => 1)).toMatchObject({ ok: false });
    expect(readBoardAttachFiles(['/x/a.png'], () => Buffer.alloc(0), () => 11 * 1024 * 1024)).toMatchObject({ ok: false });
  });
});

describe('formatBoardResult', () => {
  it('list：计数一行，每项一行带飞书里打开的链接和待执行决定数', () => {
    const out = formatBoardResult('list', {
      counts: { decide: 1, active: 0, all: 1 },
      items: [{ seq: 3, title: '合不合', stateLabel: '待拍板', stage: '在审', pendingDecisions: 1, appLink: 'https://applink/x' }],
    });
    expect(out).toBe('待你拍板 1 · 进行中 0 · 全部 1\n#3 待拍板·在审 合不合 ⏳1 个决定待执行  https://applink/x');
  });

  it('add 区分新建与已存在', () => {
    expect(formatBoardResult('add', { created: true, item: { seq: 1, title: 't', stateLabel: '进行中' } })).toBe('#1 已创建：t（进行中）');
    expect(formatBoardResult('add', { created: false, item: { seq: 1, title: 't', stateLabel: '进行中', url: 'u' } })).toBe('#1 已存在，已更新：t（进行中）\nu');
  });

  it('pending：没有时说没有；提交后事项又被改过时提醒先 show', () => {
    expect(formatBoardResult('pending', { decisions: [] })).toBe('没有待执行的决定');
    expect(formatBoardResult('pending', { decisions: [{ batchId: 2, seq: 3, title: 't', choice: 'A', choiceLabel: '合', text: '尽快', images: 1, itemChangedSinceDecision: true }] }))
      .toBe('批次 #2 · #3 t\n  选：A 合\n  说明：尽快\n  附图：1 张（随批次消息附上）\n  注意：owner 提交后这项又被改过，执行前先 show 看最新内容');
  });
});
