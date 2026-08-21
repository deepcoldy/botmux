/**
 * 「会议角色预设」编辑面（settings 页 · 会议 agent 区块内）。
 *
 * 数据面：私有 API GET/PUT /api/vc-meeting/consumer-profiles。
 *
 * 2026-08 起这份预设目录是**全 fleet 共享**的：不再按 bot 分开配置，也不再让用户
 * 手选「会议事件接收 Bot」。预设条目不带执行方——谁被拉进会议就由谁执行；
 * 「哪些 bot 能接会议事件、能不能会中发言」改成下方按 bot 一行的开关。
 *
 * revision 乐观并发：PUT 带 expectedRevision，409 → 提示刷新（不覆盖他人修改）；
 * 422 → fieldErrors 按 `profiles[i].field` / `defaultConsumerIds` 定位到输入项。
 * permissionPreset 是 UI 概念：custom 只对「已保存的同 id 预设」可选（服务端
 * 只允许沿用既有 policy），新预设必须先选一个模板档。
 */
import type React from 'react';
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

type FieldErrorMap = Record<string, string>;

interface DraftProfile extends VcMeetingConsumerProfileDto {
  /** 本地列表 key；与 id 解耦，id 编辑期间列表不重挂载。 */
  uiKey: string;
  /** 尚未保存过的新预设：id 可编辑、custom 档不可选。 */
  isNew: boolean;
}

type OutputPolicyValue = 'allow' | 'approval' | 'deny';

interface BotPolicyDraft {
  appId: string;
  label: string;
  cliId?: string;
  online: boolean;
  /** 结构上能不能真的执行一个会议角色（工作目录 / 可靠回执 / 沙盒可交付）。 */
  workingDirReady: boolean;
  reliableTurnTerminal: boolean;
  managedSideEffectEligible: boolean;
  sandboxIsolated: boolean;
  /** apiOnly（无飞书连接）→ 结构上收不到会议事件，开关禁用。 */
  vcEligible: boolean;
  vcEnabled: boolean;
  textOutputPolicy: OutputPolicyValue | null;
  voiceOutputPolicy: OutputPolicyValue | null;
  realtimeVoiceEnabled: boolean;
  /** per-bot 从共享目录挑的默认角色 id；null = 跟随全局默认。 */
  catalogDefaultConsumerId: string | null;
  /** Serialized loaded state — save only submits rows whose current values differ. */
  baseline: string;
}

function policyBaseline(
  vcEnabled: boolean,
  text: OutputPolicyValue | null,
  voice: OutputPolicyValue | null,
  rtv: boolean,
  catalogDefaultConsumerId: string | null,
): string {
  return `${vcEnabled ? '1' : '0'}|${text ?? ''}|${voice ?? ''}|${rtv ? '1' : '0'}|${catalogDefaultConsumerId ?? ''}`;
}

function rowBaseline(row: BotPolicyDraft): string {
  return policyBaseline(row.vcEnabled, row.textOutputPolicy, row.voiceOutputPolicy, row.realtimeVoiceEnabled, row.catalogDefaultConsumerId);
}

function toBotPolicyDrafts(agentOptions: VcMeetingAgentOptionDto[]): BotPolicyDraft[] {
  return agentOptions.map(agent => {
    const text = agent.textOutputPolicy ?? null;
    const voice = agent.voiceOutputPolicy ?? null;
    const rtv = agent.realtimeVoiceEnabled === true;
    const catalogDefaultConsumerId = agent.catalogDefaultConsumerId ?? null;
    const vcEligible = agent.vcEligible !== false;
    const vcEnabled = vcEligible && agent.vcEnabled !== false;
    return {
      appId: agent.appId,
      label: agent.label || agent.appId,
      ...(agent.cliId ? { cliId: agent.cliId } : {}),
      online: agent.online,
      workingDirReady: agent.workingDirReady,
      reliableTurnTerminal: agent.reliableTurnTerminal,
      managedSideEffectEligible: agent.managedSideEffectEligible,
      sandboxIsolated: agent.sandboxIsolated,
      vcEligible,
      vcEnabled,
      textOutputPolicy: text,
      voiceOutputPolicy: voice,
      realtimeVoiceEnabled: rtv,
      catalogDefaultConsumerId,
      baseline: policyBaseline(vcEnabled, text, voice, rtv, catalogDefaultConsumerId),
    };
  });
}

