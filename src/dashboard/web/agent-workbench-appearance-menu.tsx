/**
 * 「外观」面板：4 套配色 + 明暗模式 + 终端渲染风格，桌面是 `⋯` 菜单里的下拉浮层，
 * 移动端是同一块内容的底部 sheet。两处（以及终端标题栏那枚分段控件）共用
 * `workbenchAppearance` 一个状态源，任一处改动其余立刻跟着变。
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { t, ui } from './ui.js';
import type { ThemeMode } from './preferences.js';
import {
  WORKBENCH_SKIN_IDS,
  WORKBENCH_SKIN_PREVIEWS,
  selectWorkbenchMode,
  selectWorkbenchSkin,
  selectWorkbenchTermStyle,
  workbenchAppearance,
  type WorkbenchAppearanceSnapshot,
  type WorkbenchSkinId,
  type WorkbenchTermStyle,
} from './agent-workbench-appearance.js';

const SKIN_LABEL_KEY: Record<WorkbenchSkinId, string> = {
  ink: 'workbench.appearance.skin.ink',
  'slate-blue': 'workbench.appearance.skin.slateBlue',
  'warm-graphite': 'workbench.appearance.skin.warmGraphite',
  'light-frost': 'workbench.appearance.skin.lightFrost',
};

const MODE_OPTIONS: ReadonlyArray<{ value: ThemeMode; labelKey: string }> = [
  { value: 'system', labelKey: 'workbench.appearance.mode.system' },
  { value: 'light', labelKey: 'workbench.appearance.mode.light' },
  { value: 'dark', labelKey: 'workbench.appearance.mode.dark' },
];

const TERM_OPTIONS: ReadonlyArray<{ value: WorkbenchTermStyle; labelKey: string }> = [
  { value: 'reader', labelKey: 'workbench.appearance.term.reader' },
  { value: 'classic', labelKey: 'workbench.appearance.term.classic' },
];

function subscribe(listener: () => void): () => void {
  return workbenchAppearance.subscribe(listener);
}

function snapshot(): WorkbenchAppearanceSnapshot {
  return workbenchAppearance.getSnapshot();
}

/** 读当前外观。store 缓存快照对象，未变化时引用不变，不会引起额外重渲染。 */
export function useWorkbenchAppearance(): WorkbenchAppearanceSnapshot {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * 工作台表面（完整工作台 / 会话坞）挂载期间把外观落到文档根上，离开时原样还回去 ——
 * 这 4 套配色是工作台的局部调色板，不该在 Dashboard 其它页面继续生效。
 */
export function useWorkbenchAppearanceRoot(): WorkbenchAppearanceSnapshot {
  useEffect(() => workbenchAppearance.mount(), []);
  // 全站明暗仲裁（ui.ts）改完 data-theme 就发一次事件，工作台在场时把自己的解析
  // 结果盖回去。两套机制各自独立、互不订阅，只在这一个落点上分先后。
  useEffect(() => ui.on(() => workbenchAppearance.reapply()), []);
  return useWorkbenchAppearance();
}

export function setWorkbenchSkin(skin: WorkbenchSkinId): void {
  workbenchAppearance.set(selectWorkbenchSkin(workbenchAppearance.getSnapshot().appearance, skin));
}

export function setWorkbenchMode(mode: ThemeMode): void {
  workbenchAppearance.set(selectWorkbenchMode(workbenchAppearance.getSnapshot().appearance, mode));
}

export function setWorkbenchTermStyle(termStyle: WorkbenchTermStyle): void {
  workbenchAppearance.set(selectWorkbenchTermStyle(workbenchAppearance.getSnapshot().appearance, termStyle));
}

/** 单选组里的左右方向键：焦点在同组的按钮之间走一圈，选项跟着改。 */
function moveRadioFocus(event: ReactKeyboardEvent<HTMLElement>, step: -1 | 1): void {
  const group = event.currentTarget;
  const items = [...group.querySelectorAll<HTMLButtonElement>('button[role="radio"]')];
  if (items.length === 0) return;
  const active = items.indexOf(event.target as HTMLButtonElement);
  const next = items[((active < 0 ? 0 : active) + step + items.length) % items.length];
  event.preventDefault();
  next.focus();
  next.click();
}

function radioGroupKeyDown(event: ReactKeyboardEvent<HTMLElement>): void {
  if (event.key === 'ArrowRight' || event.key === 'ArrowDown') moveRadioFocus(event, 1);
  else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') moveRadioFocus(event, -1);
}

/** 「阅读｜经典」分段控件。终端标题栏右侧和外观面板里用的是同一个组件、同一状态源。 */
export function WorkbenchTermStyleSegment(props: { termStyle: WorkbenchTermStyle }): JSX.Element {
  return (
    <span
      className="wb-seg wb-term-style-seg"
      role="radiogroup"
      aria-label={t('workbench.appearance.termStyleLabel')}
      onKeyDown={radioGroupKeyDown}
    >
      {TERM_OPTIONS.map(option => (
        <button
          key={option.value}
          type="button"
          role="radio"
          className={`wb-seg-item${props.termStyle === option.value ? ' is-on' : ''}`}
          aria-checked={props.termStyle === option.value}
          tabIndex={props.termStyle === option.value ? 0 : -1}
          onClick={() => setWorkbenchTermStyle(option.value)}
        >{t(option.labelKey)}</button>
      ))}
    </span>
  );
}

/** 面板正文。桌面浮层和移动 sheet 共用，只有外层容器不同。 */
export function WorkbenchAppearanceControls(): JSX.Element {
  const { appearance, skin } = useWorkbenchAppearance();
  return (
    <>
      <div className="wb-appearance-group">
        <span className="wb-appearance-group-label" id="wb-appearance-theme-label">
          {t('workbench.appearance.themeGroup')}
        </span>
        <span
          className="wb-skin-swatches"
          role="radiogroup"
          aria-labelledby="wb-appearance-theme-label"
          onKeyDown={radioGroupKeyDown}
        >
          {WORKBENCH_SKIN_IDS.map(id => {
            const preview = WORKBENCH_SKIN_PREVIEWS[id];
            const active = skin === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                className={`wb-skin-swatch${active ? ' is-active' : ''}`}
                aria-checked={active}
                tabIndex={active ? 0 : -1}
                title={t(SKIN_LABEL_KEY[id])}
                onClick={() => setWorkbenchSkin(id)}
              >
                <span
                  className="wb-skin-swatch-chip"
                  aria-hidden="true"
                  style={{
                    '--sw-bg': preview.bg,
                    '--sw-raise': preview.raise,
                    '--sw-accent': preview.accent,
                  } as CSSProperties}
                />
                <span className="wb-skin-swatch-name">{t(SKIN_LABEL_KEY[id])}</span>
              </button>
            );
          })}
        </span>
        <span
          className="wb-seg wb-appearance-mode-seg"
          role="radiogroup"
          aria-label={t('workbench.appearance.modeLabel')}
          onKeyDown={radioGroupKeyDown}
        >
          {MODE_OPTIONS.map(option => (
            <button
              key={option.value}
              type="button"
              role="radio"
              className={`wb-seg-item${appearance.mode === option.value ? ' is-on' : ''}`}
              aria-checked={appearance.mode === option.value}
              tabIndex={appearance.mode === option.value ? 0 : -1}
              onClick={() => setWorkbenchMode(option.value)}
            >{t(option.labelKey)}</button>
          ))}
        </span>
      </div>
      <div className="wb-appearance-group">
        <span className="wb-appearance-group-label">{t('workbench.appearance.termGroup')}</span>
        <WorkbenchTermStyleSegment termStyle={appearance.termStyle} />
        <p className="wb-appearance-note">{t('workbench.appearance.termNote')}</p>
      </div>
    </>
  );
}

