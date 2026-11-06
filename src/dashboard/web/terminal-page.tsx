// 「终端」页（管理 → 终端）：本机登录 shell + tmux / herdr attach 的多标签网页终端。
// 终端本体（xterm / WS / 流控）在 host-terminal-client.ts 的页面级单例里，这里只画标签栏、
// 目标选择器和空态/退出态。切走路由时单例保留终端，切回来直接挂回去。

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { mountReactPage, type PageDisposer } from './react-mount.js';
import { relTime, t, ui } from './ui.js';
import { confirm } from './confirm-modal.js';
import { toast } from './toast.js';
import { IS_TOUCH, workspace, type HostTerminalKey, type HostTerminalView } from './host-terminal-client.js';
import type {
  HostTerminalTarget,
  HostTerminalTargets,
} from '../host-terminal-protocol.js';

const XTERM_CSS_ID = 'botmux-xterm-css';

function ensureXtermCss(): void {
  if (document.getElementById(XTERM_CSS_ID)) return;
  const link = document.createElement('link');
  link.id = XTERM_CSS_ID;
  link.rel = 'stylesheet';
  link.href = '/assets/xterm.css';
  document.head.appendChild(link);
}

type PickerItem = {
  key: string;
  target: HostTerminalTarget;
  title: string;
  detail: string;
  section: 'shell' | 'tmux' | 'herdr' | 'managed';
  dim?: boolean;
};

function kindGlyph(kind: HostTerminalTarget['kind']): string {
  return kind === 'shell' ? '›_' : kind === 'tmux' ? '▦' : '◈';
}

function tabTitle(view: HostTerminalView): string {
  // shell 的 OSC 标题通常是「user@host: cwd」，比单个「zsh」有用得多；tmux/herdr 的标题
  // 是复用器自己设的，固定用 session 名更好认。
  if (view.target.kind === 'shell' && view.title) return view.title;
  return view.label;
}

function buildPickerItems(targets: HostTerminalTargets | null): PickerItem[] {
  if (!targets) return [];
  const items: PickerItem[] = [{
    key: 'shell',
    target: { kind: 'shell' },
    title: t('terminal.picker.shell', { shell: targets.shell.name }),
    detail: targets.shell.path,
    section: 'shell',
  }];
  for (const s of targets.tmux.sessions) {
    const detail = [
      t('terminal.picker.windows', { count: s.windows }),
      s.command,
      s.attached > 0 ? t('terminal.picker.attached', { count: s.attached }) : null,
      s.activity ? relTime(s.activity) : null,
    ].filter(Boolean).join(' · ');
    items.push({
      key: `tmux:${s.name}`,
      target: { kind: 'tmux', session: s.name },
      title: s.managed && s.title ? `${s.title}` : s.name,
      detail: s.managed && s.title ? `${s.name} · ${detail}` : detail,
      section: s.managed ? 'managed' : 'tmux',
    });
  }
  for (const s of targets.herdr.sessions) {
    items.push({
      key: `herdr:${s.name}`,
      target: { kind: 'herdr', session: s.name },
      title: s.name,
      detail: [
        s.running ? t('terminal.picker.running') : t('terminal.picker.stopped'),
        s.isDefault ? t('terminal.picker.default') : null,
      ].filter(Boolean).join(' · '),
      section: 'herdr',
      dim: !s.running,
    });
  }
  return items;
}

const SECTION_ORDER: PickerItem['section'][] = ['shell', 'tmux', 'herdr', 'managed'];

