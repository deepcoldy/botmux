import { createDashboardTranslator } from './i18n.js';
import { NAV_ITEMS } from './nav-items.js';

export type WorkspaceMode = 'focused' | 'all';
export type WorkspacePresetId = 'minimal' | 'oncall' | 'multi-agent' | 'builder';
export type CapabilityCategoryId = 'automation' | 'collaboration' | 'extensions' | 'observability';

export interface WorkspacePersonalizationState {
  mode: WorkspaceMode;
  pinnedIds: string[];
  dismissedAutoIds: string[];
  dismissedGuideIds: string[];
}

export interface CapabilityDescriptor {
  id: string;
  category: CapabilityCategoryId;
  summaryKey: string;
  guideKey: string;
  guideActionLabelKey?: string;
  guideActionHref?: string;
  keywords: readonly string[];
}

export interface WorkspacePreset {
  id: WorkspacePresetId;
  labelKey: string;
  descKey: string;
  pinnedIds: readonly string[];
}

export const WORKSPACE_PERSONALIZATION_STORAGE_KEY = 'botmux.workspace.personalization.v1';
export const DEFAULT_WORKSPACE_MODE: WorkspaceMode = 'all';
export const CORE_NAV_IDS: readonly string[] = ['overview', 'sessions', 'groups', 'bot-defaults', 'settings'];

function preset(id: WorkspacePresetId, pinnedIds: readonly string[]): WorkspacePreset {
  return { id, labelKey: `workspace.preset.${id}.name`, descKey: `workspace.preset.${id}.desc`, pinnedIds };
}

export const WORKSPACE_PRESETS: readonly WorkspacePreset[] = [
  preset('minimal', []),
  preset('oncall', ['schedules', 'message-listeners', 'monitoring']),
  preset('multi-agent', ['agent-workbench', 'workflows', 'roles', 'decision-board', 'task-routing']),
  preset('builder', ['skills', 'customization', 'plugins', 'connectors', 'terminal']),
];

function capability(
  category: CapabilityCategoryId,
  id: string,
  keywords: readonly string[],
  guideActionHref?: string,
): CapabilityDescriptor {
  const key = `workspace.cap.${id}`;
  return {
    id, category, summaryKey: `${key}.summary`, guideKey: `${key}.guide`, keywords,
    ...(guideActionHref ? { guideActionLabelKey: `${key}.action`, guideActionHref } : {}),
  };
}

export const CAPABILITY_CATALOG: readonly CapabilityDescriptor[] = [
  capability('automation', 'schedules', ['定时', '日报', '提醒', 'cron', 'recurring', 'reminder', 'daily report']),
  capability('automation', 'message-listeners', ['告警', '消息触发', '关键词', 'alert', 'trigger', 'message rules']),
  capability('automation', 'doc-watches', ['文档', '评论', 'document', 'comment', 'watch']),
  capability('automation', 'workflows', ['编排', '审批流程', 'automation', 'pipeline', 'orchestration']),
  capability('automation', 'connectors', ['外部系统', '回调', 'webhook', 'integration', 'callback']),
  capability('collaboration', 'agent-workbench', ['驾驶舱', '并行会话', 'cockpit', 'parallel', 'agent workspace']),
  capability('collaboration', 'roles', ['分工', '角色模板', 'role profiles', 'persona']),
  capability('collaboration', 'decision-board', ['管家', '拍板', '待决策', 'steward', 'approvals', 'decisions']),
  capability('collaboration', 'task-routing', ['派活', '分配任务', '派单', 'assign', 'delegate', 'routing'], '#/settings?section=settings-task-routing'),
  capability('collaboration', 'agents', ['智能体', '团队', 'bot roster', 'team']),
  capability('collaboration', 'whiteboards', ['画布', '流程图', 'diagram', 'canvas']),
  capability('extensions', 'skills', ['技能', '指令', '安装', 'skill', 'install']),
  capability('extensions', 'customization', ['提示词', '命令', 'prompt', 'slash command']),
  capability('extensions', 'plugins', ['插件', '扩展', 'plugin', 'extension']),
  capability('extensions', 'terminal', ['命令行', '宿主', 'shell', 'tmux', 'command line']),
  capability('observability', 'monitoring', ['告警', '值班', '健康', 'alert', 'health', 'on-call', 'status'], '#/monitor-room'),
  capability('observability', 'insights', ['趋势', '数据', '报表', 'analytics', 'trend', 'report']),
  capability('observability', 'usage', ['消耗', '成本', '账单', 'token', 'cost', 'billing']),
  capability('observability', 'feedback', ['问题', '建议', '评价', 'rating', 'suggestion', 'issue']),
];

