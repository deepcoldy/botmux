/**
 * 「外观」面板：4 套配色 + 明暗模式 + 终端渲染风格，桌面是 `⋯` 菜单里的下拉浮层，
 * 移动端是同一块内容的底部 sheet。两处（以及终端标题栏那枚分段控件）共用
 * `workbenchAppearance` 一个状态源，任一处改动其余立刻跟着变。
 *
 * `⋯` 菜单同时是 owner「自取常驻链接」的入口（{@link WorkbenchStandingLinkPanel}）：
 * 同一个菜单、同一族浮层样式，移动端则挂在同一块底部 sheet 里，所以 owner 在手机
 * 浏览器里也能把工作台收进书签。这一项**只对本机完整管理身份渲染**（调用方传
 * `standingLink`，取自 Dashboard 既有的 `ui.authed`）——服务端那条端点对其它身份
 * 一律 401/404，画出来只会是个点了必然失败的按钮。
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
import { copyText } from './clipboard.js';
import { createWorkbenchApi, type WorkbenchApi } from './agent-workbench-api.js';
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

/** 调用方没传 api 时的兜底客户端。只建一次：每次渲染新建会让面板的 useEffect
 *  依赖每帧变化，进而每帧重取一次链接。 */
let fallbackWorkbenchApi: WorkbenchApi | null = null;
function defaultWorkbenchApi(): WorkbenchApi {
  return (fallbackWorkbenchApi ??= createWorkbenchApi());
}

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

// ─── 常驻链接 ────────────────────────────────────────────────────────────────

/** 复制反馈三态。`idle` 之外的两态只改按钮文案，不弹 toast——弹层本身就在眼前。 */
type CopyState = 'idle' | 'copied' | 'failed';

export interface WorkbenchStandingLinkPanelProps {
  api: WorkbenchApi;
  onClose(): void;
  /** 测试注入用的复制实现。生产默认是 web/clipboard.ts 的 `copyText`：先
   *  `navigator.clipboard.writeText`，被拒或不可用时降级到
   *  `document.execCommand('copy')`。 */
  copy?: (text: string) => Promise<boolean>;
}

/**
 * 「常驻链接」面板正文：显示完整链接（只读、聚焦即全选）、一键复制、以及一句
 * 说明它为什么安全可用（收藏进书签长期用；怀疑泄漏时 `botmux dashboard rotate`
 * 立刻作废）。
 *
 * 链接**只在这里现取**（点开才请求），拿不到就只显示一行「暂时取不到」——绝不
 * 显示半截链接，也不区分「无权」和「服务端还没有 token」：对前端来说都是没有
 * 这个入口。
 */
