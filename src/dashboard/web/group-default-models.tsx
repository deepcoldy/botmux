import React, { useEffect, useRef, useState } from 'react';
import { groupModelSettings, type GroupDefaultModels, type GroupModelSettings } from '../../core/group-default-models.js';
import { reasoningEffortsForCliModel } from '../../services/codex-reasoning-effort.js';
import { useT } from './react-hooks.js';
import { DropdownField, ModelPickerField } from './bot-defaults-page.js';
import { fetchCliOptions, fetchDetectedModels, mergeModelCandidates, modelSuggestionsForOption, selectedCliOption } from './bot-defaults.js';

type Props = {
  chatId: string;
  appId: string;
  botName: string;
  cliId?: string;
  botModel?: string;
  botEffort?: string;
  models?: GroupDefaultModels;
  disabled?: boolean;
  onSaved(): Promise<unknown>;
};

/** The CLI is display-only and always follows the bot's Agent configuration. */
export function GroupDefaultModelsRow(props: Props) {
  if (props.cliId !== 'codex' && props.cliId !== 'claude-code') {
    return <p>{props.botName} · CLI：{props.cliId ?? '未加载'}（暂不支持群级模型配置）</p>;
  }
  return <GroupAgentDefaults key={`${props.appId}:${props.cliId}`} {...props} cliId={props.cliId} />;
}

function GroupAgentDefaults(props: Props & { cliId: 'codex' | 'claude-code' }) {
  const tr = useT();
  const [settings, setSettings] = useState<GroupModelSettings>(() => groupModelSettings(props.models?.[props.cliId]));
  const [options, setOptions] = useState<string[]>([]);
  const [detectedCount, setDetectedCount] = useState(0);
  const [detecting, setDetecting] = useState(true);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState('');
  const dirty = useRef(false);
  const savingRef = useRef(false);
  useEffect(() => {
    if (!dirty.current && !savingRef.current) setSettings(groupModelSettings(props.models?.[props.cliId]));
  }, [props.models, props.cliId]);
  useEffect(() => {
    let stale = false;
    Promise.all([fetchCliOptions(), fetchDetectedModels(props.cliId)]).then(([catalog, detected]) => {
      if (stale) return;
      setOptions(mergeModelCandidates(modelSuggestionsForOption(selectedCliOption(catalog.options, props.cliId), catalog), detected?.models ?? null));
      setDetectedCount(detected?.source === 'live' ? detected.models.length : 0);
      setDetecting(false);
    });
    return () => { stale = true; };
  }, [props.cliId]);

  const efforts = reasoningEffortsForCliModel(props.cliId, settings.model || props.botModel);
  function changeModel(model: string) {
    dirty.current = true;
    const allowed = reasoningEffortsForCliModel(props.cliId, model || props.botModel);
    setSettings({ model, reasoningEffort: settings.reasoningEffort && allowed.includes(settings.reasoningEffort) ? settings.reasoningEffort : undefined });
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current || props.disabled) return;
    savingRef.current = true;
    setSaving(true);
    setStatus('保存中…');
    try {
      const next = { ...props.models, [props.cliId]: settings };
      const response = await fetch(`/api/groups/${encodeURIComponent(props.chatId)}/default-models/${encodeURIComponent(props.appId)}`, {
        method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next),
      });
      const body = await response.json();
      if (!response.ok || body.ok !== true) throw new Error(body.error || body.reason || `HTTP ${response.status}`);
      dirty.current = false;
      setSettings(groupModelSettings(body.models?.[props.cliId]));
      setStatus('已保存，仅对新话题生效');
      try { await props.onSaved(); }
      catch { setStatus('已保存，列表刷新失败，请刷新页面确认'); }
    } catch (error) {
      setStatus(`保存失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { savingRef.current = false; setSaving(false); }
  }

  const id = `group-${props.appId}`;
  return <form onSubmit={save} className="group-default-models-row">
    <strong>{props.botName} · CLI：{props.cliId === 'codex' ? 'Codex' : 'Claude'}（跟随 Agent 配置）</strong>
    <div className="group-default-models-field"><span>模型</span>
      <ModelPickerField value={settings.model ?? ''} onChange={changeModel} options={options}
        disabled={props.disabled || saving} busy={detecting} dataInput={`${id}-model`}
        ariaLabel={`${props.botName} 模型`} defaultLabel={`继承 Agent 模型${props.botModel ? `（${props.botModel}）` : ''}`}
        customLabel="自定义模型…" includeDefault menuClassName="bd-field-menu"
        detectedCount={detectedCount} detectedLabel={`已探测 ${detectedCount} 个可用模型`} />
    </div>
    <div className="group-default-models-field"><span>思考强度</span>
      <DropdownField dataInput={`${id}-effort`} ariaLabel={`${props.botName} 思考强度`}
        value={settings.reasoningEffort ?? ''} disabled={props.disabled || saving || efforts.length === 0}
        options={[{ value: '', label: efforts.length === 0 ? '当前模型不支持思考强度' : `继承 Agent 思考强度${props.botEffort ? `（${props.botEffort}）` : ''}` }, ...efforts.map(value => ({ value, label: tr(`botDefaults.agentReasoningEffort${value === 'xhigh' ? 'Xhigh' : value[0]!.toUpperCase() + value.slice(1)}`) }))]}
        onChange={value => { dirty.current = true; setSettings({ ...settings, reasoningEffort: efforts.find(e => e === value) }); }} />
    </div>
    <button type="submit" disabled={props.disabled || saving}>保存</button>
    <small role="status">{status}</small>
  </form>;
}
