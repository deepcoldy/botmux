import type React from 'react';
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type CSSProperties,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { dropdownRootClassName, DropdownTriggerValue, type DropdownMenuProps } from './dropdown-shared.js';
import { floatingPortalHost } from './floating-host.js';

export { dropdownLabel, type DropdownOption } from './dropdown-shared.js';
export { floatingPortalHost };

export function Html(props: { html: string; as?: 'span' | 'div' }): React.JSX.Element {
  const Tag = props.as ?? 'span';
  return <Tag style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: props.html }} />;
}

export function LoadingState(props: {
  label: ReactNode;
  className?: string;
  compact?: boolean;
}): React.JSX.Element {
  const className = [
    'page-loading',
    props.compact ? 'page-loading-compact' : '',
    props.className,
  ].filter(Boolean).join(' ');

  return (
    <div className={className} role="status" aria-live="polite">
      <i className="page-loading-spin" aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  );
}

export function SectionHeader(props: {
  title: ReactNode;
  count?: ReactNode;
  hint?: ReactNode;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="sect-head overview-panel-head">
      <h2>{props.title}</h2>
      {props.count ? <span className="sect-head-count">{props.count}</span> : null}
      {props.hint ? <span className="sect-head-hint">{props.hint}</span> : null}
      {props.children}
    </div>
  );
}

export function HeaderAction(props: {
  href: string;
  children: ReactNode;
}): React.JSX.Element {
  return <a className="sect-head-action" href={props.href}>{props.children}</a>;
}

export function HeaderControls(props: { children: ReactNode }): React.JSX.Element {
  return <div className="sect-head-controls">{props.children}</div>;
}

type ActionButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
};

function ActionGlyph(props: { kind: 'plus' | 'refresh' }): React.JSX.Element {
  if (props.kind === 'plus') {
    return (
      <svg className="ui-action-icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 3.25v9.5M3.25 8h9.5" />
      </svg>
    );
  }
  return (
    <svg className="ui-action-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M13.1 6.55A5.35 5.35 0 1 0 13 10.1" />
      <path d="M13.15 2.95v3.7H9.45" />
    </svg>
  );
}

export function CreateActionButton(props: ActionButtonProps): React.JSX.Element {
  const { children, className, type = 'button', ...buttonProps } = props;
  return (
    <button {...buttonProps} type={type} className={['ui-create-action', className].filter(Boolean).join(' ')}>
      <ActionGlyph kind="plus" />
      <span className="ui-create-action-label">{children}</span>
    </button>
  );
}

export function RefreshIconButton(props: Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> & {
  label: string;
  busy?: boolean;
}): React.JSX.Element {
  const { label, busy = false, className, type = 'button', ...buttonProps } = props;
  return (
    <button
      {...buttonProps}
      type={type}
      className={['ui-refresh-button', busy ? 'is-loading' : '', className].filter(Boolean).join(' ')}
      title={label}
      aria-label={label}
      aria-busy={busy || undefined}
    >
      <ActionGlyph kind="refresh" />
    </button>
  );
}

export function InfoTip(props: {
  children: ReactNode;
  label?: string;
  className?: string;
  trigger?: ReactNode;
  preventClick?: boolean;
  focusable?: boolean;
}): React.JSX.Element {
  const tipRef = useRef<HTMLSpanElement | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null);

  const updatePosition = useCallback(() => {
    const tip = tipRef.current;
    if (!tip || typeof window === 'undefined') return;
    const rect = tip.getBoundingClientRect();
    const maxWidth = Math.min(360, Math.max(160, window.innerWidth - 48));
    const minLeft = 24 + maxWidth / 2;
    const maxLeft = window.innerWidth - 24 - maxWidth / 2;
    const centered = rect.left + rect.width / 2;
    const left = Math.min(Math.max(centered, minLeft), Math.max(minLeft, maxLeft));
    const useBottom = rect.top < 80;
    setPosition({
      left,
      top: useBottom ? rect.bottom + 8 : rect.top - 8,
      placement: useBottom ? 'bottom' : 'top',
    });
  }, []);

  const show = useCallback(() => {
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null; }
    updatePosition();
    setOpen(true);
  }, [updatePosition]);

  // Delay the hide so the pointer can travel from the trigger to the
  // body-portaled popover without it vanishing — required to select/copy the
  // popover text. Hovering the popover itself cancels the pending hide (show).
  const hide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setOpen(false), 160);
  }, []);

  useEffect(() => () => { if (hideTimer.current) clearTimeout(hideTimer.current); }, []);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const popover = open && position && typeof document !== 'undefined'
    ? createPortal(
      <span
        className={`ui-info-pop ui-info-pop-floating ui-info-pop-${position.placement}`}
        role="tooltip"
        style={{ left: position.left, top: position.top }}
        onMouseEnter={show}
        onMouseLeave={hide}
      >
        {props.children}
      </span>,
      floatingPortalHost(tipRef.current, document.body),
    )
    : null;

  return (
    <span
      ref={tipRef}
      className={['ui-info-tip', props.className].filter(Boolean).join(' ')}
      tabIndex={props.focusable === false ? undefined : 0}
      aria-label={props.label}
      onClick={props.preventClick === false ? undefined : event => event.preventDefault()}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {props.trigger ?? <span className="ui-info-mark" aria-hidden="true">?</span>}
      {popover}
    </span>
  );
}

