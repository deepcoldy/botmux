import type React from 'react';
import { useEffect, useState } from 'react';
import { DropdownMenu, FieldTitle, dropdownLabel, type DropdownOption } from './dashboard-components.js';
import { useT } from './react-hooks.js';
import {
  MAX_KEEPALIVE_IDLE_MINUTES,
  MAX_KEEPALIVE_MIN_CONTEXT_TOKENS,
  MAX_KEEPALIVE_PINGS,
  normalizePromptCacheConfig,
  resolvePromptCachePolicy,
  type PromptCacheConfig,
  type ResolvedPromptCachePolicy,
} from '../../services/prompt-cache-policy.js';

type TtlChoice = '' | '5m' | '1h';
type KeepaliveChoice = '' | 'on' | 'off';

interface Draft {
  ttl: TtlChoice;
  keepalive: KeepaliveChoice;
  idleMinutes: string;
  maxPings: string;
  activeHours: string;
  minContextTokens: string;
}

function toDraft(value: PromptCacheConfig | null | undefined): Draft {
  const k = value?.keepalive;
  return {
    ttl: value?.ttl ?? '',
    keepalive: k?.enabled === true ? 'on' : k?.enabled === false ? 'off' : '',
    idleMinutes: k?.idleMinutes !== undefined ? String(k.idleMinutes) : '',
    maxPings: k?.maxPings !== undefined ? String(k.maxPings) : '',
    activeHours: k?.activeHours ?? '',
    minContextTokens: k?.minContextTokens !== undefined ? String(k.minContextTokens) : '',
  };
}

/** Draft → config layer; blank fields are left out (inherit / default). Throws
 *  the shared normalizer's message on invalid input. */
function fromDraft(draft: Draft): PromptCacheConfig | null {
  const keepalive: Record<string, unknown> = {};
  if (draft.keepalive) keepalive.enabled = draft.keepalive === 'on';
  const int = (text: string) => (text.trim() === '' ? undefined : Number(text.trim()));
  const idle = int(draft.idleMinutes);
  if (idle !== undefined) keepalive.idleMinutes = idle;
  const pings = int(draft.maxPings);
  if (pings !== undefined) keepalive.maxPings = pings;
  if (draft.activeHours.trim()) keepalive.activeHours = draft.activeHours.trim();
  const minTokens = int(draft.minContextTokens);
  if (minTokens !== undefined) keepalive.minContextTokens = minTokens;
  const raw: Record<string, unknown> = {};
  if (draft.ttl) raw.ttl = draft.ttl;
  if (Object.keys(keepalive).length > 0) raw.keepalive = keepalive;
  return normalizePromptCacheConfig(raw) ?? null;
}