const capabilityIds = new Set(CAPABILITY_CATALOG.map(({ id }) => id));
const autoCapabilityIds = new Set(['schedules', 'decision-board', 'task-routing']);
const navById = new Map(NAV_ITEMS.map(item => [item.id, item]));
const zh = createDashboardTranslator('zh');
const en = createDashboardTranslator('en');

type WorkspaceStorage = Pick<Storage, 'getItem' | 'setItem'>;

function validIds(ids: readonly unknown[]): string[] {
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && capabilityIds.has(id)))];
}

function normalizeState(state: WorkspacePersonalizationState): WorkspacePersonalizationState {
  return {
    mode: state.mode,
    pinnedIds: validIds(state.pinnedIds),
    dismissedAutoIds: validIds(state.dismissedAutoIds),
    dismissedGuideIds: validIds(state.dismissedGuideIds),
  };
}

function defaultWorkspacePersonalization(): WorkspacePersonalizationState {
  return { mode: DEFAULT_WORKSPACE_MODE, pinnedIds: [], dismissedAutoIds: [], dismissedGuideIds: [] };
}

interface WorkspacePersonalizationSnapshot {
  state: WorkspacePersonalizationState;
  raw: string | null;
}

function readWorkspacePersonalizationSnapshot(storage?: WorkspaceStorage): WorkspacePersonalizationSnapshot | undefined {
  let raw: string | null;
  try {
    const source = storage ?? globalThis.localStorage;
    if (!source) return undefined;
    raw = source.getItem(WORKSPACE_PERSONALIZATION_STORAGE_KEY);
  } catch {
    return undefined;
  }

  try {
    const state = JSON.parse(raw ?? 'null');
    if (
      (state?.mode === 'focused' || state?.mode === 'all') &&
      Array.isArray(state.pinnedIds) && Array.isArray(state.dismissedAutoIds) &&
      Array.isArray(state.dismissedGuideIds)
    ) return { state: normalizeState(state), raw };
  } catch { /* Invalid JSON starts with the default preferences. */ }
  return { state: defaultWorkspacePersonalization(), raw };
}

export function loadWorkspacePersonalization(storage?: WorkspaceStorage): WorkspacePersonalizationState {
  return readWorkspacePersonalizationSnapshot(storage)?.state ?? defaultWorkspacePersonalization();
}

function serializeWorkspacePersonalization(state: WorkspacePersonalizationState): string {
  return JSON.stringify(normalizeState(state));
}

export function saveWorkspacePersonalization(state: WorkspacePersonalizationState, storage?: WorkspaceStorage): boolean {
  try {
    const target = storage ?? globalThis.localStorage;
    if (!target) return false;
    target.setItem(WORKSPACE_PERSONALIZATION_STORAGE_KEY, serializeWorkspacePersonalization(state));
    return true;
  } catch {
    return false;
  }
}

export type WorkspacePersonalizationUpdateOptions =
  | {
    /**
     * `same-snapshot` (default): destructive edit; a newer saved snapshot wins.
     * `always`: independent set-union edit, such as dismissing a guide.
     */
    replay?: 'always' | 'same-snapshot';
    capabilityId?: never;
  }
  | {
    /** Merge only if the other tab did not change this capability's pin/dismissal. */
    replay: 'pin';
    capabilityId: string;
  };

export type WorkspacePersonalizationUpdater = (
  edit: (state: WorkspacePersonalizationState) => WorkspacePersonalizationState,
  options?: WorkspacePersonalizationUpdateOptions,
) => void;