export function WorkbenchStandingLinkPanel(props: WorkbenchStandingLinkPanelProps): JSX.Element {
  const [link, setLink] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const fieldRef = useRef<HTMLTextAreaElement | null>(null);
  const { api } = props;

  useEffect(() => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let alive = true;
    void api.getStandingLink(controller?.signal).then(result => {
      if (!alive) return;
      setLink(result?.url ?? null);
      setLoading(false);
    });
    return () => { alive = false; controller?.abort(); };
  }, [api]);

  const copy = props.copy ?? copyText;
  const onCopy = async (): Promise<void> => {
    if (!link) return;
    setCopyState(await copy(link) ? 'copied' : 'failed');
  };

  return (
    <>
      <header className="wb-appearance-head">
        <strong>{t('workbench.standingLink.title')}</strong>
        <button type="button" aria-label={t('workbench.appearance.close')} onClick={props.onClose}>✕</button>
      </header>
      {loading ? (
        <p className="wb-standing-link-status" role="status">{t('workbench.standingLink.loading')}</p>
      ) : !link ? (
        <p className="wb-standing-link-status" role="status">{t('workbench.standingLink.error')}</p>
      ) : (
        <div className="wb-standing-link-body">
          {/* 折行的 textarea 而不是单行 input：链接有六七十个字符，单行框里只能看见
              开头一截，而这块弹层的用途就是「把完整链接摆出来」。只读 + 点击即全选，
              自动复制被浏览器策略拦掉时还能手动 Ctrl/⌘+C。 */}
          <textarea
            ref={fieldRef}
            className="wb-standing-link-url"
            readOnly
            rows={3}
            value={link}
            aria-label={t('workbench.standingLink.fieldLabel')}
            onFocus={event => event.currentTarget.select()}
            onClick={event => event.currentTarget.select()}
          />
          <button
            type="button"
            className="wb-standing-link-copy"
            onClick={() => { void onCopy(); }}
          >
            {copyState === 'copied'
              ? t('workbench.standingLink.copied')
              : copyState === 'failed'
                ? t('workbench.standingLink.copyFailed')
                : t('workbench.standingLink.copy')}
          </button>
        </div>
      )}
      <p className="wb-standing-link-note wb-appearance-note">{t('workbench.standingLink.note')}</p>
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

export interface WorkbenchAppearanceSheetProps {
  open: boolean;
  onClose(): void;
  /** 只有本机完整管理身份才渲染「常驻链接」入口（见文件头注释）。 */
  standingLink?: boolean;
  api?: WorkbenchApi;
}

/** 移动端：同一块内容的底部 sheet（列表页顶栏 `◐` 直达）。owner 的常驻链接也挂在
 *  这里——手机浏览器同样能把工作台收进书签，不必回到桌面端。 */
export function WorkbenchAppearanceSheet(props: WorkbenchAppearanceSheetProps): JSX.Element | null {
  const ref = useRef<HTMLDivElement | null>(null);
  const [standingOpen, setStandingOpen] = useState(false);
  const api = props.api ?? defaultWorkbenchApi();
  useDismiss(props.open, props.onClose, ref);
  useEffect(() => { if (!props.open) setStandingOpen(false); }, [props.open]);
  if (!props.open) return null;
  return (
    <div className="wb-appearance-backdrop">
      <div
        ref={ref}
        className="wb-appearance-sheet"
        role="dialog"
        aria-label={t('workbench.appearance.title')}
      >
        {standingOpen ? (
          <WorkbenchStandingLinkPanel api={api} onClose={props.onClose} />
        ) : (
          <>
            <header className="wb-appearance-head">
              <strong>{t('workbench.appearance.title')}</strong>
              <button type="button" aria-label={t('workbench.appearance.close')} onClick={props.onClose}>✕</button>
            </header>
            <WorkbenchAppearanceControls />
            {props.standingLink ? (
              <div className="wb-appearance-group">
                <button
                  type="button"
                  className="wb-standing-link-open"
                  onClick={() => setStandingOpen(true)}
                >{t('workbench.standingLink.title')}</button>
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

export interface WorkbenchAppearanceMenuProps {
  /** 只有本机完整管理身份才渲染「常驻链接」项（见文件头注释）。 */
  standingLink?: boolean;
  api?: WorkbenchApi;
}

/**
 * 桌面 / 会话坞头部的 `⋯` 菜单。第一项是「外观」，owner 还多一项「常驻链接」，
 * 两项点开的都是同一族下拉浮层（`.wb-appearance-pop`）。
 * 菜单和浮层都能用键盘走：Esc 关闭并把焦点还给 `⋯`，方向键在单选组里移动。
 */
export function WorkbenchAppearanceMenu(props: WorkbenchAppearanceMenuProps = {}): JSX.Element {
  const [open, setOpen] = useState<'menu' | 'panel' | 'standing' | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const api = props.api ?? defaultWorkbenchApi();
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
          {props.standingLink ? (
            <button
              type="button"
              role="menuitem"
              className="wb-more-item"
              onClick={() => setOpen('standing')}
            >{t('workbench.standingLink.title')}</button>
          ) : null}
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
      {open === 'standing' ? (
        <div
          className="wb-appearance-pop wb-standing-link-pop"
          role="dialog"
          aria-label={t('workbench.standingLink.title')}
        >
          <WorkbenchStandingLinkPanel api={api} onClose={close} />
        </div>
      ) : null}
    </div>
  );
}
