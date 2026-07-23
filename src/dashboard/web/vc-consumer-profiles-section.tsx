/**
 * 「会议角色预设」编辑面（settings 页 · 会议 agent 区块内）。
 *
 * 数据面：私有 API GET/PUT /api/vc-meeting/consumer-profiles。
 * revision 乐观并发：PUT 带 expectedRevision，409 → 提示刷新（不覆盖他人修改）；
 * 422 → fieldErrors 按 `profiles[i].field` / `defaultConsumerIds` 定位到输入项。
 * permissionPreset 是 UI 概念：custom 只对「已保存的同 id 预设」可选（服务端
 * 只允许沿用既有 policy），新预设必须先选一个模板档。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { DropdownMenu, FieldTitle, InfoTip, dropdownLabel } from './dashboard-components.js';
import { useDashboardLocale, useT } from './react-hooks.js';
import type {
  VcMeetingAgentOptionDto,
  VcMeetingConsumerProfileDto,
  VcMeetingPermissionPreset,
} from '../vc-consumer-profiles-api.js';
import type {
  VcMeetingConsumerProfileTemplate,
  VcMeetingConsumerProfileTemplateCatalog,
} from '../../services/vc-meeting-consumer-profile-templates.js';

const ACTIVITY_TYPES = [
  'transcript_received',
  'chat_received',
  'participant_joined',
  'participant_left',
  'magic_share_started',
  'magic_share_ended',
] as const;

const INSTRUCTIONS_MAX = 8000;
const PROFILE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
/**
 * Pre-provenance migration target. Keep this byte-for-byte aligned with the
 * v2 generated minutes profile: the old seed has no marker, so the explicit
 * Dashboard CTA is the only authority allowed to replace its instructions.
 */
const V2_DEFAULT_MINUTES_INSTRUCTIONS = '持续整理会议纪要，重点记录已确认的决策、待办事项（含负责人和截止时间）以及未解决风险；字幕修订时更新已有条目，不重复记录同一事项。仅在出现新的关键决策、明确待办或风险，或被用户点名时，才在监听群输出简洁增量；无实质增量时保持静默，不发送确认或心跳。需要向会议内发送文字或语音时，必须通过 botmux 受管 request-output/action gate 提交，不得绕过权限、所有权与审核策略。';

type FieldErrorMap = Record<string, string>;

interface DraftProfile extends VcMeetingConsumerProfileDto {
  /** 本地列表 key；与 id 解耦，id 编辑期间列表不重挂载。 */
  uiKey: string;
  /** 尚未保存过的新预设：id 可编辑、custom 档不可选。 */
  isNew: boolean;
}

interface CatalogState {
  /** 本 catalog 属于哪个 listener bot：save 用它而非当前下拉值，防跨 bot 写入。 */
  forBot: string;
  revision: string;
  catalogState: 'uninitialized' | 'explicit_empty' | 'legacy_or_partial' | 'profiles';
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds: string[];
  profiles: DraftProfile[];
  agentOptions: VcMeetingAgentOptionDto[];
  templateCatalog: VcMeetingConsumerProfileTemplateCatalog;
  migrationOffer?: 'enable_seeded_minutes_default';
}

let uiKeySeq = 0;
function nextUiKey(): string {
  uiKeySeq += 1;
  return `p${uiKeySeq}`;
}

function toDraft(profile: VcMeetingConsumerProfileDto): DraftProfile {
  return {
    ...profile,
    listenerPlacement: profile.listenerPlacement ?? 'auto',
    uiKey: nextUiKey(),
    isNew: false,
  };
}

function toDto(draft: DraftProfile): VcMeetingConsumerProfileDto {
  const { uiKey: _uiKey, isNew: _isNew, ...dto } = draft;
  return dto;
}

/** settings 页挂载门：预设 API 是私有端点，公共只读访客请求必 401——
 * canWrite=false 时完全不挂载编辑器（一次 GET 都不发），只显示提示。 */
/** 字段标题 + hover 帮助气泡：把配置语义讲清，避免用户对着裸表单猜。 */
function FieldHead(props: { title: string; help: string }): JSX.Element {
  return (
    <span className="vc-profile-field-head">
      {props.title}
      <InfoTip label={props.title}>
        <span className="vc-profile-help">{props.help}</span>
      </InfoTip>
    </span>
  );
}

function VcProfileDialog(props: {
  title: string;
  eyebrow?: string;
  children: ReactNode;
  onClose(): void;
  className?: string;
}): JSX.Element {
  const tr = useT();
  const ref = useRef<HTMLDialogElement | null>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || dialog.open) return;
    try { dialog.showModal(); } catch { dialog.setAttribute('open', ''); }
  }, []);
  return (
    <dialog
      ref={ref}
      className={['vc-profile-dialog', props.className].filter(Boolean).join(' ')}
      onClose={props.onClose}
      onCancel={(event) => { event.preventDefault(); props.onClose(); }}
    >
      <header className="vc-profile-dialog-head">
        <div>
          {props.eyebrow ? <span>{props.eyebrow}</span> : null}
          <h3>{props.title}</h3>
        </div>
        <button type="button" className="vc-profile-dialog-close" aria-label={tr('settings.vcProfiles.close')} onClick={props.onClose} />
      </header>
      <div className="vc-profile-dialog-body">{props.children}</div>
    </dialog>
  );
}

