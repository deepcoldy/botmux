import type React from 'react';
import { useEffect, useState } from 'react';
import { DropdownMenu, FieldTitle, dropdownLabel, type DropdownOption } from './dashboard-components.js';
import { useT } from './react-hooks.js';
import type { PromptCacheTtl } from '../../services/prompt-cache-policy.js';
import {
  PROVIDER_RECOVERY_MAX_WAIT_MINUTES_MAX,
  normalizeProviderRecoveryConfig,
  resolveProviderRecoveryPolicy,
  type ProviderRecoveryConfig,
  type ResolvedProviderRecoveryPolicy,
} from '../../services/provider-recovery-policy.js';

type EnabledChoice = '' | 'on' | 'off';

interface Draft {
  enabled: EnabledChoice;
  maxWaitMinutes: string;
}

function toDraft(value: ProviderRecoveryConfig | null | undefined, scope: 'global' | 'bot'): Draft {
  return {
    // Global: unset and false are both "off" (the default); only a bot layer
    // tells "inherit" apart from an explicit "off".
    enabled: value?.enabled === true ? 'on' : value?.enabled === false && scope === 'bot' ? 'off' : '',
    maxWaitMinutes: value?.maxWaitMinutes !== undefined ? String(value.maxWaitMinutes) : '',
  };
}

/** Draft → config layer; blank fields are left out (inherit / default). Throws
 *  the shared normalizer's message on invalid input. */
function fromDraft(draft: Draft): ProviderRecoveryConfig | null {
  const raw: Record<string, unknown> = {};
  if (draft.enabled) raw.enabled = draft.enabled === 'on';
  if (draft.maxWaitMinutes.trim() !== '') raw.maxWaitMinutes = Number(draft.maxWaitMinutes.trim());
  return normalizeProviderRecoveryConfig(raw) ?? null;
}

function EffectiveSummary(props: { policy: ResolvedProviderRecoveryPolicy }): React.JSX.Element {
  const tr = useT();
  const { policy } = props;
  if (!policy.enabled) return <small data-provider-recovery-effective>{tr('providerRecovery.effectiveOff')}</small>;
  const source = tr(policy.maxWaitSource === 'configured' ? 'providerRecovery.sourceConfigured'
    : policy.maxWaitSource === 'cache_1h' ? 'providerRecovery.sourceCache1h' : 'providerRecovery.sourceDefault');
  return (
    <small data-provider-recovery-effective>
      {tr('providerRecovery.effectiveOn', { minutes: policy.maxWaitMinutes, source })}
    </small>
  );
}

/**
 * Editor for one `providerRecovery` layer. `scope: 'global'` edits the
 * machine-wide default (blank = off / built-in wait); `scope: 'bot'` edits a
 * bot override (blank = inherit). `promptCacheTtl` is the effective prompt
 * cache of that scope: the built-in wait follows it.
 */
export function ProviderRecoveryEditor(props: {
  scope: 'global' | 'bot';
  value: ProviderRecoveryConfig | null | undefined;
  /** Bot scope only: the machine-wide layer the blanks inherit from. */
  globalValue?: ProviderRecoveryConfig | null;
  promptCacheTtl?: PromptCacheTtl;
  disabled?: boolean;
  onSave(next: ProviderRecoveryConfig | null): Promise<void> | void;
}): React.JSX.Element {
  const tr = useT();
  const [draft, setDraft] = useState<Draft>(() => toDraft(props.value, props.scope));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setDraft(toDraft(props.value, props.scope)); setError(null); }, [props.value, props.scope]);

  const enabledOptions: DropdownOption<EnabledChoice>[] = props.scope === 'bot'
    ? [
      { value: '', label: tr('providerRecovery.inherit') },
      { value: 'on', label: tr('providerRecovery.on') },
      { value: 'off', label: tr('providerRecovery.off') },
    ]
    : [
      { value: '', label: tr('providerRecovery.off') },
      { value: 'on', label: tr('providerRecovery.on') },
    ];

  let preview: ProviderRecoveryConfig | null = null;
  let previewError: string | null = null;
  try { preview = fromDraft(draft); } catch (e) { previewError = e instanceof Error ? e.message : String(e); }
  const effective = props.scope === 'bot'
    ? resolveProviderRecoveryPolicy(props.globalValue ?? undefined, preview ?? undefined, props.promptCacheTtl)
    : resolveProviderRecoveryPolicy(preview ?? undefined, undefined, props.promptCacheTtl);
  const set = (patch: Partial<Draft>) => setDraft(d => ({ ...d, ...patch }));
  const save = () => {
    if (previewError) { setError(previewError); return; }
    setError(null);
    void props.onSave(preview);
  };

  return (
    <div className="provider-recovery-editor" data-provider-recovery-scope={props.scope}>
      <div className="settings-field-row">
        <FieldTitle help={tr('providerRecovery.enabledHelp')}>{tr('providerRecovery.enabled')}</FieldTitle>
        <DropdownMenu
          className="settings-field-menu"
          ariaLabel={tr('providerRecovery.enabled')}
          disabled={props.disabled}
          value={draft.enabled}
          label={dropdownLabel(enabledOptions, draft.enabled)}
          options={enabledOptions}
          onChange={value => set({ enabled: value })}
        />
      </div>
      <div className="settings-field-row">
        <FieldTitle help={tr('providerRecovery.maxWaitMinutesHelp')}>{tr('providerRecovery.maxWaitMinutes')}</FieldTitle>
        <input
          type="number"
          min={1}
          max={PROVIDER_RECOVERY_MAX_WAIT_MINUTES_MAX}
          step={1}
          inputMode="numeric"
          data-input="providerRecovery.maxWaitMinutes"
          placeholder={props.scope === 'bot' ? tr('providerRecovery.inherit') : tr('providerRecovery.maxWaitDefault')}
          value={draft.maxWaitMinutes}
          disabled={props.disabled}
          onChange={e => set({ maxWaitMinutes: e.currentTarget.value })}
        />
      </div>
      <EffectiveSummary policy={effective} />
      <div className="actions">
        <button type="button" className="primary" data-action="save-provider-recovery" disabled={props.disabled} onClick={save}>
          {tr('providerRecovery.save')}
        </button>
        <button
          type="button"
          data-action="clear-provider-recovery"
          disabled={props.disabled}
          onClick={() => { setError(null); void props.onSave(null); }}
        >
          {props.scope === 'bot' ? tr('providerRecovery.clearBot') : tr('providerRecovery.clearGlobal')}
        </button>
        {error || previewError ? <small className="is-error" data-provider-recovery-error>{`✗ ${error ?? previewError}`}</small> : null}
      </div>
    </div>
  );
}