interface CatalogState {
  revision: string;
  catalogState: 'uninitialized' | 'explicit_empty' | 'profiles';
  defaultMode: 'listenOnly' | 'agents';
  defaultConsumerIds: string[];
  profiles: DraftProfile[];
  agentOptions: VcMeetingAgentOptionDto[];
  botPolicies: BotPolicyDraft[];
  templateCatalog: VcMeetingConsumerProfileTemplateCatalog;
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

/**
 * 一个 bot 只有同时满足「有工作目录 + CLI 支持可靠回执 + 显式沙盒请求在本平台/
 * 后端可交付」才真的能执行一个会议角色。离线是暂态、未开沙盒是知情选择，都不算
 * 结构性阻塞。预设本身与 bot 解耦，所以这个判定只用来在按 bot 那张表上给出提示
 * ——不再拦着用户编辑预设。
 */
function isAgentSelectable(agent: {
  workingDirReady: boolean;
  reliableTurnTerminal: boolean;
  managedSideEffectEligible: boolean;
}): boolean {
  return agent.workingDirReady
    && agent.reliableTurnTerminal
    && agent.managedSideEffectEligible;
}

/** 字段标题 + hover 帮助气泡：把配置语义讲清，避免用户对着裸表单猜。 */
function FieldHead(props: { title: string; help: string }): React.JSX.Element {
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
}): React.JSX.Element {
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

/** settings 页挂载门：预设 API 是私有端点，公共只读访客请求必 401——
 * canWrite=false 时完全不挂载编辑器（一次 GET 都不发），只显示提示。 */
export function VcConsumerProfilesGate(props: {
  enabled: boolean;
  canWrite: boolean;
  onFeishuLoginQr?: (qr: string | null) => void;
}) {
  const tr = useT();
  if (!props.enabled) return null;
  if (!props.canWrite) return <p className="hint">{tr('settings.vcProfiles.needAuth')}</p>;
  return <VcConsumerProfilesSection canWrite={props.canWrite} onFeishuLoginQr={props.onFeishuLoginQr} />;
}

export function VcConsumerProfilesSection(props: {
  canWrite: boolean;
  onFeishuLoginQr?: (qr: string | null) => void;
}) {
  const tr = useT();
  const locale = useDashboardLocale();
  const mountedRef = useRef(false);
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
  /** 正在跑开放平台前置配置的 bot（一次只允许一个：automateOpenPlatformSetup 共用
   *  同一份开放平台会话，并发跑会互相抢 csrf/session）。 */
  const [preflightBusyAppId, setPreflightBusyAppId] = useState<string | null>(null);
  const [preflightResults, setPreflightResults] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [botPolicyQuery, setBotPolicyQuery] = useState('');

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  /** 单调 load token：只有「最新一次 load」的响应才允许提交状态——重复点刷新时，
   * 慢响应到达后被丢弃，不会覆盖新响应。 */
  const loadSeqRef = useRef(0);

  const load = useCallback(async () => {
    const token = ++loadSeqRef.current;
    setDirty(false);
    setConflict(false);
    setFieldErrors({});
    setSelectedProfileKey(null);
    setSelectedTemplateId(null);
    setLoading(true);
    try {
      const r = await fetch('/api/vc-meeting/consumer-profiles');
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current || loadSeqRef.current !== token) return;
      if (!r.ok || body?.ok !== true) {
        setCatalog(null);
        setLoadError(typeof body?.error === 'string' ? body.error : `HTTP ${r.status}`);
      } else {
        setCatalog(catalogFromBody(body));
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
    void load();
  }, [load]);

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
    if (!catalog || saving || loading) return;
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
          expectedRevision: catalog.revision,
          defaultMode: catalog.defaultMode,
          defaultConsumerIds: catalog.defaultConsumerIds,
          profiles: catalog.profiles.map(toDto),
          botOutputPolicies: catalog.botPolicies
            .filter(row => rowBaseline(row) !== row.baseline)
            .map(row => ({
              appId: row.appId,
              vcEnabled: row.vcEnabled,
              textOutputPolicy: row.textOutputPolicy,
              voiceOutputPolicy: row.voiceOutputPolicy,
              realtimeVoiceEnabled: row.realtimeVoiceEnabled,
              catalogDefaultConsumerId: row.catalogDefaultConsumerId,
            })),
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current) return;
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
      setCatalog(catalogFromBody(body));
      setDirty(false);
      setSavedTick(true);
    } catch (e) {
      if (!mountedRef.current) return;
      setFieldErrors({ profiles: e instanceof Error ? e.message : String(e) });
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [catalog, loading, saving, tr]);

  const updateBotPolicy = useCallback((
    appId: string,
    patch: Partial<Pick<BotPolicyDraft, 'vcEnabled' | 'textOutputPolicy' | 'voiceOutputPolicy' | 'realtimeVoiceEnabled' | 'catalogDefaultConsumerId'>>,
  ) => {
    setCatalog(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        botPolicies: prev.botPolicies.map(row => (row.appId === appId ? { ...row, ...patch } : row)),
      };
    });
    setDirty(true);
    setSavedTick(false);
  }, []);

  /** 「配置权限」：给这个 bot 开 VC scope、订阅会议事件、补 larkCliProfile。
   *  刻意不在成功后 reload——preflight 写的是 bots.json，与预设草稿无关，reload 会
   *  把用户还没保存的策略编辑一起冲掉。 */
  const runPreflight = useCallback(async (appId: string) => {
    if (preflightBusyAppId) return;
    setPreflightBusyAppId(appId);
    setPreflightResults(prev => ({ ...prev, [appId]: { ok: true, text: tr('settings.vcProfiles.botPolicies.preflightRunning') } }));
    try {
      const r = await fetch('/api/vc-meeting/bot-preflight', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ appId }),
      });
      const body = await r.json().catch(() => ({}));
      if (!mountedRef.current) return;
      if (r.ok && body?.ok === true) {
        props.onFeishuLoginQr?.(null);
        setPreflightResults(prev => ({ ...prev, [appId]: { ok: true, text: tr('settings.vcProfiles.botPolicies.preflightOk') } }));
        return;
      }
      if (typeof body?.feishuLoginQr === 'string' && body.feishuLoginQr) {
        props.onFeishuLoginQr?.(body.feishuLoginQr);
      }
      setPreflightResults(prev => ({
        ...prev,
        [appId]: { ok: false, text: typeof body?.error === 'string' ? body.error : `HTTP ${r.status}` },
      }));
    } catch (e) {
      if (!mountedRef.current) return;
      setPreflightResults(prev => ({
        ...prev,
        [appId]: { ok: false, text: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      if (mountedRef.current) setPreflightBusyAppId(null);
    }
  }, [preflightBusyAppId, props, tr]);

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
    mutate((state) => {
      const defaultConsumerIds = state.defaultConsumerIds.filter(id =>
        state.profiles.some(profile => profile.uiKey !== uiKey && profile.id === id));
      return {
        ...state,
        profiles: state.profiles.filter(profile => profile.uiKey !== uiKey),
        defaultConsumerIds,
        // 删掉的正是那条默认角色时，必须一并退回「仅监听」：agents + 空 ids 是
        // 服务端明确拒绝的组合，留着会让用户在保存时才吃到一个 422。
        defaultMode: defaultConsumerIds.length > 0 ? state.defaultMode : 'listenOnly',
      };
    });
    setSelectedProfileKey(current => current === uiKey ? null : current);
  }, [mutate]);

  const sortedBotPolicies = useMemo(() => {
    if (!catalog) return [];
    const q = botPolicyQuery.trim().toLowerCase();
    const rows = q
      ? catalog.botPolicies.filter(row =>
          row.label.toLowerCase().includes(q) || row.appId.toLowerCase().includes(q))
      : catalog.botPolicies;
    return [...rows].sort((a, b) => {
      if (a.vcEnabled !== b.vcEnabled) return a.vcEnabled ? -1 : 1;
      if (a.online !== b.online) return a.online ? -1 : 1;
      return a.label.localeCompare(b.label);
    });
  }, [catalog, botPolicyQuery]);

  const err = (path: string): string | undefined => fieldErrors[path];
  // 保存/加载期间冻结全部编辑控件：PUT 用提交时的闭包，成功响应会整份
  // setCatalog + 清 dirty——若允许 pending 窗口内继续编辑，这些修改会被
  // 服务端回包静默覆盖。
  const frozen = !props.canWrite || saving || loading;
  const hasStructurallyEligibleAgent = catalog?.agentOptions.some(isAgentSelectable) ?? false;
  const selectedProfileIndex = catalog?.profiles.findIndex(profile => profile.uiKey === selectedProfileKey) ?? -1;
  const selectedProfile = selectedProfileIndex >= 0 ? catalog?.profiles[selectedProfileIndex] ?? null : null;
  const selectedTemplate = catalog?.templateCatalog.templates.find(template => template.templateId === selectedTemplateId) ?? null;

  /** 默认角色是单选：一个 bot 进会后只跑一个角色（服务端也这么校验），
   *  再点一次已选中的那个即取消，回到「仅监听」。 */
  const setProfileDefault = (profile: DraftProfile): void => {
    if (!profile.id) return;
    mutate(state => {
      const already = state.defaultConsumerIds.length === 1 && state.defaultConsumerIds[0] === profile.id;
      const ids = already ? [] : [profile.id];
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
      </div>
      <p className="hint vc-profiles-shared">{tr('settings.vcProfiles.sharedNotice')}</p>
      <p className="hint vc-profiles-freeze">{tr('settings.vcProfiles.freezeNotice')}</p>
      {loading ? <p className="hint">{tr('settings.vcProfiles.loading')}</p> : null}
      {loadError ? (
        <p className="hint-warn">{tr('settings.vcProfiles.loadFailed')}: {loadError}</p>
      ) : null}
      {conflict ? (
        <p className="hint-warn">
          {tr('settings.vcProfiles.conflict')}{' '}
          <button type="button" className="vc-profiles-link" onClick={() => void load()}>
            {tr('settings.vcProfiles.reload')}
          </button>
        </p>
      ) : null}
      {err('profiles') ? <p className="hint-warn">{err('profiles')}</p> : null}
      {catalog ? (
        <>
          {!hasStructurallyEligibleAgent ? (
            <p className="hint-warn">{tr('settings.vcProfiles.noEligibleDefaultAgent')}</p>
          ) : null}
          <section className="vc-profile-library-section">
            <div className="vc-profile-list-heading">
              <div>
                <strong>{tr('settings.vcProfiles.list.title')}</strong>
                <p>{tr('settings.vcProfiles.list.help')}</p>
              </div>
              {props.canWrite ? (
                <button
                  type="button"
                  className="vc-profiles-link vc-profile-add"
                  disabled={saving || loading}
                  onClick={addProfile}
                >
                  {tr('settings.vcProfiles.add')}
                </button>
              ) : null}
            </div>
            {catalog.profiles.length > 0 ? (
              <div className="vc-profile-card-grid">
                {catalog.profiles.map(profile => {
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
                        <span>{profile.responseMode === 'listener_thread' ? tr('settings.vcProfiles.responseListener') : tr('settings.vcProfiles.responseSilent')}</span>
                        <span>{tr(`settings.vcProfiles.preset.${profile.permissionPreset}`)}</span>
                      </div>
                      <label className="vc-profile-default-toggle" onClick={event => event.stopPropagation()}>
                        <input
                          type="radio"
                          name="vc-profile-default"
                          checked={isDefault}
                          disabled={frozen || !profile.id}
                          onChange={() => setProfileDefault(profile)}
                          onClick={() => { if (isDefault) setProfileDefault(profile); }}
                        />
                        <span>{tr('settings.vcProfiles.setDefault')}</span>
                      </label>
                    </article>
                  );
                })}
              </div>
            ) : <p className="vc-profile-empty">{tr('settings.vcProfiles.list.empty')}</p>}
            <p className="hint vc-profile-default-single">{tr('settings.vcProfiles.defaultSingleHint')}</p>
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
          <section className="vc-profile-library-section vc-bot-policy-section">
            <div className="vc-profile-list-heading">
              <div>
                <strong>{tr('settings.vcProfiles.botPolicies.title')}</strong>
                <p>{tr('settings.vcProfiles.botPolicies.help')}</p>
              </div>
              <input
                type="search"
                className="vc-bot-policy-search"
                placeholder={tr('settings.vcProfiles.botPolicies.searchPlaceholder')}
                value={botPolicyQuery}
                disabled={frozen}
                onChange={(event) => setBotPolicyQuery(event.target.value)}
              />
            </div>
            <div className="vc-bot-policy-table" style={{ maxHeight: 320, overflowY: 'auto' }}>
              {sortedBotPolicies.length === 0 ? (
                <p className="vc-bot-policy-empty hint">{tr('settings.vcProfiles.botPolicies.noMatch')}</p>
              ) : null}
              {sortedBotPolicies.map(row => {
                const effectiveText = row.textOutputPolicy ?? 'allow';
                const effectiveVoice = !row.realtimeVoiceEnabled ? 'deny' : (row.voiceOutputPolicy ?? 'allow');
                const policyLabel = (value: OutputPolicyValue): string => tr(`settings.vcProfiles.botPolicies.${value}`);
                // 只在这里提示能力缺口：预设与 bot 解耦后，这张表是唯一能解释
                // 「为什么拉这个 bot 进会没反应」的地方。逐条文案很长(尤其沙盒那条),
                // 一行 bot 后面平铺会喧宾夺主——收成一个 ⚠,详情放 hover title。
                const warnings = [
                  row.vcEligible ? undefined : tr('settings.vcProfiles.botPolicies.vcIneligible'),
                  row.online ? undefined : tr('settings.vcProfiles.agentOffline'),
                  row.workingDirReady ? undefined : tr('settings.vcProfiles.agentNoWorkingDir'),
                  row.reliableTurnTerminal ? undefined : tr('settings.vcProfiles.agentNoReliableTerminal'),
                  row.managedSideEffectEligible ? undefined : tr('settings.vcProfiles.agentNoManagedIsolation'),
                  row.managedSideEffectEligible && !row.sandboxIsolated
                    ? tr('settings.vcProfiles.agentUnsandboxedRisk')
                    : undefined,
                ].filter((w): w is string => !!w);
                const rowFrozen = !props.canWrite || saving || loading;
                const renderSelect = (
                  field: 'textOutputPolicy' | 'voiceOutputPolicy',
                  value: OutputPolicyValue | null,
                ): React.JSX.Element => (
                  <select
                    className="vc-bot-policy-select"
                    value={value ?? 'default'}
                    disabled={rowFrozen || !row.vcEnabled}
                    onChange={(event) => {
                      const raw = event.target.value;
                      updateBotPolicy(row.appId, {
                        [field]: raw === 'default' ? null : (raw as OutputPolicyValue),
                      });
                    }}
                  >
                    <option value="default">{tr('settings.vcProfiles.botPolicies.default')}</option>
                    <option value="allow">{policyLabel('allow')}</option>
                    <option value="approval">{policyLabel('approval')}</option>
                    <option value="deny">{policyLabel('deny')}</option>
                  </select>
                );
                const preflight = preflightResults[row.appId];
                return (
                  <div key={row.appId} className="vc-bot-policy-row">
                    <span className="vc-bot-policy-name" title={row.appId}>
                      {row.online ? '' : '⚪ '}{row.label}
                      {warnings.length > 0 ? (
                        <InfoTip
                          className="vc-bot-policy-warn-tip"
                          label={warnings.join(' · ')}
                          trigger={<em className="vc-bot-policy-warn" aria-hidden="true">⚠</em>}
                        >
                          <span className="vc-bot-policy-warn-pop">
                            {warnings.map((w, i) => <div key={i}>{w}</div>)}
                          </span>
                        </InfoTip>
                      ) : null}
                      {preflight ? (
                        <em className={preflight.ok ? 'vc-bot-policy-preflight' : 'vc-bot-policy-warn'}>
                          {preflight.text}
                        </em>
                      ) : null}
                    </span>
                    <label className="vc-bot-policy-cell vc-bot-policy-enabled">
                      <input
                        type="checkbox"
                        checked={row.vcEnabled}
                        disabled={rowFrozen || !row.vcEligible}
                        onChange={(event) => updateBotPolicy(row.appId, { vcEnabled: event.target.checked })}
                      />
                      <span>{tr('settings.vcProfiles.botPolicies.vcEnabled')}</span>
                    </label>
                    <label className="vc-bot-policy-cell">
                      <span>{tr('settings.vcProfiles.botPolicies.defaultProfile')}</span>
                      <select
                        className="vc-bot-policy-select"
                        value={row.catalogDefaultConsumerId ?? ''}
                        disabled={rowFrozen || !row.vcEnabled}
                        onChange={(event) => {
                          const raw = event.target.value;
                          updateBotPolicy(row.appId, { catalogDefaultConsumerId: raw === '' ? null : raw });
                        }}
                      >
                        <option value="">{tr('settings.vcProfiles.botPolicies.defaultProfileFollowGlobal')}</option>
                        {catalog.profiles.map(profile => (
                          <option key={profile.id} value={profile.id}>{profile.label || profile.id}</option>
                        ))}
                      </select>
                    </label>
                    <label className="vc-bot-policy-cell">
                      <span>{tr('settings.vcProfiles.botPolicies.text')}</span>
                      {renderSelect('textOutputPolicy', row.textOutputPolicy)}
                    </label>
                    <label className="vc-bot-policy-cell">
                      <span>{tr('settings.vcProfiles.botPolicies.voice')}</span>
                      {renderSelect('voiceOutputPolicy', row.voiceOutputPolicy)}
                    </label>
                    <label className="vc-bot-policy-cell vc-bot-policy-rtv">
                      <input
                        type="checkbox"
                        checked={row.realtimeVoiceEnabled}
                        disabled={rowFrozen || !row.vcEnabled}
                        onChange={(event) => updateBotPolicy(row.appId, { realtimeVoiceEnabled: event.target.checked })}
                      />
                      <span>{tr('settings.vcProfiles.botPolicies.realtimeVoice')}</span>
                    </label>
                    <span className="vc-bot-policy-effective hint">
                      {tr('settings.vcProfiles.botPolicies.effective')}
                      {' '}{row.vcEnabled
                        ? `${policyLabel(effectiveText)} / ${policyLabel(effectiveVoice)}`
                        : tr('settings.vcProfiles.botPolicies.vcOff')}
                    </span>
                    <button
                      type="button"
                      className="bd-btn bd-btn-ghost vc-bot-policy-preflight-btn"
                      disabled={!props.canWrite || !row.vcEligible || preflightBusyAppId !== null}
                      title={tr('settings.vcProfiles.botPolicies.preflightHelp')}
                      onClick={() => void runPreflight(row.appId)}
                    >
                      {preflightBusyAppId === row.appId
                        ? tr('settings.vcProfiles.botPolicies.preflightRunning')
                        : tr('settings.vcProfiles.botPolicies.preflight')}
                    </button>
                  </div>
                );
              })}
            </div>
          </section>
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
              presetOptions={presetOptions(selectedProfile)}
              error={err}
              onClose={() => setSelectedProfileKey(null)}
              onUpdate={patch => updateProfile(selectedProfile.uiKey, patch)}
              onIdChange={(nextId) => {
                const oldId = selectedProfile.id;
                mutate((state) => {
                  const defaultConsumerIds = state.defaultConsumerIds.map(id =>
                    (id === oldId && oldId ? nextId : id)).filter(Boolean);
                  return {
                    ...state,
                    profiles: state.profiles.map(candidate => candidate.uiKey === selectedProfile.uiKey
                      ? { ...candidate, id: nextId }
                      : candidate),
                    defaultConsumerIds,
                    // 清空 id 会让默认角色随之消失；同上，不能留下 agents + 空 ids。
                    defaultMode: defaultConsumerIds.length > 0 ? state.defaultMode : 'listenOnly',
                  };
                });
              }}
              onRemove={() => removeProfile(selectedProfile.uiKey)}
            />
          ) : null}
          {selectedTemplate ? (
            <TemplateDetailsDialog
              template={selectedTemplate}
              locale={locale}
              disabled={frozen}
              onClose={() => setSelectedTemplateId(null)}
              onUse={() => addProfileFromTemplate(selectedTemplate)}
            />
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function catalogFromBody(body: Record<string, unknown> & { [key: string]: any }): CatalogState {
  const agentOptions: VcMeetingAgentOptionDto[] = Array.isArray(body.agentOptions) ? body.agentOptions : [];
  return {
    revision: body.revision,
    catalogState: body.catalogState === 'explicit_empty' || body.catalogState === 'profiles'
      ? body.catalogState
      : 'uninitialized',
    defaultMode: body.defaultMode === 'agents' ? 'agents' : 'listenOnly',
    defaultConsumerIds: Array.isArray(body.defaultConsumerIds) ? body.defaultConsumerIds : [],
    profiles: (Array.isArray(body.profiles) ? body.profiles : []).map(toDraft),
    agentOptions,
    botPolicies: toBotPolicyDrafts(agentOptions),
    templateCatalog: body.templateCatalog?.schemaVersion === 1
      && Array.isArray(body.templateCatalog.templates)
      ? body.templateCatalog
      : { schemaVersion: 1, templates: [] },
  };
}

function ProfileEditorDialog(props: {
  profile: DraftProfile;
  index: number;
  frozen: boolean;
  canWrite: boolean;
  presetOptions: Array<{ value: VcMeetingPermissionPreset; label: string }>;
  error(path: string): string | undefined;
  onClose(): void;
  onUpdate(patch: Partial<DraftProfile>): void;
  onIdChange(value: string): void;
  onRemove(): void;
}): React.JSX.Element {
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
}): React.JSX.Element {
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
