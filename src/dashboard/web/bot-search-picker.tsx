import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Combobox } from '@base-ui/react/combobox';
import { floatingPortalHost } from './dashboard-components.js';
import { botOptionLabel, filterBotOptions, type BotSearchOption } from './bot-search-model.js';

/**
 * 可搜索的单选 Bot 选择器：基于 Base UI Combobox（popup 内搜索框模式），与
 * SearchableGroupPicker 同一套交互与样式（connector-group-* 类名）。
 *
 * - 输入过滤（显示名 / appId / CLI，见 bot-search-model）；
 * - 上下键移动高亮、回车选中、Esc 关闭，listbox / option 语义由 Base UI 给出；
 * - 不能用的 Bot 照样列出、标原因、不可选（disabled item，方向键跳过）。
 *
 * 选中即回调 onChange（调用方决定是否落盘）；再选当前值不回调。
 */
export function BotSearchPicker(props: {
  id: string;
  label: string;
  options: readonly BotSearchOption[];
  value: string;
  disabled?: boolean;
  placeholder: string;
  searchPlaceholder: string;
  emptyLabel: string;
  /** 当前值不在 options 里时触发器显示的名字。 */
  valueLabel?: string;
  describedBy?: string;
  onChange(larkAppId: string): void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const filtered = useMemo(() => filterBotOptions(props.options, query), [props.options, query]);
  const current = props.options.find((option) => option.larkAppId === props.value);
  const selectedLabel = current ? botOptionLabel(current) : (props.valueLabel || props.value || props.placeholder);
  const rootClassName = ['connector-group-picker', 'bot-search-picker', open ? 'open' : ''].filter(Boolean).join(' ');

  useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);

  function changeOpen(next: boolean): void {
    if (next) setPortalHost(floatingPortalHost(rootRef.current, document.body) as HTMLElement);
    else setQuery('');
    setOpen(next);
  }

  function changeValue(next: string | null): void {
    const larkAppId = typeof next === 'string' ? next : '';
    changeOpen(false);
    if (larkAppId && larkAppId !== props.value && !props.options.find((option) => option.larkAppId === larkAppId)?.disabledWhy) {
      props.onChange(larkAppId);
    }
  }

  return (
    <Combobox.Root
      value={props.value || null}
      onValueChange={(value) => changeValue(value as string | null)}
      open={open}
      onOpenChange={changeOpen}
      inputValue={query}
      onInputValueChange={setQuery}
      // 过滤自己做（名称 / appId / CLI），Base UI 只负责导航与选择。
      filter={null}
      autoHighlight
      disabled={props.disabled}
    >
      <div
        ref={rootRef}
        className={rootClassName}
        // 与 SearchableGroupPicker 相同：关闭态触发器上的单字符 typeahead 会直接提交
        // 匹配项（这里 onChange 即落盘），在捕获阶段拦掉。
        onKeyDownCapture={(event) => {
          if (!open && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.stopPropagation();
          }
        }}
      >
        <Combobox.Trigger
          id={props.id}
          className="connector-group-picker-trigger"
          aria-label={props.label}
          {...(props.describedBy ? { 'aria-describedby': props.describedBy } : {})}
        >
          <span className={current || props.value ? '' : 'muted'}>{selectedLabel}</span>
          <span className="connector-group-picker-chevron" aria-hidden="true" />
        </Combobox.Trigger>
      </div>
      <Combobox.Portal container={portalHost}>
        <Combobox.Positioner
          className="connector-group-picker-positioner"
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={7}
        >
          <Combobox.Popup className="connector-group-picker-popover bot-search-popover">
            <label className="connector-group-search" htmlFor={`${props.id}-search`}>
              <span className="connector-group-search-icon" aria-hidden="true" />
              <Combobox.Input
                id={`${props.id}-search`}
                type="search"
                aria-label={props.searchPlaceholder}
                autoComplete="off"
                placeholder={props.searchPlaceholder}
              />
            </label>
            <Combobox.List className="connector-group-options" aria-label={props.label}>
              {filtered.map((option) => (
                <Combobox.Item
                  key={option.larkAppId}
                  value={option.larkAppId}
                  disabled={!!option.disabledWhy}
                  className={`connector-group-option bot-search-option${option.larkAppId === props.value ? ' selected' : ''}${option.disabledWhy ? ' disabled' : ''}`}
                >
                  <span className="connector-group-check" aria-hidden="true" />
                  <span>
                    <b>{option.name}{option.suffix ?? ''}</b>
                    <small>{option.cliId ? `${option.cliId} · ` : ''}{option.larkAppId}</small>
                    {option.disabledWhy ? <small className="bot-search-why">{option.disabledWhy}</small> : null}
                    {!option.disabledWhy && option.hint ? <small className="bot-search-hint">⚠️ {option.hint}</small> : null}
                  </span>
                </Combobox.Item>
              ))}
            </Combobox.List>
            {!filtered.length ? <p className="connector-group-empty">{props.emptyLabel}</p> : null}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
