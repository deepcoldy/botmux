// HD2D office tab: lazily downloads the Godot web build (served from /game/)
// on demand. The ~74MB runtime binaries are NOT shipped in the npm package —
// they live as GitHub Release assets and are fetched + cached by the daemon
// (~/.botmux/cache/hd2d/) the first time the user clicks "load". Once cached,
// the game polls /api/sessions on the same origin and mirrors each session's
// screen status onto an office robot.
//
// The page escapes main's max-width/padding so the game fills the whole area
// right of the sidebar; styles are restored when the tab is left.

import { escapeHtml } from './ui.js';

interface GameStatus {
  state: 'absent' | 'downloading' | 'ready' | 'error';
  received: number;
  total: number;
  error?: string;
  proxy?: string;
}

// Fallback total used only when /api/game/status is unreachable (e.g. an
// unauthenticated viewer 401s) so the button still shows a sensible size.
const FALLBACK_TOTAL = 78_222_186;

export function renderOfficePage(host: HTMLElement): (() => void) | void {
  const prev = {
    maxWidth: host.style.maxWidth,
    padding: host.style.padding,
    flex: host.style.flex,
    minHeight: host.style.minHeight,
    display: host.style.display,
  };
  host.style.maxWidth = 'none';
  host.style.padding = '0';
  host.style.flex = '1 1 auto';
  host.style.minHeight = '0';
  host.style.display = 'flex';

  let disposed = false;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let proxy = ''; // last-known configured proxy, prefilled into the input
  const mb = (n: number) => (n / 1048576).toFixed(0);

  function stopPoll() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = undefined; }
  }

  function showIframe() {
    stopPoll();
    host.innerHTML = `
      <iframe
        src="/game/index.html"
        title="HD2D Office"
        style="flex:1;width:100%;min-height:0;border:none;display:block;background:#0b0d12;"
        allow="autoplay"
      ></iframe>`;
  }

  function showLoader(s: GameStatus) {
    const total = s.total || FALLBACK_TOTAL;
    const pct = total ? Math.min(100, Math.round((s.received / total) * 100)) : 0;
    const downloading = s.state === 'downloading';
    const err = s.state === 'error';
    host.innerHTML = `
      <div style="margin:auto;text-align:center;max-width:440px;padding:32px;color:var(--fg,#e6e6e6);">
        <div style="font-size:18px;font-weight:600;margin-bottom:8px;">HD2D 办公室</div>
        <div style="font-size:13px;opacity:.7;line-height:1.7;margin-bottom:20px;">
          把每个会话变成办公室里的一个机器人，实时映射屏幕状态。<br>
          首次进入需下载约 ${mb(total)} MB 游戏资源（仅一次，之后本地缓存）。
        </div>
        ${err ? `<div style="color:#e06c75;font-size:12px;margin-bottom:14px;">上次下载失败：${escapeHtml(s.error ?? '未知错误')}<br><span style="opacity:.7;">填代理后点重试</span></div>` : ''}
        ${downloading ? `
          <div style="background:rgba(127,127,127,.2);border-radius:6px;height:10px;overflow:hidden;margin-bottom:10px;">
            <div style="height:100%;width:${pct}%;background:#4a9eff;transition:width .3s;"></div>
          </div>
          <div style="font-size:12px;opacity:.7;">下载中… ${mb(s.received)} / ${mb(total)} MB（${pct}%）</div>
        ` : `
          <input id="hd2d-proxy" type="text" value="${escapeHtml(proxy)}"
            placeholder="HTTP 代理（可选，如 http://127.0.0.1:7890）"
            style="width:100%;box-sizing:border-box;margin-bottom:12px;padding:8px 10px;border-radius:6px;border:1px solid rgba(127,127,127,.4);background:transparent;color:inherit;font-size:12px;" />
          <div style="font-size:11px;opacity:.5;margin-bottom:14px;text-align:left;">连不上 GitHub 时填代理（仅用于下载本资源，会记住）。留空走直连/系统代理环境变量。</div>
          <button id="hd2d-load" style="cursor:pointer;border:none;border-radius:8px;padding:10px 22px;font-size:14px;font-weight:600;background:#4a9eff;color:#fff;">
            ${err ? '重试' : '加载办公室'}（约 ${mb(total)} MB）
          </button>
        `}
      </div>`;
    const btn = host.querySelector<HTMLButtonElement>('#hd2d-load');
    if (btn) btn.onclick = () => {
      const input = host.querySelector<HTMLInputElement>('#hd2d-proxy');
      proxy = input?.value.trim() ?? '';
      void startDownload();
    };
  }

  function route(s: GameStatus) {
    if (disposed) return;
    if (typeof s.proxy === 'string') proxy = s.proxy;
    if (s.state === 'ready') { showIframe(); return; }
    showLoader(s);
    if (s.state === 'downloading') pollTimer = setTimeout(() => void poll(), 700);
  }

  async function startDownload() {
    showLoader({ state: 'downloading', received: 0, total: FALLBACK_TOTAL });
    try {
      const r = await fetch('/api/game/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proxy }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      route(await r.json() as GameStatus);
    } catch (e) {
      showLoader({ state: 'error', received: 0, total: FALLBACK_TOTAL, error: e instanceof Error ? e.message : String(e) });
    }
  }

  async function poll() {
    if (disposed) return;
    try {
      const r = await fetch('/api/game/status');
      if (!r.ok) { showLoader({ state: 'absent', received: 0, total: FALLBACK_TOTAL }); return; }
      route(await r.json() as GameStatus);
    } catch {
      if (!disposed) pollTimer = setTimeout(() => void poll(), 1500);
    }
  }

  void poll(); // initial status probe → ready ? iframe : loader

  return () => {
    disposed = true;
    stopPoll();
    host.innerHTML = '';
    host.style.maxWidth = prev.maxWidth;
    host.style.padding = prev.padding;
    host.style.flex = prev.flex;
    host.style.minHeight = prev.minHeight;
    host.style.display = prev.display;
  };
}