export function createWorkspacePersonalizationStore(storage?: WorkspaceStorage) {
  type Edit = (state: WorkspacePersonalizationState) => WorkspacePersonalizationState;
  type PendingEdit = {
    edit: Edit;
    baseRaw: string | null | undefined;
    baseState: WorkspacePersonalizationState;
    replay: NonNullable<WorkspacePersonalizationUpdateOptions['replay']>;
    capabilityId?: string;
    preserveModeOnReplay: boolean;
  };
  const initial = readWorkspacePersonalizationSnapshot(storage);
  let current = initial?.state ?? defaultWorkspacePersonalization();
  let observedRaw = initial?.raw;
  const pending: PendingEdit[] = [];

  function rebasePending(saved: WorkspacePersonalizationSnapshot): void {
    // Edits before the first conflicting destructive operation cannot depend on its intermediate
    // state, so keep them. Drop that operation and later state edits, but retain independent guides.
    const firstConflict = pending.findIndex(queued =>
      queued.replay === 'same-snapshot' && queued.baseRaw !== saved.raw
    );
    const replayable = pending.filter((queued, index) =>
      queued.replay === 'always' || firstConflict === -1 || index < firstConflict
    );

    const retained: PendingEdit[] = [];
    current = saved.state;
    for (const queued of replayable) {
      if (queued.replay === 'same-snapshot') {
        current = queued.edit(current);
      } else if (queued.replay === 'pin') {
        const id = queued.capabilityId!;
        if (queued.baseRaw !== saved.raw) {
          const basePinned = queued.baseState.pinnedIds.includes(id);
          const savedPinned = saved.state.pinnedIds.includes(id);
          const baseDismissed = queued.baseState.dismissedAutoIds.includes(id);
          const savedDismissed = saved.state.dismissedAutoIds.includes(id);
          // A newer pin/unpin/hide of the same capability wins over this older pending pin.
          if (basePinned !== savedPinned || baseDismissed !== savedDismissed) continue;
          queued.preserveModeOnReplay = true;
        }
        const rebasedMode = current.mode;
        current = queued.edit(current);
        if (queued.preserveModeOnReplay) current = { ...current, mode: rebasedMode };
      } else {
        current = queued.edit(current);
      }
      retained.push({ ...queued, baseRaw: saved.raw, baseState: saved.state });
    }
    pending.splice(0, pending.length, ...retained);
    observedRaw = saved.raw;
  }

  return {
    read(): WorkspacePersonalizationState {
      const saved = readWorkspacePersonalizationSnapshot(storage);
      if (saved) rebasePending(saved);
      return current;
    },
    update(edit: Edit, options: WorkspacePersonalizationUpdateOptions = {}): WorkspacePersonalizationState {
      // A different tab may have written newer preferences before its storage event arrives.
      const saved = readWorkspacePersonalizationSnapshot(storage);
      if (saved) rebasePending(saved);
      const baseState = current;
      current = edit(current);
      if (saved && saveWorkspacePersonalization(current, storage)) {
        pending.length = 0;
        observedRaw = serializeWorkspacePersonalization(current);
      } else {
        pending.push({
          edit,
          baseRaw: saved ? saved.raw : observedRaw,
          baseState,
          replay: options.replay ?? 'same-snapshot',
          capabilityId: options.capabilityId,
          preserveModeOnReplay: false,
        });
      }
      return current;
    },
  };
}

interface WorkspaceStorageEventTarget {
  addEventListener(type: 'storage', listener: (event: StorageEvent) => void): void;
  removeEventListener(type: 'storage', listener: (event: StorageEvent) => void): void;
}

export function subscribeWorkspacePersonalizationStore(
  store: ReturnType<typeof createWorkspacePersonalizationStore>,
  target: WorkspaceStorageEventTarget,
  getStorageArea: () => WorkspaceStorage,
  onChange: (state: WorkspacePersonalizationState) => void,
): () => void {
  const sync = (event: StorageEvent) => {
    if (event.key !== WORKSPACE_PERSONALIZATION_STORAGE_KEY && event.key !== null) return;
    try {
      if (event.storageArea !== getStorageArea()) return;
    } catch {
      return;
    }
    onChange(store.read());
  };
  target.addEventListener('storage', sync);
  // Close the initial-render → passive-subscription gap: a write in that window has no listener.
  onChange(store.read());
  return () => target.removeEventListener('storage', sync);
}