function TargetPicker({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [targets, setTargets] = useState<HostTerminalTargets | null>(null);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const [showManaged, setShowManaged] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 触屏上不自动聚焦搜索框：软键盘一弹就挡掉半个列表，多数时候直接点选就够了。
    if (!IS_TOUCH) inputRef.current?.focus();
    let alive = true;
    void workspace.syncFromServer();
    workspace.listTargets().then(
      next => { if (alive) setTargets(next); },
      err => { if (alive) setError(err instanceof Error ? err.message : String(err)); },
    );
    return () => { alive = false; };
  }, []);

  const q = query.trim().toLowerCase();
  const all = useMemo(() => buildPickerItems(targets), [targets]);
  // 按分组的显示顺序排好：高亮 / 悬停用的是显示位置，Enter 取的是 visible[cursor]，两边必须同序。
  const visible = useMemo(() => {
    const matched = all.filter(item => {
      if (q) return `${item.title} ${item.detail} ${item.key}`.toLowerCase().includes(q);
      return item.section !== 'managed' || showManaged;
    });
    return SECTION_ORDER.flatMap(section => matched.filter(i => i.section === section));
  }, [all, q, showManaged]);
  const managedCount = all.filter(i => i.section === 'managed').length;

  useEffect(() => { setCursor(0); }, [q, showManaged]);

  const choose = useCallback((item: PickerItem) => {
    onClose();
    void workspace.open(item.target);
  }, [onClose]);

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.key === 'Escape') { ev.preventDefault(); onClose(); return; }
    if (ev.key === 'ArrowDown') { ev.preventDefault(); setCursor(c => Math.min(c + 1, visible.length - 1)); return; }
    if (ev.key === 'ArrowUp') { ev.preventDefault(); setCursor(c => Math.max(c - 1, 0)); return; }
    if (ev.key === 'Enter' && visible[cursor]) { ev.preventDefault(); choose(visible[cursor]); }
  };

  const sectionLabel = (section: PickerItem['section']): string => (
    section === 'shell' ? t('terminal.section.shell')
      : section === 'tmux' ? 'tmux'
        : section === 'herdr' ? 'herdr'
          : t('terminal.section.managed')
  );

  let index = -1;
  return (
    <>
      <div className="terminal-picker-backdrop" onMouseDown={onClose} />
      <div className="terminal-picker" role="dialog" aria-label={t('terminal.connect')} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="terminal-picker-search"
          placeholder={t('terminal.picker.search')}
          value={query}
          onChange={e => setQuery(e.target.value)}
        />
        <div className="terminal-picker-list">
          {!targets && !error ? <div className="terminal-picker-empty">{t('terminal.picker.loading')}</div> : null}
          {error ? <div className="terminal-picker-empty is-error">{t('terminal.loadFailed')}: {error}</div> : null}
          {targets ? SECTION_ORDER.map(section => {
            const items = visible.filter(i => i.section === section);
            const unavailable = (section === 'tmux' && !targets.tmux.available) || (section === 'herdr' && !targets.herdr.available);
            const listError = section === 'tmux' ? targets.tmux.error : section === 'herdr' ? targets.herdr.error : undefined;
            if (section === 'managed' && managedCount === 0) return null;
            if (q && items.length === 0) return null;
            return (
              <div className="terminal-picker-section" key={section}>
                <div className="terminal-picker-section-title">
                  <span>{sectionLabel(section)}</span>
                  {section === 'managed' && !q ? (
                    <button type="button" className="btn-link" onClick={() => setShowManaged(v => !v)}>
                      {showManaged ? t('terminal.picker.collapse') : t('terminal.picker.expand', { count: managedCount })}
                    </button>
                  ) : null}
                </div>
                {unavailable ? <div className="terminal-picker-empty">{t('terminal.picker.notInstalled')}</div> : null}
                {!unavailable && listError ? <div className="terminal-picker-empty is-error">{listError}</div> : null}
                {!unavailable && !listError && items.length === 0 && section !== 'managed'
                  ? <div className="terminal-picker-empty">{t('terminal.picker.none')}</div> : null}
                {items.map(item => {
                  index += 1;
                  const i = index;
                  return (
                    <button
                      type="button"
                      key={item.key}
                      className={`terminal-picker-item${i === cursor ? ' is-cursor' : ''}${item.dim ? ' is-dim' : ''}`}
                      onMouseEnter={() => setCursor(i)}
                      onClick={() => choose(item)}
                    >
                      <span className="terminal-picker-glyph" aria-hidden="true">{kindGlyph(item.target.kind)}</span>
                      <span className="terminal-picker-text">
                        <span className="terminal-picker-title">{item.title}</span>
                        <span className="terminal-picker-detail">{item.detail}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            );
          }) : null}
        </div>
      </div>
    </>
  );
}

/** 触屏快捷键行：软键盘上没有、终端里又离不开的键。 */
const TOUCH_KEYS: Array<{ key: HostTerminalKey | 'ctrl'; label: string }> = [
  { key: 'esc', label: 'Esc' },
  { key: 'tab', label: 'Tab' },
  { key: 'ctrl', label: 'Ctrl' },
  { key: 'ctrlC', label: '⌃C' },
  { key: 'up', label: '↑' },
  { key: 'down', label: '↓' },
  { key: 'left', label: '←' },
  { key: 'right', label: '→' },
  { key: 'shiftTab', label: '⇧Tab' },
  { key: 'home', label: 'Home' },
  { key: 'end', label: 'End' },
  { key: 'pageUp', label: 'PgUp' },
  { key: 'pageDown', label: 'PgDn' },
];

function TouchKeys({ view }: { view: HostTerminalView }): React.JSX.Element {
  return (
    <div className="terminal-keys" role="toolbar" aria-label={t('terminal.keys')}>
      {TOUCH_KEYS.map(k => (
        <button
          type="button"
          key={k.key}
          className={k.key === 'ctrl' && view.ctrlArmed ? 'is-armed' : undefined}
          // 不抢焦点：软键盘保持弹出，按完继续打字。
          onPointerDown={e => e.preventDefault()}
          onClick={() => (k.key === 'ctrl' ? view.toggleCtrl() : view.sendKey(k.key))}
        >
          {k.label}
        </button>
      ))}
      <button
        type="button"
        className="terminal-keys-keyboard"
        aria-label={t('terminal.showKeyboard')}
        onPointerDown={e => e.preventDefault()}
        onClick={() => view.focus()}
      >
        ⌨
      </button>
    </div>
  );
}

/**
 * 沉浸布局（触屏默认 / 浏览器没有全屏 API 时）：终端盖满可视区。高度跟 visualViewport 走——
 * iOS 弹出软键盘只缩可视区不缩布局视口，不跟的话光标行和快捷键行都会被键盘挡住。
 */
function useImmersiveViewport(active: boolean, page: React.RefObject<HTMLDivElement | null>): void {
  useEffect(() => {
    const el = page.current;
    if (!active || !el) return;
    const root = document.documentElement;
    root.classList.add('terminal-immersive-lock');
    const vv = window.visualViewport;
    const apply = () => {
      el.style.setProperty('--vv-top', `${vv ? vv.offsetTop : 0}px`);
      el.style.setProperty('--vv-height', `${vv ? vv.height : window.innerHeight}px`);
      // iOS 聚焦输入框时会把页面整体推走；沉浸层自己定位，把文档滚回原点。
      if (window.scrollX || (!vv && window.scrollY)) window.scrollTo(0, 0);
    };
    apply();
    vv?.addEventListener('resize', apply);
    vv?.addEventListener('scroll', apply);
    window.addEventListener('resize', apply);
    return () => {
      root.classList.remove('terminal-immersive-lock');
      vv?.removeEventListener('resize', apply);
      vv?.removeEventListener('scroll', apply);
      window.removeEventListener('resize', apply);
      el.style.removeProperty('--vv-top');
      el.style.removeProperty('--vv-height');
    };
  }, [active, page]);
}

function statusLabel(view: HostTerminalView): string | null {
  switch (view.status) {
    case 'starting':
    case 'connecting': return t('terminal.status.connecting');
    case 'reconnecting': return t('terminal.status.reconnecting');
    case 'exited': return t('terminal.status.exited');
    case 'failed': return t('terminal.status.failed');
    default: return null;
  }
}

function TerminalPage(): React.JSX.Element {
  const [, rerender] = useReducer((x: number) => x + 1, 0);
  const pageRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // 触屏默认沉浸：手机上 dashboard 的顶栏 + 导航条会吃掉三分之一屏。
  const [immersive, setImmersive] = useState(IS_TOUCH);
  useImmersiveViewport(immersive, pageRef);

  useEffect(() => workspace.subscribe(rerender), []);
  useEffect(() => {
    ensureXtermCss();
    const host = hostRef.current;
    if (!host) return;
    workspace.mount(host);
    return () => workspace.unmount();
  }, []);
  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === pageRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const closePicker = useCallback(() => {
    setPickerOpen(false);
    workspace.activeView?.term.focus();
  }, []);

  const closeView = useCallback(async (view: HostTerminalView) => {
    // 关 shell = 结束里面的进程；tmux/herdr 只是断开 attach 客户端，会话本身不受影响。
    if (view.target.kind === 'shell' && (view.status === 'open' || view.status === 'reconnecting')) {
      const ok = await confirm({
        title: t('terminal.closeShellTitle'),
        message: t('terminal.closeShellMessage'),
        danger: true,
        confirmLabel: t('terminal.close'),
      });
      if (!ok) return;
    }
    await workspace.close(view);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    const page = pageRef.current;
    if (!page) return;
    // 触屏、或浏览器没有元素全屏（iPhone Safari / 飞书内置浏览器）：用沉浸布局代替。
    if (IS_TOUCH || !document.fullscreenEnabled) {
      setImmersive(v => !v);
      return;
    }
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await page.requestFullscreen();
        // 全屏下按住 Esc 才退出，单按 Esc 交给终端（vim 等离不开它）。
        const keyboard = (navigator as Navigator & { keyboard?: { lock?: (keys?: string[]) => Promise<void> } }).keyboard;
        await keyboard?.lock?.(['Escape']).catch(() => undefined);
      }
    } catch (err) {
      toast(String(err), { kind: 'error' });
    }
    workspace.activeView?.term.focus();
  }, []);

  const views = workspace.views;
  const active = workspace.activeView;

  if (!ui.hostTerminal) {
    return (
      <div className="page terminal-page">
        <div className="terminal-owner-only">
          <h2>{t('nav.terminal')}</h2>
          <p>{t('terminal.ownerOnly')}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`page terminal-page${fullscreen ? ' is-fullscreen' : ''}${immersive ? ' is-immersive' : ''}${IS_TOUCH ? ' is-touch' : ''}`}
      ref={pageRef}
    >
      <div className="terminal-bar">
        <div className="terminal-tabs" role="tablist">
          {views.map(view => {
            const status = statusLabel(view);
            return (
              <div
                key={view.uid}
                role="tab"
                aria-selected={view === active}
                className={`terminal-tab is-${view.status}${view === active ? ' is-active' : ''}`}
                title={[tabTitle(view), status].filter(Boolean).join(' · ')}
                onMouseDown={ev => { if (ev.button === 1) { ev.preventDefault(); void closeView(view); } }}
                onClick={() => workspace.activate(view.uid)}
              >
                <span className="terminal-tab-glyph" aria-hidden="true">{kindGlyph(view.target.kind)}</span>
                <span className="terminal-tab-label">{tabTitle(view)}</span>
                {status ? <span className="terminal-tab-dot" aria-label={status} /> : null}
                <button
                  type="button"
                  className="terminal-tab-close"
                  aria-label={t('terminal.close')}
                  onClick={ev => { ev.stopPropagation(); void closeView(view); }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <button
            type="button"
            className="terminal-tab-add"
            title={t('terminal.newShell')}
            aria-label={t('terminal.newShell')}
            onClick={() => void workspace.open({ kind: 'shell' })}
          >
            +
          </button>
          <button type="button" className="terminal-connect-btn" onClick={() => setPickerOpen(v => !v)}>
            {t('terminal.connect')}
            <span aria-hidden="true"> ▾</span>
          </button>
        </div>
        <div className="terminal-bar-tools">
          {active?.isFollowing ? (
            <span className="terminal-follow-badge" title={t('terminal.followingHint')}>{t('terminal.following')}</span>
          ) : null}
          {active ? (
            <span className="terminal-renderer-badge" title={t('terminal.rendererHint')}>
              {active.renderer === 'webgl' ? 'GPU' : 'DOM'}
            </span>
          ) : null}
          <div className="terminal-font-size" aria-label={t('terminal.fontSize')}>
            <button type="button" onClick={() => workspace.adjustFontSize(-1)} aria-label="A-">A−</button>
            <span>{workspace.fontSize}</span>
            <button type="button" onClick={() => workspace.adjustFontSize(1)} aria-label="A+">A+</button>
          </div>
          <button type="button" className="terminal-fullscreen-btn" onClick={() => void toggleFullscreen()}>
            {fullscreen || immersive ? t('terminal.exitFullscreen') : t('terminal.fullscreen')}
          </button>
        </div>
        {pickerOpen ? <TargetPicker onClose={closePicker} /> : null}
      </div>
      <div className="terminal-stage">
        <div className="terminal-host" ref={hostRef} />
        {views.length === 0 ? (
          <div className="terminal-empty">
            <h2>{t('terminal.emptyTitle')}</h2>
            <p>{t('terminal.emptyHint')}</p>
            <div className="terminal-empty-actions">
              <button type="button" className="page-primary-action" onClick={() => void workspace.open({ kind: 'shell' })}>
                {t('terminal.newShell')}
              </button>
              <button type="button" onClick={() => setPickerOpen(true)}>{t('terminal.connect')}</button>
            </div>
          </div>
        ) : null}
        {active && (active.status === 'exited' || active.status === 'failed') ? (
          <div className="terminal-exit-overlay">
            <span>
              {active.status === 'failed'
                ? `${t('terminal.status.failed')}: ${active.error ?? ''}`
                : active.exitCode !== null
                  ? t('terminal.exitedWithCode', { code: active.exitCode })
                  : t('terminal.status.exited')}
            </span>
            <button type="button" className="page-primary-action" onClick={() => void workspace.reopen(active)}>
              {t('terminal.reopen')}
            </button>
            <button type="button" onClick={() => void workspace.close(active)}>{t('terminal.close')}</button>
          </div>
        ) : null}
      </div>
      {IS_TOUCH && active && active.status === 'open' ? <TouchKeys view={active} /> : null}
    </div>
  );
}

export function renderTerminalPage(root: HTMLElement): PageDisposer {
  return mountReactPage(root, <TerminalPage />);
}
