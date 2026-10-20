import { useId, useMemo, useState, type ReactNode } from 'react';
import { DropdownMenu, dropdownLabel } from './dashboard-components.js';
import { useT } from './react-hooks.js';

// Form controls shared by the bot defaults page, bot onboarding and group
// default models. Kept out of bot-defaults-page.tsx so the statically loaded
// onboarding flow does not pull that whole (lazy-loaded) page into app.js.

export type DropdownFieldOption<T extends string> = {
  value: T;
  label: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
};

export function DropdownField<T extends string>(props: {
  dataInput: string;
  value: T;
  options: DropdownFieldOption<T>[];
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
  searchable?: boolean;
  notifyOnReselect?: boolean;
  onChange(value: T): void;
}) {
  const tr = useT();
  return (
    <>
      <DropdownMenu
        id={`bd-menu-${props.dataInput}`}
        className={['bd-field-menu', props.className].filter(Boolean).join(' ')}
        ariaLabel={props.ariaLabel}
        disabled={props.disabled}
        label={dropdownLabel(props.options, props.value)}
        value={props.value}
        options={props.options}
        searchable={props.searchable}
        searchPlaceholder={props.searchable ? tr('common.dropdownSearch') : undefined}
        searchEmptyLabel={props.searchable ? tr('common.dropdownSearchEmpty') : undefined}
        onChange={props.onChange}
        notifyOnReselect={props.notifyOnReselect}
      />
      <input type="hidden" data-input={props.dataInput} value={props.value} readOnly />
    </>
  );
}

const MODEL_PICKER_CUSTOM = '__custom__';

/**
 * 模型选择器：下拉候选（静态精选 + live 探测合并，由调用方 mergeModelCandidates 算好）
 * + 「自定义模型…」自由输入。模型列表会过期，候选永不锁死。
 * - value='' 表示跟随 CLI 默认，菜单显示 defaultLabel；
 * - value 非空但不在候选中时，把当前值作为额外选项插在最前（旧配置/自定义值可见）；
 * - 选中 customLabel 切到自定义输入模式（datalist 仍挂全部候选做自动补全），
 *   返回按钮切回下拉模式；
 * - busy（live 探测进行中）只在控件下方显示小转圈，不禁用选择。
 */
export function ModelPickerField(props: {
  value: string;
  onChange(next: string): void;
  options: readonly string[];
  disabled?: boolean;
  busy?: boolean;
  dataInput: string;
  ariaLabel: string;
  defaultLabel: string;
  customLabel: string;
  includeDefault?: boolean;
  detectedCount?: number;
  detectedLabel?: string;
  /** 下拉菜单样式类：defaults 页传 bd-field-menu，onboarding 传 onboarding-menu。 */
  menuClassName?: string;
}): React.JSX.Element {
  const tr = useT();
  const [customMode, setCustomMode] = useState(false);
  const datalistId = useId();
  const current = props.value;
  const dropdownOptions = useMemo(() => {
    const opts: { value: string; label: ReactNode }[] = [];
    if (props.includeDefault) opts.push({ value: '', label: props.defaultLabel });
    if (current && !props.options.includes(current)) {
      opts.push({ value: current, label: current });
    }
    for (const item of props.options) opts.push({ value: item, label: item });
    opts.push({ value: MODEL_PICKER_CUSTOM, label: props.customLabel });
    return opts;
  }, [current, props.options, props.customLabel, props.includeDefault, props.defaultLabel]);

  return (
    <span className="bd-model-picker">
      {customMode ? (
        <span className="bd-model-custom">
          <input
            type="text"
            data-input={props.dataInput}
            list={datalistId}
            value={current}
            placeholder={props.defaultLabel}
            disabled={props.disabled}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={event => props.onChange(event.currentTarget.value)}
          />
          <button
            type="button"
            className="bd-model-back"
            disabled={props.disabled}
            onClick={() => setCustomMode(false)}
          >
            {tr('botDefaults.modelPickerBack')}
          </button>
          <datalist id={datalistId}>
            {props.options.map(item => <option value={item} key={item} />)}
          </datalist>
        </span>
      ) : (
        <>
          <DropdownMenu<string>
            id={`bd-menu-${props.dataInput}`}
            className={['bd-model-menu', props.menuClassName].filter(Boolean).join(' ')}
            ariaLabel={props.ariaLabel}
            disabled={props.disabled}
            label={current || props.defaultLabel}
            value={current}
            options={dropdownOptions}
            searchable
            searchPlaceholder={tr('common.dropdownSearch')}
            searchEmptyLabel={tr('common.dropdownSearchEmpty')}
            onChange={next => {
              if (next === MODEL_PICKER_CUSTOM) {
                setCustomMode(true);
                return;
              }
              props.onChange(next);
            }}
          />
          {/* 与 DropdownField 同款 data-input 锚点：既有测试/自动化经它读写当前值 */}
          <input
            type="hidden"
            data-input={props.dataInput}
            value={current}
            onChange={event => props.onChange(event.currentTarget.value)}
          />
        </>
      )}
      {props.busy
        ? <small className="bd-model-busy"><span className="bd-model-spinner" aria-hidden="true" /></small>
        : null}
      {typeof props.detectedCount === 'number' && props.detectedCount > 0 && props.detectedLabel
        ? <small className="bd-model-detected">{props.detectedLabel}</small>
        : null}
    </span>
  );
}