function minutesToHhMm(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function EffectiveSummary(props: { policy: ResolvedPromptCachePolicy }): React.JSX.Element {
  const tr = useT();
  const { policy } = props;
  const k = policy.keepalive;
  const ttl = policy.ttl ? tr(policy.ttl === '1h' ? 'promptCache.ttl1h' : 'promptCache.ttl5m') : tr('promptCache.ttlCliDefault');
  const keepalive = k.enabled
    ? tr('promptCache.effectiveKeepaliveOn', {
      idle: k.idleMinutes,
      pings: k.maxPings,
      hours: k.activeHours ? `${minutesToHhMm(k.activeHours.start)}-${minutesToHhMm(k.activeHours.end)}` : tr('promptCache.allDay'),
      tokens: k.minContextTokens,
    })
    : tr('promptCache.effectiveKeepaliveOff');
  return <small data-prompt-cache-effective>{tr('promptCache.effective', { ttl, keepalive })}</small>;
}

/**
 * Editor for one prompt-cache layer. `scope: 'global'` edits the machine-wide
 * default (blank = built-in default); `scope: 'bot'` edits a bot override (blank
 * = inherit the global value, shown as the effective summary).
 */
export function PromptCacheEditor(props: {
  scope: 'global' | 'bot';
  value: PromptCacheConfig | null | undefined;
  /** Bot scope only: the machine-wide layer the blanks inherit from. */
  globalValue?: PromptCacheConfig | null;
  disabled?: boolean;
  onSave(next: PromptCacheConfig | null): Promise<void> | void;
}): React.JSX.Element {
  const tr = useT();
  const [draft, setDraft] = useState<Draft>(() => toDraft(props.value));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(toDraft(props.value)); setError(null); }, [props.value]);

  const blank = props.scope === 'bot' ? tr('promptCache.inherit') : tr('promptCache.default');
  const ttlOptions: DropdownOption<TtlChoice>[] = [
    { value: '', label: props.scope === 'bot' ? tr('promptCache.inherit') : tr('promptCache.ttlCliDefault') },
    { value: '5m', label: tr('promptCache.ttl5m') },
    { value: '1h', label: tr('promptCache.ttl1h') },
  ];
  const keepaliveOptions: DropdownOption<KeepaliveChoice>[] = [
    { value: '', label: props.scope === 'bot' ? tr('promptCache.inherit') : tr('promptCache.keepaliveOff') },
    { value: 'on', label: tr('promptCache.keepaliveOn') },
    { value: 'off', label: tr('promptCache.keepaliveOff') },
  ];

  let preview: PromptCacheConfig | null = null;
  let previewError: string | null = null;
  try { preview = fromDraft(draft); } catch (e) { previewError = e instanceof Error ? e.message : String(e); }
  // What the unsaved draft would resolve to: a bot layer over the saved global
  // layer, or the global layer alone over the built-in defaults.
  const effective = props.scope === 'bot'
    ? resolvePromptCachePolicy(props.globalValue ?? undefined, preview ?? undefined)
    : resolvePromptCachePolicy(preview ?? undefined, undefined);

  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));
  const save = () => {
    if (previewError) { setError(previewError); return; }
    setError(null);
    void props.onSave(preview);
  };
  const numberField = (key: 'idleMinutes' | 'maxPings' | 'minContextTokens', min: number, max: number) => (
    <input
      type="number"
      min={min}
      max={max}
      step={1}
      inputMode="numeric"
      data-input={`promptCache.${key}`}
      placeholder={blank}
      value={draft[key]}
      disabled={props.disabled}
      onChange={e => set({ [key]: e.currentTarget.value } as Partial<Draft>)}
    />
  );

  return (
    <div className="prompt-cache-editor" data-prompt-cache-scope={props.scope}>
      <div className="settings-field-row">
        <FieldTitle help={tr('promptCache.ttlHelp')}>{tr('promptCache.ttl')}</FieldTitle>
        <DropdownMenu
          className="settings-field-menu"
          ariaLabel={tr('promptCache.ttl')}
          disabled={props.disabled}
          value={draft.ttl}
          label={dropdownLabel(ttlOptions, draft.ttl)}
          options={ttlOptions}
          onChange={value => set({ ttl: value })}
        />
      </div>
      <div className="settings-field-row">
        <FieldTitle help={tr('promptCache.keepaliveHelp')}>{tr('promptCache.keepalive')}</FieldTitle>
        <DropdownMenu
          className="settings-field-menu"
          ariaLabel={tr('promptCache.keepalive')}
          disabled={props.disabled}
          value={draft.keepalive}
          label={dropdownLabel(keepaliveOptions, draft.keepalive)}
          options={keepaliveOptions}
          onChange={value => set({ keepalive: value })}
        />
      </div>
      <div className="settings-field-row">
        <FieldTitle help={tr('promptCache.idleMinutesHelp')}>{tr('promptCache.idleMinutes')}</FieldTitle>
        {numberField('idleMinutes', 1, MAX_KEEPALIVE_IDLE_MINUTES)}
      </div>
      <div className="settings-field-row">
        <FieldTitle help={tr('promptCache.maxPingsHelp')}>{tr('promptCache.maxPings')}</FieldTitle>
        {numberField('maxPings', 1, MAX_KEEPALIVE_PINGS)}
      </div>
      <div className="settings-field-row">
        <FieldTitle help={tr('promptCache.activeHoursHelp')}>{tr('promptCache.activeHours')}</FieldTitle>
        <input
          type="text"
          data-input="promptCache.activeHours"
          placeholder={props.scope === 'bot' ? blank : '10:00-23:00'}
          value={draft.activeHours}
          disabled={props.disabled}
          onChange={e => set({ activeHours: e.currentTarget.value })}
        />
      </div>
      <div className="settings-field-row">
        <FieldTitle help={tr('promptCache.minContextTokensHelp')}>{tr('promptCache.minContextTokens')}</FieldTitle>
        {numberField('minContextTokens', 0, MAX_KEEPALIVE_MIN_CONTEXT_TOKENS)}
      </div>
      <EffectiveSummary policy={effective} />
      <div className="actions">
        <button type="button" className="primary" data-action="save-prompt-cache" disabled={props.disabled} onClick={save}>
          {tr('promptCache.save')}
        </button>
        <button
          type="button"
          data-action="clear-prompt-cache"
          disabled={props.disabled}
          onClick={() => { setError(null); void props.onSave(null); }}
        >
          {props.scope === 'bot' ? tr('promptCache.clearBot') : tr('promptCache.clearGlobal')}
        </button>
        {error || previewError ? <small className="is-error" data-prompt-cache-error>{`✗ ${error ?? previewError}`}</small> : null}
      </div>
    </div>
  );
}