export function OverflowText(props: {
  text: string;
  children?: ReactNode;
  className?: string;
  textClassName?: string;
  popoverClassName?: string;
  showPopover?: boolean;
  durationMs?: number;
}): React.JSX.Element {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const [position, setPosition] = useState<{ left: number; top: number; placement: 'top' | 'bottom' } | null>(null);

  const measureOverflow = useCallback((): boolean => {
    const anchor = anchorRef.current;
    if (!anchor) return false;
    const text = anchor.querySelector<HTMLElement>('.ui-overflow-scroll') ?? anchor;
    const nextOverflowing = text.scrollWidth > anchor.clientWidth + 1;
    setOverflowing(nextOverflowing);
    if (!nextOverflowing) setOpen(false);
    return nextOverflowing;
  }, []);

  const updatePosition = useCallback(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return;
    const rect = anchor.getBoundingClientRect();
    const maxWidth = Math.min(460, Math.max(220, window.innerWidth - 48));
    const minLeft = 24 + maxWidth / 2;
    const maxLeft = window.innerWidth - 24 - maxWidth / 2;
    const centered = rect.left + rect.width / 2;
    const left = Math.min(Math.max(centered, minLeft), Math.max(minLeft, maxLeft));
    const useBottom = rect.top < 84;
    setPosition({
      left,
      top: useBottom ? rect.bottom + 8 : rect.top - 8,
      placement: useBottom ? 'bottom' : 'top',
    });
  }, []);

  const show = useCallback(() => {
    if (!props.text.trim() || !measureOverflow()) return;
    if (props.showPopover === false) {
      setOpen(false);
      return;
    }
    updatePosition();
    setOpen(true);
  }, [measureOverflow, props.showPopover, props.text, updatePosition]);

  const hide = useCallback(() => setOpen(false), []);

  useEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor || typeof window === 'undefined') return undefined;
    const raf = window.requestAnimationFrame(measureOverflow);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => measureOverflow())
      : null;
    resizeObserver?.observe(anchor);
    window.addEventListener('resize', measureOverflow);
    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', measureOverflow);
    };
  }, [measureOverflow, props.text]);

  useEffect(() => {
    if (!open) return undefined;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [open, updatePosition]);

  const popover = props.showPopover !== false && open && position && typeof document !== 'undefined'
    ? createPortal(
      <span
        className={[
          'ui-info-pop',
          'ui-info-pop-floating',
          `ui-info-pop-${position.placement}`,
          'ui-overflow-popover',
          props.popoverClassName,
        ].filter(Boolean).join(' ')}
        role="tooltip"
        style={{ left: position.left, top: position.top }}
      >
        {props.text}
      </span>,
      floatingPortalHost(anchorRef.current, document.body),
    )
    : null;

  return (
    <span
      ref={anchorRef}
      className={['ui-overflow-text', overflowing ? 'is-overflowing' : '', props.className].filter(Boolean).join(' ')}
      style={props.durationMs ? { '--ui-overflow-duration': `${props.durationMs}ms` } as CSSProperties : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <span className={['ui-overflow-scroll', props.textClassName].filter(Boolean).join(' ')}>
        {props.children ?? props.text}
      </span>
      {popover}
    </span>
  );
}

export function FieldTitle(props: {
  children: ReactNode;
  help?: ReactNode;
  helpLabel?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={['ui-field-title', props.className].filter(Boolean).join(' ')}>
      <span className="ui-field-title-text">{props.children}</span>
      {props.help ? <InfoTip label={props.helpLabel}>{props.help}</InfoTip> : null}
    </span>
  );
}

/**
 * 开关行：`<label.toggle-row>` = 复选框 + 滑块 + 「标题（带 ? 提示）+ 可选说明」。
 * bot-defaults 页与 settings 页共用；两页的差别只在标题用哪一套 FieldTitle
 * （bot-defaults 的 `bd-*` 页面作用域样式 vs 本文件的 `ui-*`），由 `TitleComponent`
 * 注入，默认是本文件的 {@link FieldTitle}。
 */
export function ToggleRow(props: {
  checked: boolean;
  disabled?: boolean;
  title: ReactNode;
  help?: ReactNode;
  description?: ReactNode;
  className?: string;
  /** 透传到 `<input data-action>`，供测试/事件委托钉点。 */
  dataAction?: string;
  /** 追加到默认 FieldTitle 的 class；使用自定义 `TitleComponent` 时忽略。 */
  titleClassName?: string;
  TitleComponent?: (p: { children: ReactNode; help?: ReactNode }) => React.JSX.Element;
  onChange(checked: boolean): void;
}): React.JSX.Element {
  return (
    <label className={props.className ? `toggle-row ${props.className}` : 'toggle-row'}>
      <input
        type="checkbox"
        data-action={props.dataAction}
        checked={props.checked}
        disabled={props.disabled}
        onChange={event => props.onChange(event.currentTarget.checked)}
      />
      <span className="switch" aria-hidden="true" />
      <span className="toggle-tx">
        <strong>
          {props.TitleComponent
            ? <props.TitleComponent help={props.help}>{props.title}</props.TitleComponent>
            : <FieldTitle className={props.titleClassName} help={props.help}>{props.title}</FieldTitle>}
        </strong>
        {props.description ? <small>{props.description}</small> : null}
      </span>
    </label>
  );
}

export function OverviewList(props: {
  id?: string;
  className?: string;
  children: ReactNode;
}): React.JSX.Element {
  return <ul className={['overview-list', props.className].filter(Boolean).join(' ')} id={props.id}>{props.children}</ul>;
}

export function OverviewListItem(props: HTMLAttributes<HTMLLIElement> & {
  kind?: 'session' | 'schedule' | 'group';
  children: ReactNode;
}): React.JSX.Element {
  const { kind, className, children, ...rest } = props;
  const kindClass = kind ? `overview-list-item-${kind}` : '';
  return <li {...rest} className={['overview-list-item', kindClass, className].filter(Boolean).join(' ')}>{children}</li>;
}

export function OverviewListMain(props: { children: ReactNode }): React.JSX.Element {
  return <div className="overview-list-main">{props.children}</div>;
}

export function OverviewListTail(props: { children: ReactNode }): React.JSX.Element {
  return <div className="overview-list-tail">{props.children}</div>;
}

// Base UI Select + Combobox are ~60KB gzip together, about a sixth of the whole
// first screen, while most screens show no dropdown until a page chunk loads.
// So the implementations arrive with the first DropdownMenu that renders; until
// then it shows the same trigger, inert for the moment the chunk takes.
const DropdownSelect = lazy(() => import('./dropdown-select.js'));
const DropdownCombobox = lazy(() => import('./dropdown-combobox.js'));

function DropdownMenuFallback(props: DropdownMenuProps<string>): React.JSX.Element {
  return (
    <div id={props.id} className={dropdownRootClassName(props, false)} hidden={props.hidden} style={props.style}>
      <div
        className="sect-sort-trigger"
        role="combobox"
        aria-expanded={false}
        aria-label={props.ariaLabel}
        aria-disabled={props.disabled || undefined}
      >
        <DropdownTriggerValue label={props.label} />
      </div>
    </div>
  );
}

export function DropdownMenu<T extends string>(props: DropdownMenuProps<T>): React.JSX.Element {
  // `onChange: (value: T) => void` only accepts this menu's own options, which
  // are the only values the implementation can report back.
  const erased = props as unknown as DropdownMenuProps<string>;
  const Impl = props.searchable ? DropdownCombobox : DropdownSelect;
  return (
    <Suspense fallback={<DropdownMenuFallback {...erased} />}>
      <Impl {...erased} />
    </Suspense>
  );
}

export function SortMenu<T extends string>(props: DropdownMenuProps<T>): React.JSX.Element {
  return <DropdownMenu {...props} />;
}