export function resolveEffectivePinnedIds(
  state: WorkspacePersonalizationState, autoActiveIds: Iterable<string>,
): Set<string> {
  const dismissed = new Set(state.dismissedAutoIds);
  return new Set(validIds([...state.pinnedIds, ...[...autoActiveIds].filter(id => !dismissed.has(id))]));
}

export function filterSidebarItemsForWorkspace<T extends { id: string; plugin?: boolean }>(
  items: readonly T[], state: WorkspacePersonalizationState, autoActiveIds: Iterable<string>,
): readonly T[] {
  if (state.mode === 'all') return items;
  const effectivePins = resolveEffectivePinnedIds(state, autoActiveIds);
  return items.filter(item => item.plugin === true || CORE_NAV_IDS.includes(item.id) || effectivePins.has(item.id));
}

export function isCapabilityExplicitlyPinned(state: WorkspacePersonalizationState, id: string): boolean {
  return state.pinnedIds.includes(id);
}

export function pinCapability(state: WorkspacePersonalizationState, id: string): WorkspacePersonalizationState {
  if (!capabilityIds.has(id)) return state;
  return {
    ...state,
    mode: 'focused',
    pinnedIds: [...new Set([...state.pinnedIds, id])],
    dismissedAutoIds: state.dismissedAutoIds.filter(entry => entry !== id),
  };
}

/** Toggle only the permanent preference; an active automatic entry remains visible after unpinning. */
export function unpinExplicitCapability(state: WorkspacePersonalizationState, id: string): WorkspacePersonalizationState {
  if (!capabilityIds.has(id)) return state;
  return { ...state, pinnedIds: state.pinnedIds.filter(entry => entry !== id) };
}

/** Remove a capability from the focused sidebar, including its future automatic visibility. */
export function unpinCapability(state: WorkspacePersonalizationState, id: string): WorkspacePersonalizationState {
  const next = unpinExplicitCapability(state, id);
  if (next === state || !autoCapabilityIds.has(id)) return next;
  return { ...next, dismissedAutoIds: [...new Set([...state.dismissedAutoIds, id])] };
}

export function applyWorkspacePreset(
  state: WorkspacePersonalizationState,
  presetId: WorkspacePresetId,
  autoActiveIds: Iterable<string> = [],
): WorkspacePersonalizationState {
  const match = WORKSPACE_PRESETS.find(entry => entry.id === presetId);
  if (!match) return state;
  return {
    ...state,
    mode: 'focused',
    pinnedIds: [...match.pinnedIds],
    dismissedAutoIds: presetId === 'minimal'
      ? validIds([...autoActiveIds].filter(id => autoCapabilityIds.has(id)))
      : state.dismissedAutoIds.filter(id => !match.pinnedIds.includes(id)),
  };
}

export function detectActivePreset(state: WorkspacePersonalizationState): WorkspacePresetId | null {
  if (state.mode !== 'focused') return null;
  const pins = new Set(state.pinnedIds);
  return WORKSPACE_PRESETS.find(entry =>
    entry.pinnedIds.length === pins.size && entry.pinnedIds.every(id => pins.has(id)),
  )?.id ?? null;
}

export function filterCatalogCapabilities(
  catalog: readonly CapabilityDescriptor[],
  availableIds: ReadonlySet<string>,
  query: string,
  tr: (key: string) => string,
): CapabilityDescriptor[] {
  const needle = query.trim().toLowerCase();
  return catalog.filter(cap => {
    if (!availableIds.has(cap.id)) return false;
    if (!needle) return true;
    const nav = navById.get(cap.id);
    const titleKey = nav?.labelKey ?? `workspace.cap.${cap.id}.name`;
    const searchable = [
      ...[tr, zh, en].flatMap(translate => [translate(titleKey), translate(cap.summaryKey)]),
      ...(nav?.aliases ?? []), ...cap.keywords,
    ];
    return searchable.some(text => text.toLowerCase().includes(needle));
  });
}
