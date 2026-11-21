import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Combobox } from '@base-ui/react/combobox';
import { floatingPortalHost } from './dashboard-components.js';

/**
 * 「全部群」选项在 Base UI 多选值里的占位。调用方看到的「全部」是空数组，
 * 但它要作为一个真正的 Combobox.Item 参与方向键导航，所以给它一个不会与
 * chatId（oc_ 前缀）冲突的值，进出 Base UI 时在这里互转。
 */
const ALL_VALUE = '\u0000all';

/**
 * 群选择器：基于 Base UI Combobox（popup 内搜索框模式）。
 *
 * 此前是手写的按钮 + 绝对定位浮层，只支持鼠标：没有方向键/Enter 选择，
 * 焦点管理靠手动 querySelector。这里把交互交给 Base UI
 * （listbox 语义、键盘导航、外部点击关闭、关闭后焦点回到触发器、碰撞翻转），
 * 对外 props 与样式类名保持不变，调用方无需改动。
 *
 * 浮层 portal 到最近的 `dialog[open]`（否则 body）：原生 showModal 的弹窗在
 * top layer，挂到 body 的浮层会被它盖住，见 floatingPortalHost。
 */
export function SearchableGroupPicker(props: {
  id: string;
  className?: string;
  label: string;
  groups: Array<{ chatId: string; name?: string }>;
  value: string | string[];
  multiple?: boolean;
  disabled?: boolean;
  allLabel?: string;
  placeholder: string;
  selectedContent?: React.ReactNode;
  searchPlaceholder: string;
  emptyLabel: string;
  selectedCountLabel(count: number): string;
  onChange(value: string | string[]): void;
}): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [portalHost, setPortalHost] = useState<HTMLElement | null>(null);
  const values = Array.isArray(props.value) ? props.value : (props.value ? [props.value] : []);
  const valueSet = useMemo(() => new Set(values), [values]);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredGroups = useMemo(() => {
    if (!normalizedQuery) return props.groups;
    return props.groups.filter(group => `${group.name} ${group.chatId}`.toLocaleLowerCase().includes(normalizedQuery));
  }, [normalizedQuery, props.groups]);
  const showAll = Boolean(props.multiple && props.allLabel && !normalizedQuery);
  const selectedLabel = props.multiple
    ? (values.length === 0 ? props.allLabel || props.placeholder : props.selectedCountLabel(values.length))
    : (props.groups.find(group => group.chatId === values[0])?.name || values[0] || props.placeholder);
  const rootClassName = ['connector-group-picker', props.className, open ? 'open' : ''].filter(Boolean).join(' ');
  // 多选且「全部」可选时，空选择在 Base UI 侧表现为选中了「全部」那一项。
  const comboValue = props.multiple
    ? (values.length === 0 && props.allLabel ? [ALL_VALUE] : values)
    : (values[0] ?? null);

  useEffect(() => { if (props.disabled) setOpen(false); }, [props.disabled]);

  function changeOpen(next: boolean): void {
    if (next) setPortalHost(floatingPortalHost(rootRef.current, document.body) as HTMLElement);
    else setQuery('');
    setOpen(next);
  }

  function changeValue(next: string | string[] | null): void {
    if (!props.multiple) {
      // 防御：@base-ui/react 1.9.0 再点已选项时回传的仍是同一个字符串（实测），但若将来版本
      // 改为回传 null（取消选择），这里保持旧行为「选它并关闭」，不让已选值被清空。
      const chatId = typeof next === 'string' ? next : values[0];
      if (chatId) props.onChange(chatId);
      changeOpen(false);
      return;
    }
    const list = Array.isArray(next) ? next : [];
    const pickedAll = list.includes(ALL_VALUE) && !comboValue?.includes(ALL_VALUE);
    props.onChange(pickedAll ? [] : list.filter(id => id !== ALL_VALUE));
  }

  return (
    <Combobox.Root
      multiple={props.multiple}
      // Root 的 value 类型随 multiple 泛型变化，这里统一按 string | string[] 透传。
      value={comboValue as never}
      onValueChange={value => changeValue(value as string | string[] | null)}
      open={open}
      onOpenChange={changeOpen}
      inputValue={query}
      onInputValueChange={setQuery}
      // 过滤自己做（同时匹配群名与 chatId），Base UI 只负责导航与选择。
      filter={null}
      autoHighlight
      disabled={props.disabled}
    >
      <div
        ref={rootRef}
        className={rootClassName}
        // Base UI 在单选模式下给关闭态触发器挂了 typeahead：焦点在触发器上敲字母会直接
        // 提交匹配项，浮层不打开、没有任何可见反馈（管家群等选择器 onChange 即落盘）。
        // 它没有公开的关闭开关，这里在捕获阶段拦掉单字符键，恢复旧实现「关闭时打字无
        // 副作用」的行为；Enter/Space/方向键等多字符键放行，开合与键盘选择不受影响
        // （Space 靠按钮 keyup 的默认动作开合，stopPropagation 不拦默认动作）。
        onKeyDownCapture={event => {
          if (!open && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
            event.stopPropagation();
          }
        }}
      >
        <Combobox.Trigger
          id={props.id}
          className="connector-group-picker-trigger"
          aria-label={props.label}
        >
          {props.selectedContent ?? (
            <span className={values.length || (props.multiple && props.allLabel) ? '' : 'muted'}>{selectedLabel}</span>
          )}
          <span className="connector-group-picker-chevron" aria-hidden="true" />
        </Combobox.Trigger>
      </div>
      <Combobox.Portal container={portalHost}>
        {/* fixed：模态 dialog 默认 overflow:auto，absolute 浮层会被弹窗框裁掉、可用高度也按弹窗算。 */}
        <Combobox.Positioner
          className="connector-group-picker-positioner"
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={7}
        >
          <Combobox.Popup className="connector-group-picker-popover">
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
              {showAll ? (
                <Combobox.Item
                  value={ALL_VALUE}
                  className={`connector-group-option connector-group-option-all${values.length === 0 ? ' selected' : ''}`}
                >
                  <span className="connector-group-check" aria-hidden="true" />
                  <span><b>{props.allLabel}</b><small>{props.placeholder}</small></span>
                </Combobox.Item>
              ) : null}
              {filteredGroups.map(group => (
                <Combobox.Item
                  key={group.chatId}
                  value={group.chatId}
                  className={`connector-group-option${valueSet.has(group.chatId) ? ' selected' : ''}`}
                >
                  <span className="connector-group-check" aria-hidden="true" />
                  <span><b>{group.name || group.chatId}</b>{group.name ? <small>{group.chatId}</small> : null}</span>
                </Combobox.Item>
              ))}
            </Combobox.List>
            {!filteredGroups.length ? <p className="connector-group-empty">{props.emptyLabel}</p> : null}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
