import { DropdownField, ModelPickerField } from './field-controls.js';
import { InfoTip } from './dashboard-components.js';
import { isCodexReasoningEffort, reasoningEffortsForCliModel } from '../../services/codex-reasoning-effort.js';
import {
  strongestTraexPreflightReasoningEffort,
  type TraexAutoModelSettings,
} from '../../services/traex-auto-model.js';
import type { ModelCapabilities } from './bot-defaults.js';
import { useT } from './react-hooks.js';
import { strongestTraexPreflightModelSettings } from './traex-auto-model-preferences.js';

export function TraexAutoModelEditor(props: {
  enabled: boolean;
  trigger?: 'capacity' | 'quota';
  onTrigger?: (trigger: 'capacity' | 'quota') => void;
  preflightLoadCheck: boolean;
  overloadThresholdPercent: string;
  preflightTimeoutSeconds: string;
  unknownLoadPolicy: 'skip';
  allOverloadedPolicy: 'lowest_load';
  reselectPerTurn: boolean;
  models: string[];
  modelSettings: Record<string, TraexAutoModelSettings>;
  timeoutSeconds: string;
  cooldownSeconds: string;
  candidates: string[];
  capabilities?: ModelCapabilities[];
  busy: boolean;
  dirty?: boolean;
  storageFailed?: boolean;
  saveStatus?: string;
  onSave?: () => void;
  onEnabled: (enabled: boolean) => void;
  onPreflightLoadCheck: (enabled: boolean) => void;
  onOverloadThresholdPercent: (percent: string) => void;
  onPreflightTimeoutSeconds: (seconds: string) => void;
  onUnknownLoadPolicy: (policy: 'skip') => void;
  onAllOverloadedPolicy: (policy: 'lowest_load') => void;
  onReselectPerTurn: (enabled: boolean) => void;
  onModels: (models: string[]) => void;
  onSettings: (model: string, settings: TraexAutoModelSettings) => void;
  onTimeout: (seconds: string) => void;
  onCooldown: (seconds: string) => void;
}) {
  const tr = useT();
  function move(index: number, delta: number) {
    const next = [...props.models];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    props.onModels(next);
  }
  const capacityLabel = (tokens: number) => tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(2))}M` : `${Number((tokens / 1_000).toFixed(1))}K`;
  return (
    <div className="bd-auto-model" data-traex-auto-model="">
      <label className="bd-auto-model-toggle">
        <input type="checkbox" data-input="autoModelEnabled" checked={props.enabled}
          disabled={props.busy} onChange={event => props.onEnabled(event.currentTarget.checked)} />
        <span>{tr('botDefaults.autoModelTitle')}</span>
      </label>
      <div className="bd-auto-model-description">
        <span>{tr(props.trigger === 'quota' ? 'botDefaults.autoModelQuotaSummary' : 'botDefaults.autoModelSummary')}</span>
        <InfoTip label={tr('botDefaults.autoModelDetails')} className="bd-info-tip" trigger="?">
          {tr(props.trigger === 'quota' ? 'botDefaults.autoModelQuotaHelp' : 'botDefaults.autoModelHelp')}
        </InfoTip>
      </div>
      {props.enabled ? <>
        <DropdownField dataInput="autoModelTrigger" ariaLabel={tr('botDefaults.autoModelTrigger')}
          value={props.trigger ?? 'capacity'} disabled={props.busy}
          options={[{ value: 'capacity', label: tr('botDefaults.autoModelCapacityTrigger') },
            { value: 'quota', label: tr('botDefaults.autoModelQuotaTrigger') }]}
          onChange={value => props.onTrigger?.(value === 'quota' ? 'quota' : 'capacity')} />
        {props.trigger !== 'quota' && <>
          <label className="bd-auto-model-toggle">
            <input type="checkbox" data-input="autoModelPreflightLoadCheck" checked={props.preflightLoadCheck}
              disabled={props.busy} onChange={event => props.onPreflightLoadCheck(event.currentTarget.checked)} />
            <span>{tr('botDefaults.autoModelPreflightLoadCheck')}</span>
            <InfoTip label={tr('botDefaults.autoModelDetails')} className="bd-info-tip" trigger="?">
              {tr('botDefaults.autoModelPreflightLoadCheckHelp')}
            </InfoTip>
          </label>
          {props.preflightLoadCheck && <>
            <label className="bd-auto-model-timeout">
              <span>{tr('botDefaults.autoModelOverloadThreshold')}</span>
              <input type="number" min="0" max="65535" step="1" data-input="autoModelOverloadThreshold"
                value={props.overloadThresholdPercent} disabled={props.busy}
                onChange={event => props.onOverloadThresholdPercent(event.currentTarget.value)} />
            </label>
            <label className="bd-auto-model-timeout">
              <span>{tr('botDefaults.autoModelPreflightTimeout')}</span>
              <input type="number" min="0.1" max="30" step="0.1" data-input="autoModelPreflightTimeout"
                value={props.preflightTimeoutSeconds} disabled={props.busy}
                onChange={event => props.onPreflightTimeoutSeconds(event.currentTarget.value)} />
            </label>
            <DropdownField dataInput="autoModelUnknownLoadPolicy" ariaLabel={tr('botDefaults.autoModelUnknownLoadPolicy')}
              value={props.unknownLoadPolicy} disabled={props.busy}
              options={[{ value: 'skip', label: tr('botDefaults.autoModelUnknownLoadSkip') }]}
              onChange={() => props.onUnknownLoadPolicy('skip')} />
            <DropdownField dataInput="autoModelAllOverloadedPolicy" ariaLabel={tr('botDefaults.autoModelAllOverloadedPolicy')}
              value={props.allOverloadedPolicy} disabled={props.busy}
              options={[{ value: 'lowest_load', label: tr('botDefaults.autoModelAllOverloadedLowestLoad') }]}
              onChange={() => props.onAllOverloadedPolicy('lowest_load')} />
          </>}
        </>}
        {props.trigger !== 'quota' && <label className="bd-auto-model-toggle">
          <input type="checkbox" data-input="autoModelReselectPerTurn" checked={props.reselectPerTurn}
            disabled={props.busy} onChange={event => props.onReselectPerTurn(event.currentTarget.checked)} />
          <span>{tr('botDefaults.autoModelReselectPerTurn')}</span>
          <InfoTip label={tr('botDefaults.autoModelDetails')} className="bd-info-tip" trigger="?">
            {tr('botDefaults.autoModelReselectPerTurnHelp')}
          </InfoTip>
        </label>}
        <ol className="bd-auto-model-list">
          {props.models.map((model, index) => {
            const settings = props.modelSettings[model] ?? {};
            const capability = props.capabilities?.find(entry => entry.slug.toLowerCase() === model.toLowerCase());
            const variant = capability?.contextVariants?.find(entry => entry.id === settings.modelBackendVariant);
            const advertisedEfforts = (variant?.reasoningEfforts ?? capability?.reasoningEfforts
              ?? reasoningEffortsForCliModel('traex', model)).filter(isCodexReasoningEffort);
            const forcedEffort = strongestTraexPreflightModelSettings(model, capability).reasoningEffort;
            const efforts = props.preflightLoadCheck && forcedEffort ? [forcedEffort] : advertisedEfforts;
            const contextOptions = [
              { value: '', label: capability?.contextWindow
                ? `${tr('botDefaults.autoModelDefault')} · ${capacityLabel(capability.contextWindow)}`
                : tr('botDefaults.autoModelDefault') },
              ...(capability?.contextVariants ?? []).map(entry => ({
                value: entry.id, label: `${entry.id === 'max' ? 'Max' : 'Standard'} · ${capacityLabel(entry.contextWindow)}`,
              })),
            ];
            if (settings.modelBackendVariant && !contextOptions.some(entry => entry.value === settings.modelBackendVariant)) {
              contextOptions.push({ value: settings.modelBackendVariant, label: settings.modelBackendVariant === 'max' ? 'Max' : 'Standard' });
            }
            return <li key={index}>
              <div className="bd-auto-model-main">
              <span className="bd-auto-model-rank">{index === 0 ? tr('botDefaults.autoModelPreferred') : `${index + 1}`}</span>
              <div className="bd-auto-model-picker">
                <ModelPickerField value={model} options={props.candidates.filter(candidate =>
                  !props.models.some((entry, at) => at !== index && entry.toLowerCase() === candidate.toLowerCase()))}
                  disabled={props.busy} dataInput={`autoModel${index}`} ariaLabel={`${tr('botDefaults.agentModel')} ${index + 1}`}
                  defaultLabel={tr('botDefaults.modelPickerDefault')} customLabel={tr('botDefaults.modelPickerCustom')}
                  menuClassName="bd-field-menu"
                  onChange={value => props.onModels(props.models.map((entry, at) => at === index ? value : entry))} />
              </div>
              <button type="button" aria-label={tr('botDefaults.autoModelUp')} disabled={props.busy || index === 0}
                onClick={() => move(index, -1)}>↑</button>
              <button type="button" aria-label={tr('botDefaults.autoModelDown')} disabled={props.busy || index === props.models.length - 1}
                onClick={() => move(index, 1)}>↓</button>
              <button type="button" aria-label={tr('botDefaults.autoModelRemove')} disabled={props.busy || props.models.length === 1}
                onClick={() => props.onModels(props.models.filter((_, at) => at !== index))}>×</button>
              </div>
              <div className="bd-auto-model-settings">
                <div className="bd-auto-model-setting">
                  <span>{tr('botDefaults.agentReasoningEffort')}</span>
                  <DropdownField dataInput={`autoModelEffort${index}`} ariaLabel={`${model} ${tr('botDefaults.agentReasoningEffort')}`}
                    value={props.preflightLoadCheck ? forcedEffort ?? '' : settings.reasoningEffort ?? ''}
                    disabled={props.busy || !model || props.preflightLoadCheck}
                    options={[...(props.preflightLoadCheck ? [] : [{ value: '', label: tr('botDefaults.autoModelDefault') }]),
                      ...efforts.map(effort => ({ value: effort, label: effort }))]}
                    onChange={effort => props.onSettings(model, {
                      ...settings, reasoningEffort: isCodexReasoningEffort(effort) ? effort : undefined,
                    })} />
                </div>
                <div className="bd-auto-model-setting">
                  <span>{tr('botDefaults.autoModelContext')}</span>
                  <DropdownField dataInput={`autoModelContext${index}`} ariaLabel={`${model} ${tr('botDefaults.autoModelContext')}`}
                    value={settings.modelBackendVariant ?? ''} disabled={props.busy || !model}
                    options={contextOptions}
                    onChange={value => {
                      const nextVariant = value === 'standard' || value === 'max' ? value : undefined;
                      const allowed = capability?.contextVariants?.find(entry => entry.id === nextVariant)?.reasoningEfforts
                        ?? capability?.reasoningEfforts ?? advertisedEfforts;
                      props.onSettings(model, { ...settings, modelBackendVariant: nextVariant,
                        reasoningEffort: props.preflightLoadCheck
                          ? strongestTraexPreflightReasoningEffort(model, allowed)
                          : settings.reasoningEffort && allowed.includes(settings.reasoningEffort)
                            ? settings.reasoningEffort : undefined });
                    }} />
                </div>
              </div>
            </li>
          })}
        </ol>
        <button type="button" data-action="autoModelAdd" disabled={props.busy}
          onClick={() => props.onModels([...props.models, ''])}>{tr('botDefaults.autoModelAdd')}</button>
        <span className="bd-auto-model-count">{tr('botDefaults.autoModelCount', { count: props.models.length })}</span>
        {props.trigger !== 'quota' && <><label className="bd-auto-model-timeout">
          <span>{tr('botDefaults.autoModelTimeout')}</span>
          <input type="number" min="5" max="300" step="1" data-input="autoModelTimeout"
            value={props.timeoutSeconds} disabled={props.busy}
            onChange={event => props.onTimeout(event.currentTarget.value)} />
        </label>
        <label className="bd-auto-model-timeout">
          <span>{tr('botDefaults.autoModelCooldown')}</span>
          <input type="number" min="5" max="300" step="1" data-input="autoModelCooldown"
            value={props.cooldownSeconds} disabled={props.busy}
            onChange={event => props.onCooldown(event.currentTarget.value)} />
        </label>
        </>}
      </> : null}
      <div className="bd-auto-model-save">
        <button type="button" className="primary" data-action="save-auto-model"
          disabled={props.busy || !props.dirty} onClick={props.onSave}>
          {tr('botDefaults.autoModelSave')}
        </button>
        <span data-auto-model-save-state="" role="status">
          {props.dirty
            ? [props.saveStatus, tr(props.storageFailed ? 'botDefaults.autoModelDraftStorageFailed' : 'botDefaults.autoModelDraftKept')].filter(Boolean).join(' · ')
            : props.saveStatus ?? tr('botDefaults.autoModelSaved')}
        </span>
      </div>
    </div>
  );
}
