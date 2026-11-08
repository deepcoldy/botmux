/**
 * 事项页的「图文说明」：说明页嵌在完全限制的 sandbox iframe 里（没有任何 allow-*），视频用页内播放器；
 * 历史里的说明页 / 视频是链接不是 <img>；列表行有入口标记。没有说明的事项页面照旧。
 */
import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoardSummaryView, ItemDetailView, resetBoardNavMemory } from '../src/dashboard/web/decision-board-page.js';
import {
  BOARD_EXPLAINER_SANDBOX, boardExplainers, eventFileKind, formatBoardBytes,
  type BoardDetailResponse, type BoardFile, type BoardItem,
} from '../src/dashboard/web/decision-board-model.js';
import { createDashboardTranslator } from '../src/dashboard/web/i18n.js';

const zh = createDashboardTranslator('zh');

let renderer: TestRenderer.ReactTestRenderer | undefined;
let routes: (url: string, init: RequestInit) => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const text = () => JSON.stringify(renderer!.toJSON());
const textOf = (node: ReactTestInstance): string => node.children.map(c => (typeof c === 'string' ? c : textOf(c))).join('');
const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
const all = (type: string) => renderer!.root.findAll(n => n.type === type);

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('document', { querySelector: () => null, addEventListener: () => {}, removeEventListener: () => {} });
  vi.stubGlobal('window', {
    setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id?: ReturnType<typeof setTimeout>) => globalThis.clearTimeout(id),
    requestAnimationFrame: (fn: () => void) => globalThis.setTimeout(fn, 0),
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true,
    localStorage: { getItem: () => null, setItem: () => {} },
  });
  vi.stubGlobal('location', { hash: '#/board?view=all', pathname: '/', search: '' });
  vi.stubGlobal('history', { state: null, replaceState: () => {} });
  resetBoardNavMemory();
  routes = () => json({ ok: false, error: 'not_found' }, 404);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => routes(String(url), init)));
});

