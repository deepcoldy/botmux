import { useEffect, useMemo, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { useT } from './react-hooks.js';

interface GameStatus {
  state: 'absent' | 'downloading' | 'ready' | 'error';
  received: number;
  total: number;
  error?: string;
  proxy?: string;
}

// Fallback total used only when /api/game/status is unreachable (for example,
// an unauthenticated viewer 401s) so the button still shows a sensible size.
const FALLBACK_TOTAL = 78_222_186;

function mb(n: number): string {
  return (n / 1048576).toFixed(0);
}

function OfficePage() {
  const tr = useT();
  const [status, setStatus] = useState<GameStatus | null>(null);
  const [proxy, setProxy] = useState('');
  const [starting, setStarting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disposedRef = useRef(false);

  const stopPoll = () => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  };

  async function poll(): Promise<void> {
    if (disposedRef.current) return;
    try {
      const r = await fetch('/api/game/status');
      if (disposedRef.current) return;
      if (!r.ok) {
        setStatus({ state: 'absent', received: 0, total: FALLBACK_TOTAL });
        return;
      }
      const next = await r.json() as GameStatus;
      if (disposedRef.current) return;
      setStatus(next);
      if (typeof next.proxy === 'string') setProxy(next.proxy);
      if (next.state === 'downloading') {
        timerRef.current = setTimeout(() => void poll(), 700);
      }
    } catch {
      if (!disposedRef.current) timerRef.current = setTimeout(() => void poll(), 1500);
    }
  }

  useEffect(() => {
    disposedRef.current = false;
    void poll();
    return () => {
      disposedRef.current = true;
      stopPoll();
    };
  }, []);

  async function startDownload(): Promise<void> {
    stopPoll();
    setStarting(true);
    setStatus({ state: 'downloading', received: 0, total: FALLBACK_TOTAL });
    try {
      const r = await fetch('/api/game/download', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ proxy: proxy.trim() }),
      });
      if (disposedRef.current) return;
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const next = await r.json() as GameStatus;
      if (disposedRef.current) return;
      setStatus(next);
      if (typeof next.proxy === 'string') setProxy(next.proxy);
      if (next.state === 'downloading') timerRef.current = setTimeout(() => void poll(), 700);
    } catch (e) {
      if (disposedRef.current) return;
      setStatus({
        state: 'error',
        received: 0,
        total: FALLBACK_TOTAL,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      if (!disposedRef.current) setStarting(false);
    }
  }

  if (status?.state === 'ready') {
    return (
      <div className="office-frame-shell">
        <iframe
          className="office-game-frame"
          src="/game/index.html"
          title="HD2D Office"
          allow="autoplay"
        />
      </div>
    );
  }

  return (
    <OfficeLoader
      status={status ?? { state: 'absent', received: 0, total: FALLBACK_TOTAL }}
      title={tr('nav.office')}
      proxy={proxy}
      starting={starting}
      onProxyChange={setProxy}
      onStart={() => void startDownload()}
    />
  );
}

function OfficeLoader(props: {
  status: GameStatus;
  title: string;
  proxy: string;
  starting: boolean;
  onProxyChange(value: string): void;
  onStart(): void;
}) {
  const total = props.status.total || FALLBACK_TOTAL;
  const pct = useMemo(
    () => total ? Math.min(100, Math.round((props.status.received / total) * 100)) : 0,
    [props.status.received, total],
  );
  const downloading = props.status.state === 'downloading';
  const err = props.status.state === 'error';

  return (
    <div style={{ margin: 'auto', textAlign: 'center', maxWidth: 440, padding: 32, color: 'var(--fg,#e6e6e6)' }}>
      <h1 style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.2, margin: '0 0 8px' }}>{props.title}</h1>
      <div style={{ fontSize: 13, opacity: 0.7, lineHeight: 1.7, marginBottom: 20 }}>
        把每个会话变成办公室里的一个机器人，实时映射屏幕状态。
        <br />
        首次进入需下载约 {mb(total)} MB 游戏资源（仅一次，之后本地缓存）。
      </div>
      {err ? (
        <div style={{ color: '#e06c75', fontSize: 12, marginBottom: 14 }}>
          上次下载失败：{props.status.error ?? '未知错误'}
          <br />
          <span style={{ opacity: 0.7 }}>填代理后点重试</span>
        </div>
      ) : null}
      {downloading ? (
        <>
          <div style={{ background: 'var(--surface-muted)', borderRadius: 'var(--radius-lg)', height: 10, overflow: 'hidden', marginBottom: 10 }}>
            <div style={{ height: '100%', width: `${pct}%`, background: 'var(--accent)', transition: 'width .3s' }} />
          </div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>下载中... {mb(props.status.received)} / {mb(total)} MB（{pct}%）</div>
        </>
      ) : (
        <>
          <input
            id="hd2d-proxy"
            className="office-proxy-input"
            type="text"
            value={props.proxy}
            onChange={e => props.onProxyChange(e.currentTarget.value)}
            placeholder="HTTP 代理（可选，如 http://127.0.0.1:7890）"
          />
          <div style={{ fontSize: 11, opacity: 0.5, marginBottom: 14, textAlign: 'left' }}>
            连不上 GitHub 时填代理（仅用于下载本资源，会记住）。留空走直连/系统代理环境变量。
          </div>
          <button
            id="hd2d-load"
            type="button"
            className="page-primary-action office-load-button"
            disabled={props.starting}
            onClick={props.onStart}
          >
            {err ? '重试' : '加载办公室'}（约 {mb(total)} MB）
          </button>
        </>
      )}
    </div>
  );
}

export function renderOfficePage(root: HTMLElement): PageDisposer {
  const prev = {
    maxWidth: root.style.maxWidth,
    padding: root.style.padding,
    flex: root.style.flex,
    minHeight: root.style.minHeight,
    minWidth: root.style.minWidth,
    display: root.style.display,
    overflow: root.style.overflow,
  };
  root.style.maxWidth = 'none';
  root.style.padding = '0';
  root.style.flex = '1 1 auto';
  root.style.minHeight = '0';
  root.style.minWidth = '0';
  root.style.display = 'flex';
  root.style.overflow = 'hidden';

  const dispose = mountReactPage(root, <OfficePage />);
  return () => {
    dispose();
    root.style.maxWidth = prev.maxWidth;
    root.style.padding = prev.padding;
    root.style.flex = prev.flex;
    root.style.minHeight = prev.minHeight;
    root.style.minWidth = prev.minWidth;
    root.style.display = prev.display;
    root.style.overflow = prev.overflow;
  };
}