/** Esc 关闭 + 焦点离开/点击面板外关闭。浮层和 sheet 用同一套关闭语义。 */
function useDismiss(open: boolean, onClose: () => void, ref: { current: HTMLElement | null }): void {
  useEffect(() => {
    if (!open || typeof document === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (target instanceof Node && ref.current && !ref.current.contains(target)) onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [onClose, open, ref]);
}

/** 移动端：同一块内容的底部 sheet（列表页顶栏 `◐` 直达）。 */
export function WorkbenchAppearanceSheet(props: { open: boolean; onClose(): void }): JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null);
  useDismiss(props.open, props.onClose, ref);
  if (!props.open) return null;
  return (
    <div className="wb-appearance-backdrop">
      <div
        ref={ref}
        className="wb-appearance-sheet"
        role="dialog"
        aria-label={t('workbench.appearance.title')}
      >
        <header className="wb-appearance-head">
          <strong>{t('workbench.appearance.title')}</strong>
          <button type="button" aria-label={t('workbench.appearance.close')} onClick={props.onClose}>✕</button>
        </header>
        <WorkbenchAppearanceControls />
      </div>
    </div>
  );
}

/**
 * 桌面 / 会话坞头部的 `⋯` 菜单。菜单第一项是「外观」，点开同一块内容的下拉浮层。
 * 菜单和浮层都能用键盘走：Esc 关闭并把焦点还给 `⋯`，方向键在单选组里移动。
 */
export function WorkbenchAppearanceMenu(): JSX.Element {
  const [open, setOpen] = useState<'menu' | 'panel' | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const close = useCallback(() => {
    setOpen(current => {
      if (current !== null) buttonRef.current?.focus();
      return null;
    });
  }, []);
  useDismiss(open !== null, close, rootRef);
  return (
    <div className="wb-more" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className="wb-more-btn"
        aria-haspopup="menu"
        aria-expanded={open !== null}
        aria-label={t('workbench.appearance.more')}
        title={t('workbench.appearance.more')}
        onClick={() => setOpen(current => (current === null ? 'menu' : null))}
      >⋯</button>
      {open === 'menu' ? (
        <div className="wb-more-menu" role="menu">
          <button
            type="button"
            role="menuitem"
            className="wb-more-item"
            autoFocus
            onClick={() => setOpen('panel')}
          >{t('workbench.appearance.title')}</button>
        </div>
      ) : null}
      {open === 'panel' ? (
        <div className="wb-appearance-pop" role="dialog" aria-label={t('workbench.appearance.title')}>
          <header className="wb-appearance-head">
            <strong>{t('workbench.appearance.title')}</strong>
            <button type="button" aria-label={t('workbench.appearance.close')} onClick={close}>✕</button>
          </header>
          <WorkbenchAppearanceControls />
        </div>
      ) : null}
    </div>
  );
}
