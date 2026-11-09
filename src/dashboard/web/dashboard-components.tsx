import type React from 'react';
import {
  lazy,
  Suspense,
  type ButtonHTMLAttributes,
  type ComponentType,
  type HTMLAttributes,
  type ReactElement,
  type ReactNode,
} from 'react';
import { dropdownRootClassName, DropdownTriggerValue, type DropdownMenuProps } from './dropdown-shared.js';
import { floatingPortalHost } from './floating-host.js';
import {
  infoTipClassName,
  infoTipLabel,
  infoTipTrigger,
  OverflowTextScroll,
  overflowTextRootProps,
  plainText,
  useOverflowText,
  type InfoTipProps,
  type OverflowTextProps,
} from './tip-shared.js';

export { dropdownLabel, type DropdownOption } from './dropdown-shared.js';
export { floatingPortalHost };

/**
 * A component whose implementation arrives in its own chunk, the first time one
 * renders; until then `Fallback` stands in, looking the same but inert.
 * A failed chunk load must not reach React: nothing above these components
 * catches it, so the whole page would unmount. The browser keeps the failed
 * fetch for the life of the page, so there is nothing to retry either; the
 * fallback stays.
 */
export function lazyWithFallback<P extends object>(
  load: () => Promise<{ default: ComponentType<P> }>,
  Fallback: ComponentType<P>,
  name: string,
  options: {
    /**
     * Base UI's hover hooks reach for DOM globals such as `Element` as soon as
     * they mount. Under react-test-renderer there are none, even when a test
     * stubs `window`, so without a DOM keep the fallback.
     */
    browserOnly?: boolean;
  } = {},
): (props: P) => React.JSX.Element {
  const Impl = lazy(() => load().catch((error: unknown) => {
    console.error(`botmux ${name} failed to load`, error);
    return { default: Fallback };
  })) as unknown as ComponentType<P>;
  return function LazyWithFallback(props: P): React.JSX.Element {
    if (options.browserOnly && typeof Element === 'undefined') return <Fallback {...props} />;
    return (
      <Suspense fallback={<Fallback {...props} />}>
        <Impl {...props} />
      </Suspense>
    );
  };
}

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

function InfoTipFallback(props: InfoTipProps): React.JSX.Element {
  return (
    <span
      className={infoTipClassName(props)}
      aria-label={infoTipLabel(props)}
      onClick={props.preventClick === false ? undefined : event => event.preventDefault()}
    >
      {infoTipTrigger(props)}
    </span>
  );
}

/**
 * `?` help mark whose popup explains a field. Hover or tap opens it; a click
 * pins it open so its text can be copied; from the keyboard, Enter or Space.
 */
export const InfoTip = lazyWithFallback(() => import('./info-tip-popover.js'), InfoTipFallback, 'info tip', {
  browserOnly: true,
});

function OverflowTextPlain(props: OverflowTextProps): React.JSX.Element {
  const { ref, overflowing, measure } = useOverflowText(props.text);
  return (
    <span ref={ref} {...overflowTextRootProps(props, overflowing)} onMouseEnter={measure}>
      <OverflowTextScroll {...props} />
    </span>
  );
}

const OverflowTextWithTooltip = lazyWithFallback<OverflowTextProps>(
  () => import('./hover-tooltips.js').then(module => ({ default: module.OverflowTextTooltip })),
  OverflowTextPlain,
  'overflow text tooltip',
  { browserOnly: true },
);

export function OverflowText(props: OverflowTextProps): React.JSX.Element {
  return props.showPopover === false ? <OverflowTextPlain {...props} /> : <OverflowTextWithTooltip {...props} />;
}

type IconTipProps = {
  label: string;
  /** A single DOM element (button or link); it becomes the tooltip trigger. */
  children: ReactElement;
};

/** Label tooltip for an icon-only control: hover or keyboard focus shows it, a click hides it. */
export const IconTip = lazyWithFallback<IconTipProps>(
  () => import('./hover-tooltips.js').then(module => ({ default: module.IconTipTooltip })),
  props => props.children,
  'icon tooltip',
  { browserOnly: true },
);

export function FieldTitle(props: {
  children: ReactNode;
  help?: ReactNode;
  helpLabel?: string;
  className?: string;
}): React.JSX.Element {
  return (
    <span className={['ui-field-title', props.className].filter(Boolean).join(' ')}>
      <span className="ui-field-title-text">{props.children}</span>
      {props.help ? <InfoTip label={props.helpLabel ?? plainText(props.children)}>{props.help}</InfoTip> : null}
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

type DropdownImplModule = { default: (props: DropdownMenuProps<string>) => React.JSX.Element };
export type DropdownImplImporters = Record<'select' | 'combobox', () => Promise<DropdownImplModule>>;

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

export function createDropdownMenu(importers: DropdownImplImporters) {
  const DropdownSelect = lazyWithFallback(importers.select, DropdownMenuFallback, 'dropdown');
  const DropdownCombobox = lazyWithFallback(importers.combobox, DropdownMenuFallback, 'dropdown');
  return function DropdownMenu<T extends string>(props: DropdownMenuProps<T>): React.JSX.Element {
    // `onChange: (value: T) => void` only accepts this menu's own options, which
    // are the only values the implementation can report back.
    const erased = props as unknown as DropdownMenuProps<string>;
    return props.searchable ? <DropdownCombobox {...erased} /> : <DropdownSelect {...erased} />;
  };
}

// Base UI Select + Combobox are ~60KB gzip together, about a sixth of the whole
// first screen, while most screens show no dropdown until a page chunk loads.
// So the implementations arrive with the first DropdownMenu that renders; until
// then it shows the same trigger, inert for the moment the chunk takes.
export const DropdownMenu = createDropdownMenu({
  select: () => import('./dropdown-select.js'),
  combobox: () => import('./dropdown-combobox.js'),
});

export function SortMenu<T extends string>(props: DropdownMenuProps<T>): React.JSX.Element {
  return <DropdownMenu {...props} />;
}