export function VcConsumerProfilesGate(props: {
  enabled: boolean;
  canWrite: boolean;
  listenerBotAppId: string | null;
  listenerBotOptions: Array<{ larkAppId: string; botName?: string | null }>;
}) {
  const tr = useT();
  if (!props.enabled) return null;
  if (!props.canWrite) return <p className="hint">{tr('settings.vcProfiles.needAuth')}</p>;
  return (
    <VcConsumerProfilesSection
      canWrite={props.canWrite}
      listenerBotAppId={props.listenerBotAppId}
      listenerBotOptions={props.listenerBotOptions}
    />
  );
}

export function VcConsumerProfilesSection(props: {
  canWrite: boolean;
  /** 全局设置里选的监听 bot；空 = 自动（编辑面回退到第一个候选）。 */
  listenerBotAppId: string | null;
  listenerBotOptions: Array<{ larkAppId: string; botName?: string | null }>;
}) {
  const tr = useT();
  const locale = useDashboardLocale();
  const mountedRef = useRef(false);
  const options = props.listenerBotOptions;
  const [targetBot, setTargetBot] = useState<string>(
    props.listenerBotAppId ?? options[0]?.larkAppId ?? '',
  );
  const [catalog, setCatalog] = useState<CatalogState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<FieldErrorMap>({});
  const [savedTick, setSavedTick] = useState(false);
  const [selectedProfileKey, setSelectedProfileKey] = useState<string | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 单调 load token：只有「最新一次 load」的响应才允许提交状态——
   * A→B 快速切换时，慢 A 响应到达后被丢弃，不会覆盖 B 的 catalog。 */
  const loadSeqRef = useRef(0);

  useEffect(() => {
    // 全局监听 bot 变化时跟随；正在编辑时先保留旧 catalog，允许用户
    // 保存当前修改。保存/清 dirty 后本 effect 会再次运行并收敛到新的
    // listener，避免显式 Listener 模式（无切换下拉）永久卡在旧目标。
    if (props.listenerBotAppId && props.listenerBotAppId !== targetBot && !dirty) {
      setTargetBot(props.listenerBotAppId);
    }
  }, [dirty, props.listenerBotAppId, targetBot]);

  const load = useCallback(async (bot: string) => {
    const token = ++loadSeqRef.current;
    // 切换目标立即清空编辑器：旧 bot 的 catalog 一刻也不能挂在新 target 下。
    setCatalog(null);
    setDirty(false);
    setConflict(false);
    setFieldErrors({});
    setSelectedProfileKey(null);
    setSelectedTemplateId(null);
    if (!bot) {
      setLoadError(null);
      return;
    }
    setLoading(true);
    try {
      const r = await fetch(`/api/vc-meeting/consumer-profiles?listenerBotAppId=${encodeURIComponent(bot)}`);
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current || loadSeqRef.current !== token) return;
      if (!r.ok || body?.ok !== true) {
        setCatalog(null);
        setLoadError(typeof body?.error === 'string' ? body.error : `HTTP ${r.status}`);
      } else {
        setCatalog({
          forBot: bot,
          revision: body.revision,
          catalogState: body.catalogState === 'explicit_empty'
            || body.catalogState === 'legacy_or_partial'
            || body.catalogState === 'profiles'
            ? body.catalogState
            : 'uninitialized',
          defaultMode: body.defaultMode === 'agents' ? 'agents' : 'listenOnly',
          defaultConsumerIds: Array.isArray(body.defaultConsumerIds) ? body.defaultConsumerIds : [],
          profiles: (Array.isArray(body.profiles) ? body.profiles : []).map(toDraft),
          agentOptions: Array.isArray(body.agentOptions) ? body.agentOptions : [],
          templateCatalog: body.templateCatalog?.schemaVersion === 1
            && Array.isArray(body.templateCatalog.templates)
            ? body.templateCatalog
            : { schemaVersion: 1, templates: [] },
          ...(body.migrationOffer === 'enable_seeded_minutes_default'
            ? { migrationOffer: body.migrationOffer }
            : {}),
        });
        setLoadError(null);
        setDirty(false);
      }
    } catch (e) {
      if (!mountedRef.current || loadSeqRef.current !== token) return;
      setCatalog(null);
      setLoadError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current && loadSeqRef.current === token) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(targetBot);
  }, [load, targetBot]);

  const mutate = useCallback((fn: (state: CatalogState) => CatalogState) => {
    setCatalog(current => (current ? fn(current) : current));
    setDirty(true);
    setSavedTick(false);
  }, []);

  const updateProfile = useCallback((uiKey: string, patch: Partial<DraftProfile>) => {
    mutate(state => ({
      ...state,
      profiles: state.profiles.map(profile =>
        profile.uiKey === uiKey ? { ...profile, ...patch } : profile),
    }));
  }, [mutate]);

  const save = useCallback(async () => {
    // 提交目标取 catalog 自己记录的 bot：编辑器里的数据永远只能写回它来自的
    // bot；若与当前下拉不一致（切换中的窗口），直接拒绝。
    if (!catalog || saving || loading || !catalog.forBot || catalog.forBot !== targetBot) return;
    // 客户端预检仅拦截明显格式问题；权威校验在服务端（含 defaultConsumerIds 组合）。
    const localErrors: FieldErrorMap = {};
    catalog.profiles.forEach((profile, index) => {
      if (!PROFILE_ID_RE.test(profile.id)) {
        localErrors[`profiles[${index}].id`] = tr('settings.vcProfiles.idInvalid');
      }
      if ((profile.instructions ?? '').length > INSTRUCTIONS_MAX) {
        localErrors[`profiles[${index}].instructions`] = tr('settings.vcProfiles.instructionsTooLong');
      }
    });
    if (Object.keys(localErrors).length > 0) {
      setFieldErrors(localErrors);
      return;
    }
    setSaving(true);
    setConflict(false);
    setFieldErrors({});
    try {
      const r = await fetch('/api/vc-meeting/consumer-profiles', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          listenerBotAppId: catalog.forBot,
          expectedRevision: catalog.revision,
          defaultMode: catalog.defaultMode,
          defaultConsumerIds: catalog.defaultConsumerIds,
          profiles: catalog.profiles.map(toDto),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current || catalog.forBot !== targetBot) return;
      if (r.status === 409) {
        setConflict(true);
        return;
      }
      if (r.status === 422) {
        const map: FieldErrorMap = {};
        for (const err of Array.isArray(body?.fieldErrors) ? body.fieldErrors : []) {
          if (typeof err?.path === 'string' && typeof err?.message === 'string') {
            map[err.path] = err.message;
          }
        }
        setFieldErrors(Object.keys(map).length > 0
          ? map
          : { profiles: tr('settings.vcProfiles.validationFailed') });
        return;
      }
      if (!r.ok || body?.ok !== true) {
        setFieldErrors({ profiles: typeof body?.error === 'string' ? body.error : `HTTP ${r.status}` });
        return;
      }
      setCatalog({
        forBot: catalog.forBot,
        revision: body.revision,
        catalogState: body.catalogState === 'explicit_empty'
          || body.catalogState === 'legacy_or_partial'
          || body.catalogState === 'profiles'
          ? body.catalogState
          : 'uninitialized',
        defaultMode: body.defaultMode === 'agents' ? 'agents' : 'listenOnly',
        defaultConsumerIds: Array.isArray(body.defaultConsumerIds) ? body.defaultConsumerIds : [],
        profiles: (Array.isArray(body.profiles) ? body.profiles : []).map(toDraft),
        agentOptions: Array.isArray(body.agentOptions) ? body.agentOptions : [],
        templateCatalog: body.templateCatalog?.schemaVersion === 1
          && Array.isArray(body.templateCatalog.templates)
          ? body.templateCatalog
          : { schemaVersion: 1, templates: [] },
        ...(body.migrationOffer === 'enable_seeded_minutes_default'
          ? { migrationOffer: body.migrationOffer }
          : {}),
      });
      setDirty(false);
      setSavedTick(true);
    } catch (e) {
      if (!mountedRef.current) return;
      setFieldErrors({ profiles: e instanceof Error ? e.message : String(e) });
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [catalog, saving, targetBot, tr]);

  const botOptions = useMemo(() => options.map(bot => ({
    value: bot.larkAppId,
    label: bot.botName || bot.larkAppId,
  })), [options]);
  const targetBotLabel = botOptions.find(option => option.value === targetBot)?.label ?? targetBot;

  const agentOptionItems = useMemo(() => {
    if (!catalog) return [];
    return catalog.agentOptions.map((agent) => {
      const warnings = [
        agent.online ? undefined : tr('settings.vcProfiles.agentOffline'),
        agent.workingDirReady ? undefined : tr('settings.vcProfiles.agentNoWorkingDir'),
        agent.reliableTurnTerminal ? undefined : tr('settings.vcProfiles.agentNoReliableTerminal'),
        agent.managedSideEffectIsolation ? undefined : tr('settings.vcProfiles.agentNoManagedIsolation'),
      ].filter(Boolean);
      return {
        value: agent.appId,
        label: (
          <span className="vc-agent-option">
            <span className="vc-agent-option-name">
              {agent.label}
              {agent.cliId ? <em className="vc-agent-option-cli">{agent.cliId}</em> : null}
            </span>
            {warnings.length > 0 ? (
              <span className="vc-agent-option-warn">⚠ {warnings.join(' · ')}</span>
            ) : null}
          </span>
        ),
      };
    });
  }, [catalog, tr]);

  // 触发按钮只放得下一行：显示 agent 名字，有告警时加 ⚠ 前缀提示展开看详情。
  const agentTriggerLabel = (appId: string): ReactNode => {
    const agent = catalog?.agentOptions.find(item => item.appId === appId);
    if (!agent) return appId;
    const warn = !agent.online
      || !agent.workingDirReady
      || !agent.reliableTurnTerminal
      || !agent.managedSideEffectIsolation;
    return warn ? `⚠ ${agent.label}` : agent.label;
  };

  const presetOptions = useCallback((profile: DraftProfile) => {
    const presets: VcMeetingPermissionPreset[] = ['observe_only', 'meeting_text', 'meeting_voice', 'meeting_text_voice'];
    const items = presets.map(preset => ({
      value: preset,
      label: tr(`settings.vcProfiles.preset.${preset}`),
    }));
    if (!profile.isNew || profile.permissionPreset === 'custom') {
      items.push({ value: 'custom', label: tr('settings.vcProfiles.preset.custom') });
    }
    return items;
  }, [tr]);

  const addProfile = useCallback(() => {
    const uiKey = nextUiKey();
    mutate(state => ({
      ...state,
      profiles: [...state.profiles, {
        uiKey,
        isNew: true,
        id: '',
        agentAppId: state.agentOptions[0]?.appId ?? '',
        responseMode: 'silent',
        listenerPlacement: 'auto',
        permissionPreset: 'observe_only',
      }],
    }));
    setSelectedProfileKey(uiKey);
  }, [mutate]);

  const addProfileFromTemplate = useCallback((template: VcMeetingConsumerProfileTemplate) => {
    const uiKey = nextUiKey();
    mutate(state => {
      const usedIds = new Set(state.profiles.map(profile => profile.id));
      let id = template.suggestedProfileId;
      for (let suffix = 2; usedIds.has(id); suffix += 1) {
        id = `${template.suggestedProfileId.slice(0, 60)}-${suffix}`;
      }
      return {
        ...state,
        profiles: [...state.profiles, {
          uiKey,
          isNew: true,
          id,
          label: template.profileLabel[locale],
          agentAppId: state.agentOptions[0]?.appId ?? '',
          instructions: template.instructions[locale],
          activityTypes: [...template.activityTypes],
          responseMode: template.responseMode,
          listenerPlacement: template.listenerPlacement,
          permissionPreset: template.permissionPreset,
        }],
      };
    });
    setSelectedTemplateId(null);
    setSelectedProfileKey(uiKey);
  }, [locale, mutate]);

  const removeProfile = useCallback((uiKey: string) => {
    mutate(state => ({
      ...state,
      profiles: state.profiles.filter(profile => profile.uiKey !== uiKey),
      defaultConsumerIds: state.defaultConsumerIds.filter(id =>
        state.profiles.some(profile => profile.uiKey !== uiKey && profile.id === id)),
    }));
    setSelectedProfileKey(current => current === uiKey ? null : current);
  }, [mutate]);

  if (options.length === 0) return null;

  const err = (path: string): string | undefined => fieldErrors[path];
  // 保存/加载期间冻结全部编辑控件：PUT 用提交时的闭包，成功响应会整份
  // setCatalog + 清 dirty——若允许 pending 窗口内继续编辑，这些修改会被
  // 服务端回包静默覆盖。
  const frozen = !props.canWrite || saving || loading;
  const hasStructurallyEligibleAgent = catalog?.agentOptions.some(
    agent => agent.workingDirReady
      && agent.reliableTurnTerminal
      && agent.managedSideEffectIsolation,
  ) ?? false;
  const selectedProfileIndex = catalog?.profiles.findIndex(profile => profile.uiKey === selectedProfileKey) ?? -1;
  const selectedProfile = selectedProfileIndex >= 0 ? catalog?.profiles[selectedProfileIndex] ?? null : null;
  const selectedTemplate = catalog?.templateCatalog.templates.find(template => template.templateId === selectedTemplateId) ?? null;

  const setProfileDefault = (profile: DraftProfile, enabled: boolean): void => {
    if (!profile.id) return;
    mutate(state => {
      const ids = enabled
        ? [...new Set([...state.defaultConsumerIds, profile.id])]
        : state.defaultConsumerIds.filter(id => id !== profile.id);
      return {
        ...state,
        defaultMode: ids.length > 0 ? 'agents' : 'listenOnly',
        defaultConsumerIds: ids,
      };
    });
  };

  return (
    <div className="vc-profiles-section">
      <div className="settings-field-row">
        <FieldTitle help={tr('settings.vcProfiles.help')}>{tr('settings.vcProfiles.title')}</FieldTitle>
        {props.listenerBotAppId === null && botOptions.length > 1 ? (
          <div className="vc-profile-field">
            <span>{tr('settings.vcProfiles.listenerOwner')}</span>
            <DropdownMenu
              className="settings-field-menu"
              ariaLabel={tr('settings.vcProfiles.listenerOwner')}
              disabled={loading || saving}
              value={targetBot}
              label={dropdownLabel(botOptions, targetBot)}
              options={botOptions}
              onChange={(value) => {
                if (value === targetBot) return;
                if (dirty && !window.confirm(tr('settings.vcProfiles.discardConfirm'))) return;
                setTargetBot(value);
              }}
            />
          </div>
        ) : (
          <span className="vc-profile-config-target">
            {tr('settings.vcProfiles.configuringBot', { bot: targetBotLabel })}
          </span>
        )}
      </div>
      <p className="hint vc-profiles-freeze">{tr('settings.vcProfiles.freezeNotice')}</p>
      {loading ? <p className="hint">{tr('settings.vcProfiles.loading')}</p> : null}
      {loadError ? (
        <p className="hint-warn">
          {loadError === 'bot_not_in_config'
            ? tr('settings.vcProfiles.botNotInConfig')
            : `${tr('settings.vcProfiles.loadFailed')}: ${loadError}`}
        </p>
      ) : null}
      {conflict ? (
        <p className="hint-warn">
          {tr('settings.vcProfiles.conflict')}{' '}
          <button type="button" className="vc-profiles-link" onClick={() => void load(targetBot)}>
            {tr('settings.vcProfiles.reload')}
          </button>
        </p>
      ) : null}
      {err('profiles') ? <p className="hint-warn">{err('profiles')}</p> : null}
      {catalog ? (
        <>
          {catalog.migrationOffer === 'enable_seeded_minutes_default' ? (
            <p className="hint-warn vc-profile-migration-offer">
              {tr('settings.vcProfiles.migrationOffer')}{' '}
              <button
                type="button"
                className="vc-profiles-link"
                disabled={frozen || dirty}
                onClick={() => mutate(state => ({
                  ...state,
                  defaultMode: 'agents',
                  defaultConsumerIds: ['minutes'],
                  profiles: state.profiles.map(profile => profile.id === 'minutes'
                    ? {
                        ...profile,
                        instructions: V2_DEFAULT_MINUTES_INSTRUCTIONS,
                        responseMode: 'listener_thread',
                        permissionPreset: 'meeting_text_voice',
                      }
                    : profile),
                  migrationOffer: undefined,
                }))}
              >
                {tr('settings.vcProfiles.migrationEnable')}
              </button>
            </p>
          ) : null}
          {catalog.catalogState === 'uninitialized'
            && catalog.profiles.length === 0
            && !hasStructurallyEligibleAgent ? (
              <p className="hint-warn">{tr('settings.vcProfiles.noEligibleDefaultAgent')}</p>
            ) : null}
          {catalog.catalogState === 'legacy_or_partial' ? (
            <p className="hint">{tr('settings.vcProfiles.legacyCatalog')}</p>
          ) : null}
          <section className="vc-profile-library-section">
            <div className="vc-profile-list-heading">
              <div>
                <strong>{tr('settings.vcProfiles.list.title')}</strong>
                <p>{tr('settings.vcProfiles.list.help')}</p>
              </div>
              {props.canWrite ? (
                <button type="button" className="vc-profiles-link vc-profile-add" disabled={saving || loading} onClick={addProfile}>
                  {tr('settings.vcProfiles.add')}
                </button>
              ) : null}
            </div>
            {catalog.profiles.length > 0 ? (
              <div className="vc-profile-card-grid">
                {catalog.profiles.map(profile => {
                  const agent = catalog.agentOptions.find(item => item.appId === profile.agentAppId);
                  const isDefault = catalog.defaultMode === 'agents' && catalog.defaultConsumerIds.includes(profile.id);
                  return (
                    <article
                      key={profile.uiKey}
                      className="vc-profile-summary-card"
                      role="button"
                      tabIndex={0}
                      onClick={() => setSelectedProfileKey(profile.uiKey)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          setSelectedProfileKey(profile.uiKey);
                        }
                      }}
                    >
                      <div className="vc-profile-summary-top">
                        <span className="vc-profile-summary-icon" aria-hidden="true">{(profile.label || profile.id || '?').slice(0, 1)}</span>
                        <div>
                          <strong>{profile.label || profile.id || tr('settings.vcProfiles.untitled')}</strong>
                          <code>{profile.id || tr('settings.vcProfiles.newBadge')}</code>
                        </div>
                        {profile.isNew ? <em>{tr('settings.vcProfiles.newBadge')}</em> : null}
                      </div>
                      <p>{(profile.instructions ?? '').trim() || tr('settings.vcProfiles.noInstructions')}</p>
                      <div className="vc-profile-summary-meta">
                        <span>{agent?.label ?? profile.agentAppId}</span>
                        <span>{profile.responseMode === 'listener_thread' ? tr('settings.vcProfiles.responseListener') : tr('settings.vcProfiles.responseSilent')}</span>
                      </div>
                      <label className="vc-profile-default-toggle" onClick={event => event.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={isDefault}
                          disabled={frozen || !profile.id}
                          onChange={event => setProfileDefault(profile, event.currentTarget.checked)}
                        />
                        <span>{tr('settings.vcProfiles.setDefault')}</span>
                      </label>
                    </article>
                  );
                })}
              </div>
            ) : <p className="vc-profile-empty">{tr('settings.vcProfiles.list.empty')}</p>}
          </section>
          {catalog.templateCatalog.templates.length > 0 ? (
            <section className="vc-profile-template-catalog">
              <div className="vc-profile-template-heading">
                <div>
                  <strong>{tr('settings.vcProfiles.templates.title')}</strong>
                  <p>{tr('settings.vcProfiles.templates.help')}</p>
                </div>
                <span>{tr('settings.vcProfiles.templates.builtinBadge')}</span>
              </div>
              <div className="vc-profile-template-grid">
                {catalog.templateCatalog.templates.map(template => (
                  <button
                    type="button"
                    key={`${template.templateId}@${template.version}`}
                    className="vc-profile-template-card"
                    onClick={() => setSelectedTemplateId(template.templateId)}
                  >
                    <span aria-hidden="true">✦</span>
                    <strong>{template.title[locale]}</strong>
                    <p>{template.description[locale]}</p>
                    <em>{tr('settings.vcProfiles.viewDetails')} →</em>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
          <div className="settings-field-row vc-profile-default-mode-row">
            <FieldTitle help={tr('settings.vcProfiles.defaultModeHelp')}>{tr('settings.vcProfiles.defaultMode')}</FieldTitle>
            <DropdownMenu
              className="settings-field-menu"
              ariaLabel={tr('settings.vcProfiles.defaultMode')}
              disabled={frozen}
              value={catalog.defaultMode}
              label={catalog.defaultMode === 'agents'
                ? tr('settings.vcProfiles.defaultModeAgents')
                : tr('settings.vcProfiles.defaultModeListenOnly')}
              options={[
                { value: 'listenOnly', label: tr('settings.vcProfiles.defaultModeListenOnly') },
                { value: 'agents', label: tr('settings.vcProfiles.defaultModeAgents') },
              ]}
              onChange={value => mutate(state => ({
                ...state,
                defaultMode: value === 'agents' ? 'agents' : 'listenOnly',
              }))}
            />
          </div>
          {err('defaultConsumerIds') ? <em className="vc-profile-err">{err('defaultConsumerIds')}</em> : null}
          {err('defaultMode') ? <em className="vc-profile-err">{err('defaultMode')}</em> : null}
          {props.canWrite ? (
            <div className="vc-profiles-actions">
              <button
                type="button"
                className="vc-profiles-save"
                disabled={!dirty || saving || conflict}
                onClick={() => void save()}
              >
                {saving ? tr('settings.vcProfiles.saving') : tr('settings.vcProfiles.save')}
              </button>
              {savedTick ? <span className="vc-profile-hint">{tr('settings.vcProfiles.saved')}</span> : null}
              {dirty && !saving ? <span className="vc-profile-hint">{tr('settings.vcProfiles.unsaved')}</span> : null}
            </div>
          ) : null}
          {selectedProfile ? (
            <ProfileEditorDialog
              profile={selectedProfile}
              index={selectedProfileIndex}
              frozen={frozen}
              canWrite={props.canWrite}
              agentOptions={agentOptionItems}
              agentLabel={agentTriggerLabel(selectedProfile.agentAppId)}
              presetOptions={presetOptions(selectedProfile)}
              error={err}
              onClose={() => setSelectedProfileKey(null)}
              onUpdate={patch => updateProfile(selectedProfile.uiKey, patch)}
              onIdChange={(nextId) => {
                const oldId = selectedProfile.id;
                mutate(state => ({
                  ...state,
                  profiles: state.profiles.map(candidate => candidate.uiKey === selectedProfile.uiKey
                    ? { ...candidate, id: nextId }
                    : candidate),
                  defaultConsumerIds: state.defaultConsumerIds.map(id =>
                    (id === oldId && oldId ? nextId : id)).filter(Boolean),
                }));
              }}
              onRemove={() => removeProfile(selectedProfile.uiKey)}
            />
          ) : null}
          {selectedTemplate ? (
            <TemplateDetailsDialog
              template={selectedTemplate}
              locale={locale}
              disabled={frozen || catalog.agentOptions.length === 0}
              onClose={() => setSelectedTemplateId(null)}
              onUse={() => addProfileFromTemplate(selectedTemplate)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ProfileEditorDialog(props: {
  profile: DraftProfile;
  index: number;
  frozen: boolean;
  canWrite: boolean;
  agentOptions: Array<{ value: string; label: ReactNode }>;
  agentLabel: ReactNode;
  presetOptions: Array<{ value: VcMeetingPermissionPreset; label: string }>;
  error(path: string): string | undefined;
  onClose(): void;
  onUpdate(patch: Partial<DraftProfile>): void;
  onIdChange(value: string): void;
  onRemove(): void;
}): JSX.Element {
  const tr = useT();
  const { profile, index } = props;
  return (
    <VcProfileDialog
      className="vc-profile-editor-dialog"
      eyebrow={tr('settings.vcProfiles.list.title')}
      title={profile.label || profile.id || tr('settings.vcProfiles.untitled')}
      onClose={props.onClose}
    >
      <div className="vc-profile-grid">
        <label className="vc-profile-field">
          <span><FieldHead title={tr('settings.vcProfiles.fieldId')} help={tr('settings.vcProfiles.idHelp')} /></span>
          <input
            type="text"
            value={profile.id}
            disabled={props.frozen || !profile.isNew}
            placeholder="minutes"
            onChange={event => props.onIdChange(event.currentTarget.value)}
          />
          {props.error(`profiles[${index}].id`) ? <em className="vc-profile-err">{props.error(`profiles[${index}].id`)}</em> : null}
        </label>
        <label className="vc-profile-field">
          <span><FieldHead title={tr('settings.vcProfiles.fieldLabel')} help={tr('settings.vcProfiles.labelHelp')} /></span>
          <input
            type="text"
            value={profile.label ?? ''}
            disabled={props.frozen}
            onChange={event => props.onUpdate({ label: event.currentTarget.value || undefined })}
          />
          {props.error(`profiles[${index}].label`) ? <em className="vc-profile-err">{props.error(`profiles[${index}].label`)}</em> : null}
        </label>
        <div className="vc-profile-field">
          <span><FieldHead title={tr('settings.vcProfiles.fieldAgent')} help={tr('settings.vcProfiles.agentHelp')} /></span>
          <DropdownMenu
            className="vc-profile-agent-menu"
            ariaLabel={tr('settings.vcProfiles.fieldAgent')}
            disabled={props.frozen}
            value={profile.agentAppId}
            label={props.agentLabel}
            options={props.agentOptions}
            onChange={value => props.onUpdate({ agentAppId: value })}
          />
          {props.error(`profiles[${index}].agentAppId`) ? <em className="vc-profile-err">{props.error(`profiles[${index}].agentAppId`)}</em> : null}
        </div>
        <div className="vc-profile-field">
          <span><FieldHead title={tr('settings.vcProfiles.fieldResponseMode')} help={tr('settings.vcProfiles.responseModeHelp')} /></span>
          <DropdownMenu
            ariaLabel={tr('settings.vcProfiles.fieldResponseMode')}
            disabled={props.frozen}
            value={profile.responseMode}
            label={profile.responseMode === 'listener_thread' ? tr('settings.vcProfiles.responseListener') : tr('settings.vcProfiles.responseSilent')}
            options={[
              { value: 'silent', label: tr('settings.vcProfiles.responseSilent') },
              { value: 'listener_thread', label: tr('settings.vcProfiles.responseListener') },
            ]}
            onChange={value => props.onUpdate({ responseMode: value as DraftProfile['responseMode'] })}
          />
          {props.error(`profiles[${index}].responseMode`) ? <em className="vc-profile-err">{props.error(`profiles[${index}].responseMode`)}</em> : null}
        </div>
        <div className="vc-profile-field">
          <span><FieldHead title={tr('settings.vcProfiles.fieldListenerPlacement')} help={tr('settings.vcProfiles.listenerPlacementHelp')} /></span>
          <DropdownMenu
            ariaLabel={tr('settings.vcProfiles.fieldListenerPlacement')}
            disabled={props.frozen || profile.responseMode === 'silent'}
            value={profile.listenerPlacement ?? 'auto'}
            label={tr(`settings.vcProfiles.listenerPlacement.${profile.listenerPlacement ?? 'auto'}`)}
            options={['auto', 'chat', 'topic'].map(value => ({ value, label: tr(`settings.vcProfiles.listenerPlacement.${value}`) }))}
            onChange={value => props.onUpdate({ listenerPlacement: value as VcMeetingConsumerProfileDto['listenerPlacement'] })}
          />
          {props.error(`profiles[${index}].listenerPlacement`) ? <em className="vc-profile-err">{props.error(`profiles[${index}].listenerPlacement`)}</em> : null}
        </div>
        <div className="vc-profile-field">
          <span><FieldHead title={tr('settings.vcProfiles.fieldPreset')} help={tr('settings.vcProfiles.presetHelp')} /></span>
          <DropdownMenu
            ariaLabel={tr('settings.vcProfiles.fieldPreset')}
            disabled={props.frozen}
            value={profile.permissionPreset}
            label={dropdownLabel(props.presetOptions, profile.permissionPreset)}
            options={props.presetOptions}
            onChange={value => props.onUpdate({ permissionPreset: value as VcMeetingPermissionPreset })}
          />
          {props.error(`profiles[${index}].permissionPreset`) ? <em className="vc-profile-err">{props.error(`profiles[${index}].permissionPreset`)}</em> : null}
        </div>
      </div>
      <label className="vc-profile-field vc-profile-instructions">
        <span>
          <FieldHead title={tr('settings.vcProfiles.fieldInstructions')} help={tr('settings.vcProfiles.instructionsHelp')} />
          <em className="vc-profile-count">{(profile.instructions ?? '').length}/{INSTRUCTIONS_MAX}</em>
        </span>
        <textarea
          rows={7}
          maxLength={INSTRUCTIONS_MAX}
          value={profile.instructions ?? ''}
          disabled={props.frozen}
          placeholder={tr('settings.vcProfiles.instructionsPlaceholder')}
          onChange={event => props.onUpdate({ instructions: event.currentTarget.value || undefined })}
        />
        {props.error(`profiles[${index}].instructions`) ? <em className="vc-profile-err">{props.error(`profiles[${index}].instructions`)}</em> : null}
      </label>
      <div className="vc-profile-field">
        <span><FieldHead title={tr('settings.vcProfiles.fieldActivityTypes')} help={tr('settings.vcProfiles.activityHelp')} /></span>
        <div className="vc-profile-activity">
          {ACTIVITY_TYPES.map(type => {
            const checked = profile.activityTypes?.includes(type) ?? false;
            return (
              <label key={type} className="vc-profile-check">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={props.frozen}
                  onChange={(event) => {
                    const current = new Set(profile.activityTypes ?? []);
                    if (event.currentTarget.checked) current.add(type);
                    else current.delete(type);
                    props.onUpdate({ activityTypes: current.size > 0 ? [...current] : undefined });
                  }}
                />
                {tr(`settings.vcProfiles.activity.${type}`)}
              </label>
            );
          })}
        </div>
        <em className="vc-profile-hint">{tr('settings.vcProfiles.activityAllHint')}</em>
        {props.error(`profiles[${index}].activityTypes`) ? <em className="vc-profile-err">{props.error(`profiles[${index}].activityTypes`)}</em> : null}
      </div>
      {props.canWrite ? (
        <footer className="vc-profile-dialog-actions">
          <button type="button" className="vc-profiles-link vc-profile-remove" disabled={props.frozen} onClick={props.onRemove}>
            {tr('settings.vcProfiles.remove')}
          </button>
          <button type="button" className="vc-profile-dialog-done" onClick={props.onClose}>{tr('settings.vcProfiles.done')}</button>
        </footer>
      ) : null}
    </VcProfileDialog>
  );
}

function TemplateDetailsDialog(props: {
  template: VcMeetingConsumerProfileTemplate;
  locale: 'zh' | 'en';
  disabled: boolean;
  onClose(): void;
  onUse(): void;
}): JSX.Element {
  const tr = useT();
  const template = props.template;
  return (
    <VcProfileDialog
      className="vc-profile-template-dialog"
      eyebrow={tr('settings.vcProfiles.templates.title')}
      title={template.title[props.locale]}
      onClose={props.onClose}
    >
      <p className="vc-profile-template-description">{template.description[props.locale]}</p>
      <div className="vc-profile-template-facts">
        <div><span>{tr('settings.vcProfiles.fieldResponseMode')}</span><strong>{tr(template.responseMode === 'listener_thread' ? 'settings.vcProfiles.responseListener' : 'settings.vcProfiles.responseSilent')}</strong></div>
        <div><span>{tr('settings.vcProfiles.fieldListenerPlacement')}</span><strong>{tr(`settings.vcProfiles.listenerPlacement.${template.listenerPlacement}`)}</strong></div>
        <div><span>{tr('settings.vcProfiles.fieldPreset')}</span><strong>{tr(`settings.vcProfiles.preset.${template.permissionPreset}`)}</strong></div>
      </div>
      <section className="vc-profile-template-prompt">
        <strong>{tr('settings.vcProfiles.fieldInstructions')}</strong>
        <p>{template.instructions[props.locale]}</p>
      </section>
      <section className="vc-profile-template-events">
        <strong>{tr('settings.vcProfiles.fieldActivityTypes')}</strong>
        <div>{template.activityTypes.map(type => <span key={type}>{tr(`settings.vcProfiles.activity.${type}`)}</span>)}</div>
      </section>
      <footer className="vc-profile-dialog-actions">
        <button type="button" className="vc-profile-dialog-secondary" onClick={props.onClose}>{tr('settings.vcProfiles.close')}</button>
        <button type="button" className="vc-profile-template-use" disabled={props.disabled} onClick={props.onUse}>
          {tr('settings.vcProfiles.templates.use')}
        </button>
      </footer>
    </VcProfileDialog>
  );
}