afterEach(() => {
  if (renderer) act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function boardItem(seq: number, patch: Partial<BoardItem> = {}): BoardItem {
  return {
    seq, title: `事项 ${seq}`, state: 'decide', stage: '在审', question: '合不合？', options: [{ key: 'A', label: '合' }],
    rev: 5, createdAt: 1, updatedAt: 2, stateAt: 2, ...patch,
  };
}

function file(id: string, mime: string, name: string, createdAt: number, bytes = 2048): BoardFile {
  return { id, seq: 31, sha256: id.padEnd(64, '0'), mime, bytes, name, by: 'steward', createdAt };
}

const HTML = file('html0001', 'text/html', '改前改后.html', 100, 300 * 1024);
const VIDEO = file('video001', 'video/mp4', 'demo.mp4', 200, 12 * 1024 * 1024);
const SHOT = file('image001', 'image/png', 'shot.png', 150);

async function openDetail(patch: Partial<BoardDetailResponse>) {
  routes = (url, init) => {
    const method = init.method ?? 'GET';
    if (url.endsWith('/api/decision-board/cli_a/items/31') && method === 'GET') {
      return json({
        ok: true, item: boardItem(31), links: [], events: [], files: [], pendingDecisions: [],
        steward: { enabled: true, ready: true, chatId: 'oc_s' }, drafts: [], ...patch,
      });
    }
    if (url.endsWith('/seen')) return json({ ok: true });
    return json({ ok: false, error: 'not_found' }, 404);
  };
  await act(async () => {
    renderer = TestRenderer.create(React.createElement(ItemDetailView, { appId: 'cli_a', seq: 31 }));
  });
  await flush();
}

describe('事项页的图文说明', () => {
  it('说明页嵌在没有任何豁免的 sandbox iframe 里，视频是带控件、手机内联播放的播放器，新的排前面', async () => {
    await openDetail({ files: [HTML, SHOT, VIDEO] });
    const panel = renderer!.root.find(n => n.type === 'section' && String(n.props.className).includes('dboard-explainers'));
    expect(textOf(panel)).toContain(zh('decisionBoard.explainerTitle'));
    expect(panel.findAll(n => n.type === 'figure').map(f => f.props['data-file-id'])).toEqual(['video001', 'html0001']);

    const frames = all('iframe');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.props.src).toBe('/api/decision-board/cli_a/files/html0001');
    expect(frames[0]!.props.sandbox).toBe('');
    expect(frames[0]!.props.referrerPolicy).toBe('no-referrer');

    const [video] = all('video');
    expect(video!.props).toMatchObject({ src: '/api/decision-board/cli_a/files/video001', controls: true, playsInline: true, preload: 'metadata' });
    expect(textOf(panel)).toContain('12.0 MB');
    expect(textOf(panel)).toContain('300 KB');
    // 截图不进说明区。
    expect(textOf(panel)).not.toContain('shot.png');
  });

  it('全屏查看打开的也是同样限制的 sandbox iframe，关闭后移除', async () => {
    await openDetail({ files: [HTML] });
    const button = renderer!.root.find(n => n.type === 'button' && textOf(n) === zh('decisionBoard.explainerFullscreen'));
    act(() => button.props.onClick());
    const dialog = renderer!.root.find(n => n.type === 'dialog' && String(n.props.className).includes('dboard-explainer-dialog'));
    const frame = dialog.findByType('iframe');
    expect(frame.props.sandbox).toBe('');
    expect(frame.props.referrerPolicy).toBe('no-referrer');
    expect(frame.props.src).toBe('/api/decision-board/cli_a/files/html0001');
    expect(all('iframe')).toHaveLength(2);

    act(() => dialog.find(n => n.type === 'button' && textOf(n) === zh('decisionBoard.close')).props.onClick());
    expect(all('iframe')).toHaveLength(1);
  });

  it('视频放不了时提示换新标签页或下载', async () => {
    await openDetail({ files: [VIDEO] });
    expect(text()).not.toContain(zh('decisionBoard.explainerVideoFailed'));
    act(() => all('video')[0]!.props.onError());
    expect(text()).toContain(zh('decisionBoard.explainerVideoFailed'));
  });

  it('历史里的说明页 / 视频是带文件名的链接，不当图片渲染；截图仍是缩略图', async () => {
    await openDetail({
      files: [HTML, VIDEO, SHOT],
      events: [{ id: 1, seq: 31, at: 1, actor: 'steward', kind: 'attach', text: '附了图文说明', fileIds: ['html0001', 'video001', 'image001'] }],
    });
    const imgs = all('img').map(i => i.props.src);
    expect(imgs).toEqual(['/api/decision-board/cli_a/files/image001']);
    const event = renderer!.root.find(n => n.type === 'li' && String(n.props.className).includes('dboard-event'));
    const chips = event.findAll(n => n.type === 'a' && n.props.className === 'dboard-link');
    expect(chips.map(a => [textOf(a), a.props.href, a.props.target])).toEqual([
      ['📄 改前改后.html', '/api/decision-board/cli_a/files/html0001', '_blank'],
      ['🎬 demo.mp4', '/api/decision-board/cli_a/files/video001', '_blank'],
    ]);
  });

  it('没有图文说明的事项：不出说明区、没有 iframe / 播放器，历史里的图照旧（文件列表里查不到的也当截图）', async () => {
    await openDetail({
      files: [SHOT],
      events: [{ id: 1, seq: 31, at: 1, actor: 'owner', kind: 'decision', text: '选 A', fileIds: ['image001', 'gone0001'] }],
    });
    expect(text()).not.toContain(zh('decisionBoard.explainerTitle'));
    expect(all('iframe')).toHaveLength(0);
    expect(all('video')).toHaveLength(0);
    expect(all('img').map(i => i.props.src)).toEqual(['/api/decision-board/cli_a/files/image001', '/api/decision-board/cli_a/files/gone0001']);
  });
});

describe('列表行的图文说明标记', () => {
  it('有说明的行带标记，没有的（含旧 daemon 不给字段）不带', async () => {
    const items = [{ seq: 1, explainers: 2 }, { seq: 2 }];
    routes = (url, init) => {
      if (url.endsWith('/api/decision-board/boards')) {
        return json({ ok: true, boards: [{ larkAppId: 'cli_a', botName: '管家', online: true, steward: { enabled: true, ready: true } }] });
      }
      if (url.includes('/items?') && (init.method ?? 'GET') === 'GET') {
        return json({ ok: true, view: 'all', steward: { enabled: true, ready: true }, counts: { decide: 2, active: 0, all: 2 },
          items: items.map(i => ({ ...boardItem(i.seq), links: [], hasDraft: false, pendingDecisions: 0, unseen: false, ...i })), drafts: [], batches: [] });
      }
      return json({ ok: false, error: 'not_found' }, 404);
    };
    await act(async () => {
      renderer = TestRenderer.create(React.createElement(BoardSummaryView, { route: { view: 'all' } }));
    });
    for (let i = 0; i < 4; i += 1) await flush();
    const chips = renderer!.root.findAll(n => n.type === 'span' && n.props.className === 'dboard-row-explainer');
    expect(chips).toHaveLength(1);
    expect(textOf(chips[0]!)).toContain(zh('decisionBoard.explainerTitle'));
    const row = (seq: number) => renderer!.root.find(n => n.type === 'li' && textOf(n).includes(`事项 ${seq}`));
    expect(row(1).findAll(n => n.props.className === 'dboard-row-explainer')).toHaveLength(1);
    expect(row(2).findAll(n => n.props.className === 'dboard-row-explainer')).toHaveLength(0);
  });
});

describe('模型', () => {
  it('嵌入用的 sandbox 不给任何豁免', () => {
    expect(BOARD_EXPLAINER_SANDBOX).toBe('');
  });

  it('boardExplainers 只取说明页和视频，新的在前；eventFileKind 查不到时当截图', () => {
    const webm = file('webm0001', 'video/webm', 'rec.webm', 300);
    expect(boardExplainers([HTML, SHOT, VIDEO, webm]).map(x => [x.id, x.kind])).toEqual([
      ['webm0001', 'video'], ['video001', 'video'], ['html0001', 'html'],
    ]);
    const map = new Map([HTML, SHOT].map(f => [f.id, f] as const));
    expect(eventFileKind('html0001', map)).toBe('html');
    expect(eventFileKind('image001', map)).toBe('image');
    expect(eventFileKind('missing1', map)).toBe('image');
  });

  it('formatBoardBytes', () => {
    expect(formatBoardBytes(100)).toBe('1 KB');
    expect(formatBoardBytes(10 * 1024)).toBe('10 KB');
    expect(formatBoardBytes(50 * 1024 * 1024)).toBe('50.0 MB');
  });
});
