/**
 * Global botmux configuration stored at `~/.botmux/config.json`.
 *
 * This is a single place for "machine-wide, non-bot-specific" settings. The
 * first field is `lang` (UI language). Future settings (log level, dashboard
 * defaults, etc.) can extend the same file without proliferating env vars or
 * sidecar files.
 *
 * Read path is forgiving: missing file → empty config (callers fall back to
 * code defaults). Malformed JSON → empty config + a single stderr warning.
 * Write path is conservative: only the keys the caller actually passes get
 * touched; unknown keys in the on-disk file are preserved across writes so
 * a future client that adds a setting we don't know about doesn't lose it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import type { ProjectScanOptions } from './services/project-scanner.js';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { isLocale, type Locale } from './i18n/types.js';
import type { VoiceConfig } from './services/voice/types.js';
import { normalizePluginIdList } from './core/plugins/ids.js';

export type RepoPickerMode = 'all' | 'repos';
export type LocalCliOpenMode = 'attach' | 'resume';
export type CodexNotifierNotifyWhen = 'locked_only' | 'always';

/** Keep the configurable prefix short enough to leave useful room for the
 *  caller-provided group name. Count UTF-16 code units to match HTML
 *  `maxLength` and the rest of the dashboard's string validation. */
export const GROUP_NAME_PREFIX_MAX_LENGTH = 32;

/** Normalize the machine-wide prefix used by the `/group` slash command.
 *  Missing/blank/invalid values are treated as disabled on the forgiving read
 *  path; the Dashboard write path rejects invalid non-blank values. */
export function normalizeGroupNamePrefix(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw;
  if (!value.trim()) return undefined;
  if (value.length > GROUP_NAME_PREFIX_MAX_LENGTH) return undefined;
  // 覆盖 C0(U+0000–001F) + DEL(U+007F) + C1(U+0080–009F) 全部控制字符。
  if (/\p{Cc}/u.test(value)) return undefined;
  return value;
}

export interface WhiteboardConfig {
  /** Optional local project whiteboard. Off by default; enabling it must not create boards by itself. */
  enabled?: boolean;
}

export interface CodexNotifierGlobalConfig {
  /** 实验性机器级开关。缺省关闭；关闭后保留已信任 Hook，但 Hook 会快速跳过。 */
  enabled?: boolean;
  /** 发送完成通知的 Bot App ID；启用时必须显式选择。 */
  targetBotAppId?: string;
  /** 默认仅锁屏时发送飞书消息；always 表示每次任务完成都发送。 */
  notifyWhen?: CodexNotifierNotifyWhen;
}

export interface HostOverloadAlertGlobalConfig {
  /** 机器级过载告警开关。缺省关闭。开启后由所选「通知 Bot」的 daemon 每 30s
   *  采样整机 load/内存，越过过载线时给该 Bot 的管理员发飞书私信、恢复时再发一条。 */
  enabled?: boolean;
  /** 发送过载告警的 Bot App ID；启用时必须显式选择。只有该 Bot 自己的 daemon
   *  会采样并发送(它就跑在本机),故无需跨 daemon 投递队列。 */
  targetBotAppId?: string;
  /** 进入过载的 load 阈值:load15 > cpuCount * 此值。缺省 1.5。退出线按固定
   *  比例(95%)从它派生,保证 hysteresis(exit < enter)。 */
  enterLoadRatio?: number;
  /** 进入过载的已用内存占比阈值(0..1)。缺省 0.92。退出线同样按 95% 派生。 */
  enterMemUsedFrac?: number;
  /** 过载卡上「重启浏览器」按钮的可配置目标清单。缺省内置 Arc / Chrome / Edge
   *  （见 core/browser-restart.ts 的 DEFAULT_BROWSER_TARGETS）。此处按 bundleId
   *  合并覆盖：同 bundleId 覆盖 label/openArgs/enabled；新 bundleId 追加；
   *  enabled:false 关闭某个默认项。绝不写死浏览器，加新浏览器只改配置。 */
  browserRestartTargets?: HostOverloadBrowserTargetConfig[];
}

/** 单个可重启浏览器目标的配置项（全部可选，仅 bundleId 必填才生效）。 */
export interface HostOverloadBrowserTargetConfig {
  /** macOS CFBundleIdentifier，如 company.thebrowser.Browser。唯一定位键。 */
  bundleId: string;
  /** 卡片显示名，如 Arc / Chrome / Edge。缺省回退为 bundleId。 */
  label?: string;
  /** 重启时透传给 `open -b <id> --args …` 的额外参数（如 Chromium 的
   *  --restore-last-session 强制恢复标签）。 */
  openArgs?: string[];
  /** 置 false 则该浏览器永不出现在卡片上（用于关掉某个默认项）。 */
  enabled?: boolean;
}

export interface VcMeetingAgentGlobalConfig {
  /** Machine-wide VC meeting listener kill-switch. Missing means enabled for
   *  backwards compatibility; per-bot vcMeetingAgent.enabled still controls
   *  whether a given bot responds to meetings. */
  enabled?: boolean;
  /** Optional bot app id that is allowed to own new VC meeting listeners. When
   *  unset, legacy per-bot vcMeetingAgent.enabled routing is preserved. */
  listenerBotAppId?: string;
}

export interface WorkflowFeatureGlobalConfig {
  /** Machine-wide v3 Workflow kill-switch. Missing / `enabled !== false`
   *  preserves the legacy behavior (feature ON). Set false to turn the whole
   *  workflow feature off on this host: the `/workflow` grill + Saved-Workflow
   *  run/save entries are refused, the `botmux-workflow` family of skills stops
   *  being advertised/installed, and the CLI authoring/run subcommands refuse.
   *  In-flight run management (cancel / retry / grant) stays available so a run
   *  started before the flip can still be wound down. The multi-bot
   *  `botmux-orchestrate` skill is intentionally NOT gated by this — it is a
   *  separate long-running-orchestration capability, not a v3 workflow. */
  enabled?: boolean;
}

export interface GlobalConfig {
  lang?: Locale;
  /** Machine-wide default prefix for groups created via `/group` or `/g`.
   *  Other creation paths intentionally ignore it. Missing means disabled. */
  groupNamePrefix?: string;
  /** Machine-wide repo picker display mode. Missing / 'all' preserves legacy
   *  behavior (repos + linked worktrees). 'repos' lists only main worktrees in
   *  selection cards; explicit /repo /abs/path/to/worktree still works. */
  repoPickerMode?: RepoPickerMode;
  /** Machine-wide dashboard settings. These are intentionally global rather
   *  than per-bot: they govern the dashboard security boundary and the default
   *  terminal-opening behavior of cards emitted by all daemons on this host. */
  dashboard?: DashboardGlobalConfig;
  /** TTS engine + credentials for the voice-summary feature. See
   *  services/voice/types.ts. Presence (with usable creds) gates the
   *  "🔊 语音总结" button. */
  voice?: VoiceConfig;
  /** Machine-wide auto-update / auto-restart schedule. Off unless explicitly
   *  enabled. Only the primary daemon (bot-0) acts on it — see core/maintenance.ts. */
  maintenance?: MaintenanceConfig;
  /** Optional local project whiteboard. Disabled unless explicitly enabled. */
  whiteboard?: WhiteboardConfig;
  /** Codex App/CLI 独立任务完成通知。机器级、默认关闭，由 Dashboard 管理。 */
  codexNotifier?: CodexNotifierGlobalConfig;
  /** 机器过载告警。机器级、默认关闭，由 Dashboard 管理;走所选「通知 Bot」发送。 */
  hostOverloadAlert?: HostOverloadAlertGlobalConfig;
  /** Machine-wide meeting listener kill-switch. Missing / enabled !== false
   *  preserves legacy behavior; set false to stop accepting new VC meetings
   *  and skip restore/readiness for this host. */
  vcMeetingAgent?: VcMeetingAgentGlobalConfig;
  /** Machine-wide v3 Workflow kill-switch. Missing / enabled !== false keeps
   *  the feature ON (legacy behavior); set false to disable it host-wide. The
   *  `BOTMUX_WORKFLOW_ENABLED` env var overrides this when set. */
  workflow?: WorkflowFeatureGlobalConfig;
  /** Optional HTTP(S) proxy for the daemon's own outbound downloads (e.g. the
   *  HD2D office assets). Node's global fetch ignores HTTP_PROXY/HTTPS_PROXY,
   *  so hosts behind a proxy must set this (or the env vars, which we read as a
   *  fallback). Form: `http://host:port` or `http://user:pass@host:port`. */
  httpProxy?: string;
  /** OAuth redirect base for user authorization (/login). When set (e.g.
   *  `http://10.1.2.3:7891`, typically this host's dashboard origin), auth
   *  links redirect to `<base>/oauth/callback`, which the dashboard receives
   *  and completes automatically — the zero-copy-paste flow for daemons that
   *  do NOT run on the user's own machine. Missing → the legacy
   *  `http://127.0.0.1:9768/callback` paste-back flow. */
  oauthRedirectBase?: string;
  /** Machine-wide user skill registry policy. Skill package storage itself lives under
   *  ~/.botmux/skills and is managed by services/skill-registry-store.ts. */
  skills?: GlobalSkillConfig;
  /** Plugin ids enabled for every bot. Per-bot plugin ids are additive. */
  plugins?: string[];
  /** 远程访问. When true (and this machine is bound to the central platform),
   *  session web-terminal links, Feishu card terminal buttons, and connector
   *  webhook URLs use the central-platform machine subdomain instead of local
   *  host:port URLs. Off by default — only local links are emitted. Gated in
   *  buildTerminalUrl / publicWebhookUrl via isRemoteAccessEnabled(). */
  remoteAccess?: boolean;
  /** Machine-wide timezone for USER scheduled tasks (scheduler). An IANA name
   *  (e.g. 'Asia/Shanghai'). Overrides the host's auto-detected local zone for
   *  cron firing, one-shot「明天HH:MM」parsing, and all schedule displays —
   *  see utils/timezone.ts `scheduleTimeZone()`. Absent ⇒ follow the host zone.
   *  Stored lenient here; final IANA validity is enforced on write
   *  (settings-write-applier) and re-checked at resolve time. */
  scheduleTimeZone?: string;
}

export interface GlobalSkillConfig {
  trustProjectSkills?: 'off' | 'trusted' | 'all';
  delivery?: 'auto' | 'prompt' | 'native';
  /** Machine-wide default for how botmux's **built-in bridge skills**
   *  (botmux-send / botmux-schedule / …) reach CLIs that only support a GLOBAL
   *  skills directory (codex/gemini/opencode/… — everything with `skillsDir`,
   *  i.e. no per-session `--plugin-dir` injection like Claude Code):
   *   - `global`: install the skill files into the CLI's shared global dir
   *     (e.g. `~/.codex/skills`). Full native experience, but the user's own
   *     standalone `codex`/`gemini` sees & can mis-fire them. Right for hosts
   *     whose users NEVER run those CLIs by hand.
   *   - `prompt` (default): don't touch the global dir; inject a compact skill
   *     catalog into the session prompt and let the model pull full instructions
   *     on demand via `botmux skill show <name>`. Session-scoped → no leak.
   *   - `off`: inject neither files nor catalog — only the routing hints + a
   *     pointer at `botmux --help`. Lightest; relies on CLI help completeness.
   *  A per-bot `skillInjection` (bots.json) overrides this. Unset ⇒ `prompt`. */
  builtinInjection?: 'global' | 'prompt' | 'off';
}

export interface MaintenanceConfig {
  /** At `time` (once/day) update the owning npm/pnpm/Bun global install to the
   *  latest version — download/install only, never restarts on its own.
   *  Disabled for local-dev and unsupported install layouts. */
  autoUpdate?: MaintenanceTask;
  /** When enabled (and autoUpdate is on), restart right after a successful
   *  auto-update that installed a newer version, to apply it. No schedule of
   *  its own — reuses autoUpdate's time, fires only when there's a pending
   *  update. */
  autoRestart?: MaintenanceToggle;
}

export interface MaintenanceTask {
  enabled?: boolean;
  /** Local-time (Asia/Shanghai) "HH:MM", once per day. */
  time?: string;
}

export interface MaintenanceToggle {
  enabled?: boolean;
}

export interface HerdrTraexPluginConfig {
  enabled?: boolean;
  /** herdr plugin source: `owner/repo[/subdir]` passed to `herdr plugin install`. */
  source?: string;
  /** Optional git ref (tag / branch / commit SHA) → `--ref`. Prefer a pinned SHA. */
  ref?: string;
}

export interface DashboardGlobalConfig {
  /** When true, dashboard GET/HEAD pages and JSON APIs are public read-only;
   *  mutations still require the active dashboard token. */
  publicReadOnly?: boolean;
  /** When true, terminal buttons on Feishu cards use Feishu's sidebar web_url
   *  wrapper. Default false opens the terminal URL directly. */
  openTerminalInFeishu?: boolean;
  /** Opt in to native "Open <CLI>" buttons on supported desktop hosts.
   *  Default false. When enabled, localCliOpenMode defaults to 'attach' so a
   *  botmux-managed persistent backend enters the same underlying CLI and
   *  preserves Feishu continuity. ZMX uses its native local terminal while
   *  Feishu remains plain text; 'resume' starts a separate CLI resume process
   *  and may break that continuity. */
  enableLocalCliOpen?: boolean;
  /** How native "Open <CLI>" buttons launch on macOS. Missing defaults to
   *  'attach': attach to the current managed/adopted backend session when an
   *  exact attach target is available. 'resume' keeps the prior direct CLI
   *  resume behavior for supported CLIs. */
  localCliOpenMode?: LocalCliOpenMode;
  /** Experimental current-chat bot discovery via Lark `/members/bots`. Default
   *  ON (absent ⇒ enabled); set false to disable from the dashboard. Read live
   *  by the daemon — see config.ts `resolveChatBotDiscoveryConfig`. */
  chatBotDiscovery?: boolean;
  /** Installed plugin Dashboard pages pinned into the main sidebar. This is a
   *  machine-wide display preference and does not enable the plugin for a Bot. */
  pinnedPlugins?: string[];
  /** Opt-in TraeX herdr plugin bootstrap. Default OFF; source/ref are operator-supplied. */
  herdrTraexPlugin?: HerdrTraexPluginConfig;
  /** Experimental: globally enable RPC input mode for RPC-capable codex-family
   *  bots (codex / traex) — user input goes via the app-server JSON-RPC channel
   *  instead of a tmux paste, bypassing codex's terminal paste-drop. Default OFF
   *  (absent ⇒ off); flip on to enable fleet-wide. Read live by the daemon —
   *  see config.ts `codexRpcInputDefault`. A per-bot `codexRpcInput: true` still
   *  force-enables regardless of this global default. */
  codexRpcInput?: boolean;
  /** Whether botmux auto-bypasses Codex's interactive hook-trust gate ("Press t
   *  to trust") for Codex-family plain-TUI launches (codex / traex). Codex 0.14x
   *  gates the botmux-installed ~/.codex/hooks.json behind a manual trust prompt,
   *  and every botmux upgrade rewrites the hook script → its hash changes → the
   *  gate re-fires; a botmux-managed pane has no human to press `t`, so the first
   *  turn wedges. When enabled, the adapter passes `--dangerously-bypass-hook-trust`.
   *  Default ON (ABSENT ⇒ ON — only an explicit `false` disables): a headless
   *  fleet needs it to not wedge. This is a SEPARATE knob from the approval/sandbox
   *  bypass: the flag trusts ALL hook sources codex sees (user/project/plugin), not
   *  only botmux's, so an operator who does not want project/plugin `.codex/hooks.json`
   *  auto-trusted can turn it off. Still ANDed with the per-bot `!disableCliBypass`
   *  fail-closed lower bound (a restricted bot never gets it regardless). Read live
   *  by the daemon — see config.ts `bypassCodexHookTrust`. */
  bypassCodexHookTrust?: boolean;
  /** Experimental: inject the "no visible output" anti-resend guidance into the
   *  botmux routing hints. Counters Claude Code (≥2.1.212) thinking-only nudges
   *  that make a model resend after a silent `botmux send`-only turn. Default OFF
   *  (absent ⇒ off): mainly helps when Claude Code drives a non-Claude backend
   *  model; harmless but unnecessary otherwise. Read live — see config.ts
   *  `noVisibleOutputHint`. */
  noVisibleOutputHint?: boolean;
  /** 流式卡片上下文占用百分比变色/高亮阈值（1-100 整数）。缺省 80。由 card-builder
   *  在构建时读取（readGlobalConfig 2s TTL 缓存），低于阈值灰色、≥阈值红色并提示压缩。 */
  contextCompactThreshold?: number;
}

/** Loosely validate a `voice` block: keep it only if it's an object with a
 *  recognizable engine or engine-specific creds (TTS) / an asr block. Deep
 *  validation (usable creds / enabled) happens in resolveVoiceConfig /
 *  resolveAsrConfig; here we just gate obvious garbage. */
function readVoice(raw: unknown): VoiceConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const engineOk = v.engine === 'sami' || v.engine === 'openai' || v.engine === undefined;
  if (!engineOk) return undefined;
  if (!v.sami && !v.openai && !v.engine && !v.asr) return undefined;
  return v as VoiceConfig;
}

/** True when `s` is a valid 24h "HH:MM" (leading zero optional on hours).
 *  Shared by the config reader and the dashboard PUT validator. */
export function isValidHhMm(s: string): boolean {
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(s);
}

function readMaintenanceTask(raw: unknown): MaintenanceTask | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  const out: MaintenanceTask = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (typeof r.time === 'string' && isValidHhMm(r.time)) out.time = r.time;
  return Object.keys(out).length > 0 ? out : undefined;
}

function readMaintenanceToggle(raw: unknown): MaintenanceToggle | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.enabled !== 'boolean') return undefined;
  return { enabled: r.enabled };
}

/** Validate a maintenance patch from the dashboard PUT. Type-strict on enabled
 *  (both keys) and on autoUpdate's time. autoRestart is a toggle — any `time`
 *  on it is ignored (it reuses autoUpdate's schedule). */
export function parseMaintenancePatch(
  body: unknown,
): { ok: true; patch: MaintenanceConfig } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'empty' };
  const b = body as Record<string, unknown>;
  const patch: MaintenanceConfig = {};
  if ('autoUpdate' in b) {
    const raw = b.autoUpdate;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid_task' };
    const t = raw as Record<string, unknown>;
    const task: MaintenanceTask = {};
    if ('enabled' in t) {
      if (typeof t.enabled !== 'boolean') return { ok: false, error: 'invalid_enabled' };
      task.enabled = t.enabled;
    }
    if ('time' in t) {
      if (typeof t.time !== 'string' || !isValidHhMm(t.time)) return { ok: false, error: 'invalid_time' };
      task.time = t.time;
    }
    patch.autoUpdate = task;
  }
  if ('autoRestart' in b) {
    const raw = b.autoRestart;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'invalid_task' };
    const t = raw as Record<string, unknown>;
    const toggle: MaintenanceToggle = {};
    if ('enabled' in t) {
      if (typeof t.enabled !== 'boolean') return { ok: false, error: 'invalid_enabled' };
      toggle.enabled = t.enabled;
    }
    patch.autoRestart = toggle;
  }
  if (Object.keys(patch).length === 0) return { ok: false, error: 'empty' };
  return { ok: true, patch };
}

function readMaintenance(raw: unknown): MaintenanceConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const m = raw as Record<string, unknown>;
  const out: MaintenanceConfig = {};
  const au = readMaintenanceTask(m.autoUpdate);
  if (au) out.autoUpdate = au;
  const ar = readMaintenanceToggle(m.autoRestart);
  if (ar) out.autoRestart = ar;
  return Object.keys(out).length > 0 ? out : undefined;
}

function readRepoPickerMode(raw: unknown): RepoPickerMode | undefined {
  return raw === 'all' || raw === 'repos' ? raw : undefined;
}

function readLocalCliOpenMode(raw: unknown): LocalCliOpenMode | undefined {
  return raw === 'attach' || raw === 'resume' ? raw : undefined;
}

function readHerdrTraexPlugin(raw: unknown): HerdrTraexPluginConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: HerdrTraexPluginConfig = {};
  if (typeof r.enabled === 'boolean') out.enabled = r.enabled;
  if (typeof r.source === 'string' && r.source.trim()) out.source = r.source.trim();
  if (typeof r.ref === 'string' && r.ref.trim()) out.ref = r.ref.trim();
  // Migrate the unmerged review schema in-memory without rewriting config.json.
  if (!out.source && typeof r.spec === 'string' && r.spec.trim()) {
    const legacy = r.spec.trim();
    const hash = legacy.lastIndexOf('#');
    out.source = hash > 0 ? legacy.slice(0, hash) : legacy;
    if (!out.ref && hash > 0 && hash < legacy.length - 1) out.ref = legacy.slice(hash + 1);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readDashboard(raw: unknown): DashboardGlobalConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const d = raw as Record<string, unknown>;
  const out: DashboardGlobalConfig = {};
  if (typeof d.publicReadOnly === 'boolean') out.publicReadOnly = d.publicReadOnly;
  if (typeof d.openTerminalInFeishu === 'boolean') out.openTerminalInFeishu = d.openTerminalInFeishu;
  if (typeof d.enableLocalCliOpen === 'boolean') out.enableLocalCliOpen = d.enableLocalCliOpen;
  const localCliOpenMode = readLocalCliOpenMode(d.localCliOpenMode);
  if (localCliOpenMode) out.localCliOpenMode = localCliOpenMode;
  if (typeof d.chatBotDiscovery === 'boolean') out.chatBotDiscovery = d.chatBotDiscovery;
  const pinnedPlugins = normalizePluginIdList(d.pinnedPlugins);
  if (pinnedPlugins) out.pinnedPlugins = pinnedPlugins;
  const herdrTraexPlugin = readHerdrTraexPlugin(d.herdrTraexPlugin);
  if (herdrTraexPlugin) out.herdrTraexPlugin = herdrTraexPlugin;
  if (typeof d.codexRpcInput === 'boolean') out.codexRpcInput = d.codexRpcInput;
  // Round-trip an explicit boolean either way. Absent stays absent — the live
  // getter (config.ts `bypassCodexHookTrust`) treats absent as ON, so we must
  // preserve a stored `false` to let an operator disable it.
  if (typeof d.bypassCodexHookTrust === 'boolean') out.bypassCodexHookTrust = d.bypassCodexHookTrust;
  if (typeof d.noVisibleOutputHint === 'boolean') out.noVisibleOutputHint = d.noVisibleOutputHint;
  // 非法值（非数字 / NaN / 越界）静默丢弃，走 card-builder 的默认 80。
  if (typeof d.contextCompactThreshold === 'number'
    && Number.isFinite(d.contextCompactThreshold)
    && d.contextCompactThreshold >= 1 && d.contextCompactThreshold <= 100) {
    out.contextCompactThreshold = Math.round(d.contextCompactThreshold);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readGlobalSkills(raw: unknown): GlobalSkillConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const out: GlobalSkillConfig = {};
  if (r.trustProjectSkills === 'off' || r.trustProjectSkills === 'trusted' || r.trustProjectSkills === 'all') {
    out.trustProjectSkills = r.trustProjectSkills;
  }
  if (r.delivery === 'auto' || r.delivery === 'prompt' || r.delivery === 'native') {
    out.delivery = r.delivery;
  }
  if (r.builtinInjection === 'global' || r.builtinInjection === 'prompt' || r.builtinInjection === 'off') {
    out.builtinInjection = r.builtinInjection;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readWhiteboard(raw: unknown): WhiteboardConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const out: WhiteboardConfig = {};
  if (typeof v.enabled === 'boolean') out.enabled = v.enabled;
  return Object.keys(out).length > 0 ? out : undefined;
}

function readCodexNotifier(raw: unknown): CodexNotifierGlobalConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const out: CodexNotifierGlobalConfig = {};
  if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
  if (typeof value.targetBotAppId === 'string' && value.targetBotAppId.trim()) {
    out.targetBotAppId = value.targetBotAppId.trim();
  }
  if (value.notifyWhen === 'locked_only' || value.notifyWhen === 'always') {
    out.notifyWhen = value.notifyWhen;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readHostOverloadAlert(raw: unknown): HostOverloadAlertGlobalConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const out: HostOverloadAlertGlobalConfig = {};
  if (typeof value.enabled === 'boolean') out.enabled = value.enabled;
  if (typeof value.targetBotAppId === 'string' && value.targetBotAppId.trim()) {
    out.targetBotAppId = value.targetBotAppId.trim();
  }
  // Enter thresholds: keep only sane, finite, positive values; the resolver
  // (daemon side) layers env > config > default and derives the exit lines with
  // hysteresis, so a missing/garbage value here just falls through to defaults.
  if (typeof value.enterLoadRatio === 'number' && Number.isFinite(value.enterLoadRatio) && value.enterLoadRatio > 0) {
    out.enterLoadRatio = value.enterLoadRatio;
  }
  if (
    typeof value.enterMemUsedFrac === 'number'
    && Number.isFinite(value.enterMemUsedFrac)
    && value.enterMemUsedFrac > 0
    && value.enterMemUsedFrac <= 1
  ) {
    out.enterMemUsedFrac = value.enterMemUsedFrac;
  }
  const browserTargets = readBrowserRestartTargets(value.browserRestartTargets);
  if (browserTargets) out.browserRestartTargets = browserTargets;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse the `browserRestartTargets` array from config. Keep only entries with a
 *  non-blank string bundleId; coerce the optional fields defensively so a
 *  hand-edited config can't inject non-strings. Returns undefined when there's
 *  nothing usable (so the default set applies). The daemon-side resolver
 *  (core/browser-restart.ts) does the actual merge-over-defaults. */
function readBrowserRestartTargets(raw: unknown): HostOverloadBrowserTargetConfig[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: HostOverloadBrowserTargetConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const v = item as Record<string, unknown>;
    const bundleId = typeof v.bundleId === 'string' ? v.bundleId.trim() : '';
    if (!bundleId) continue;
    const entry: HostOverloadBrowserTargetConfig = { bundleId };
    if (typeof v.label === 'string' && v.label.trim()) entry.label = v.label.trim();
    if (Array.isArray(v.openArgs) && v.openArgs.every(a => typeof a === 'string')) {
      entry.openArgs = v.openArgs as string[];
    }
    if (typeof v.enabled === 'boolean') entry.enabled = v.enabled;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

function readVcMeetingAgent(raw: unknown): VcMeetingAgentGlobalConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  const out: VcMeetingAgentGlobalConfig = {};
  if (typeof v.enabled === 'boolean') out.enabled = v.enabled;
  if (typeof v.listenerBotAppId === 'string' && v.listenerBotAppId.trim()) {
    out.listenerBotAppId = v.listenerBotAppId.trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readWorkflowFeature(raw: unknown): WorkflowFeatureGlobalConfig | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const v = raw as Record<string, unknown>;
  const out: WorkflowFeatureGlobalConfig = {};
  if (typeof v.enabled === 'boolean') out.enabled = v.enabled;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function globalConfigPath(): string {
  return join(homedir(), '.botmux', 'config.json');
}

let warnedOnce = false;

/** Load `~/.botmux/config.json`. Returns `{}` when the file is missing or
 *  unreadable. The raw JSON is also returned (untyped) so writers can
 *  preserve unknown keys round-trip — see `mergeGlobalConfig`. */
function readRawConfig(): Record<string, unknown> {
  const path = globalConfigPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch (err: any) {
    // Under the file sandbox config.json is intentionally NOT exposed (it can
    // hold voice TTS credentials); EPERM/EACCES here is EXPECTED, not a parse
    // failure — return defaults silently. Only warn on a genuine corrupt-JSON.
    if (err?.code !== 'EPERM' && err?.code !== 'EACCES' && !warnedOnce) {
      warnedOnce = true;
      // eslint-disable-next-line no-console
      console.warn(`[botmux] Failed to parse ${path}: ${err?.message ?? err}. Ignoring file.`);
    }
    return {};
  }
}

// Short TTL cache: readGlobalConfig sits on hot paths (card-builder rebuilds
// the streaming card on every screen_update, i.e. ~per second per active
// session), and reading + parsing the file each time is wasted IO. 2s keeps
// cross-process freshness (dashboard PUT → daemon cards pick it up within 2s)
// while same-process writes invalidate immediately via mergeGlobalConfig.
// Keyed by path so tests that re-point HOME don't read a stale entry.
const READ_CACHE_TTL_MS = 2_000;
let readCache: { path: string; value: GlobalConfig; at: number } | null = null;
let vcMeetingAgentLiveCache: { path: string; mtimeMs: number; config: VcMeetingAgentGlobalConfig } | null = null;

/** Typed view of the global config. Validates `lang` so a malformed file
 *  can't propagate a bad value into the i18n module. */
export function readGlobalConfig(): GlobalConfig {
  const path = globalConfigPath();
  if (readCache && readCache.path === path && Date.now() - readCache.at < READ_CACHE_TTL_MS) {
    return readCache.value;
  }
  const raw = readRawConfig();
  const out: GlobalConfig = {};
  if (isLocale(raw.lang)) out.lang = raw.lang;
  const groupNamePrefix = normalizeGroupNamePrefix(raw.groupNamePrefix);
  if (groupNamePrefix) out.groupNamePrefix = groupNamePrefix;
  const repoPickerMode = readRepoPickerMode(raw.repoPickerMode);
  if (repoPickerMode) out.repoPickerMode = repoPickerMode;
  const dashboard = readDashboard(raw.dashboard);
  if (dashboard) out.dashboard = dashboard;
  const voice = readVoice(raw.voice);
  if (voice) out.voice = voice;
  const maintenance = readMaintenance(raw.maintenance);
  if (maintenance) out.maintenance = maintenance;
  const whiteboard = readWhiteboard(raw.whiteboard);
  if (whiteboard) out.whiteboard = whiteboard;
  const codexNotifier = readCodexNotifier(raw.codexNotifier);
  if (codexNotifier) out.codexNotifier = codexNotifier;
  const hostOverloadAlert = readHostOverloadAlert(raw.hostOverloadAlert);
  if (hostOverloadAlert) out.hostOverloadAlert = hostOverloadAlert;
  const vcMeetingAgent = readVcMeetingAgent(raw.vcMeetingAgent);
  if (vcMeetingAgent) out.vcMeetingAgent = vcMeetingAgent;
  const workflow = readWorkflowFeature(raw.workflow);
  if (workflow) out.workflow = workflow;
  if (typeof raw.httpProxy === 'string' && raw.httpProxy.trim()) out.httpProxy = raw.httpProxy.trim();
  // Lenient http(s) origin check; resolveOAuthRedirectUri re-validates shape.
  if (typeof raw.oauthRedirectBase === 'string' && /^https?:\/\//.test(raw.oauthRedirectBase.trim())) {
    out.oauthRedirectBase = raw.oauthRedirectBase.trim();
  }
  const skills = readGlobalSkills(raw.skills);
  if (skills) out.skills = skills;
  const plugins = normalizePluginIdList(raw.plugins);
  if (plugins) out.plugins = plugins;
  if (typeof raw.remoteAccess === 'boolean') out.remoteAccess = raw.remoteAccess;
  // Lenient: keep any non-empty string. IANA validity is enforced on write and
  // re-checked in scheduleTimeZone() (invalid ⇒ falls back to the host zone),
  // so a stale/hand-edited bad value degrades gracefully rather than crashing.
  if (typeof raw.scheduleTimeZone === 'string' && raw.scheduleTimeZone.trim()) {
    out.scheduleTimeZone = raw.scheduleTimeZone.trim();
  }
  readCache = { path, value: out, at: Date.now() };
  return out;
}

/** Drop the short-TTL read cache so the next readGlobalConfig re-reads from
 *  disk. Same-process writes invalidate automatically (mergeGlobalConfig); this
 *  is for cross-process freshness on demand — e.g. the dashboard process after
 *  `botmux bind` (a different process) flips remoteAccess on, so the post-bind
 *  dashboard URL reflects the new value without waiting out the TTL. */
export function invalidateGlobalConfigCache(): void {
  readCache = null;
  vcMeetingAgentLiveCache = null;
}

/** Live VC meeting listener global config. Missing config means enabled.
 *
 * This path is checked at every VC event ingress. Use a file mtime cache
 * instead of the general 2s readGlobalConfig TTL so dashboard flips take effect
 * across all daemon processes without restart and without parsing the file on
 * every event.
 */
export function globalVcMeetingAgentConfigLive(): VcMeetingAgentGlobalConfig {
  const path = globalConfigPath();
  if (!existsSync(path)) {
    const config = { enabled: true };
    vcMeetingAgentLiveCache = { path, mtimeMs: -1, config };
    return config;
  }
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    return vcMeetingAgentLiveCache?.config ?? { enabled: true };
  }
  if (vcMeetingAgentLiveCache && vcMeetingAgentLiveCache.path === path && vcMeetingAgentLiveCache.mtimeMs === mtimeMs) {
    return vcMeetingAgentLiveCache.config;
  }
  const raw = readRawConfig();
  const parsed = readVcMeetingAgent(raw.vcMeetingAgent);
  const config: VcMeetingAgentGlobalConfig = {
    enabled: parsed?.enabled !== false,
    ...(parsed?.listenerBotAppId ? { listenerBotAppId: parsed.listenerBotAppId } : {}),
  };
  vcMeetingAgentLiveCache = { path, mtimeMs, config };
  return config;
}

export function isGlobalVcMeetingAgentEnabled(): boolean {
  return globalVcMeetingAgentConfigLive().enabled !== false;
}

export function globalVcMeetingAgentListenerBotAppId(): string | undefined {
  return globalVcMeetingAgentConfigLive().listenerBotAppId;
}

/** 远程访问 enabled? Reads the (short-TTL cached) global config — cheap enough to
 *  call per link. False unless explicitly enabled. Gates whether central-platform
 *  URLs are emitted (see buildTerminalUrl / publicWebhookUrl). */
export function isRemoteAccessEnabled(): boolean {
  return readGlobalConfig().remoteAccess === true;
}

/** Machine-wide v3 Workflow feature kill-switch.
 *
 * Missing / `workflow.enabled !== false` means ON (backwards compatible — the
 * feature has always been on). An explicit `false` in `~/.botmux/config.json`
 * disables it. The `BOTMUX_WORKFLOW_ENABLED` env var, when set to a non-empty
 * value, OVERRIDES the config file either way (`true`/`1`/`yes`/`on` ⇒ enabled,
 * anything else ⇒ disabled) — it is both the escape hatch if the config gate
 * misfires and the channel the worker injects into CLI panes so a pane's
 * `botmux workflow …` subcommand agrees with the daemon that spawned it.
 *
 * Read live off the short-TTL config cache so a dashboard toggle takes effect on
 * the next session/turn without a daemon restart (mirrors whiteboardEnabled /
 * isGlobalVcMeetingAgentEnabled). */
export function isWorkflowFeatureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = env.BOTMUX_WORKFLOW_ENABLED;
  if (flag != null && flag !== '') {
    const v = flag.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes' || v === 'on';
  }
  return readGlobalConfig().workflow?.enabled !== false;
}

/** Derive repo-picker scan options from the machine-wide `repoPickerMode`.
 *  'repos' hides linked worktrees from selection cards; anything else
 *  (default 'all') lists repos + their worktrees. Shared by every scan
 *  entry point (daemon spawn paths + `/repo`) so they stay consistent. */
export function repoPickerScanOptions(): ProjectScanOptions {
  return { includeWorktrees: readGlobalConfig().repoPickerMode !== 'repos' };
}

/** Merge a patch into the on-disk config, preserving unknown keys. Creates
 *  the file (and parent dir) on first write. Use `null` to explicitly delete
 *  a known key from the file. */
export function mergeGlobalConfig(patch: Partial<Record<keyof GlobalConfig, GlobalConfig[keyof GlobalConfig] | null>>): void {
  const path = globalConfigPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const current = readRawConfig();
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined) delete current[k];
    else current[k] = v;
  }
  // Atomic write (tmp + rename): readers in other processes poll this file on
  // hot paths; a plain writeFileSync window could serve a torn/partial JSON,
  // which readRawConfig would silently treat as {} (settings flap to defaults
  // for one read). pid suffix keeps concurrent writers off each other's tmp.
  // mode 0600 — the file can carry voice credentials; an umask-default tmp
  // (0644) surviving the rename would widen access. Fixing the mode here also
  // tightens legacy 0644 files created by the pre-atomic writeFileSync path.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  // Same-process read-after-write must see the new value immediately
  // (e.g. dashboard PUT /api/settings responds with the resolved config).
  readCache = null;
  vcMeetingAgentLiveCache = null;
}

/** Merge only the dashboard sub-config, preserving unknown keys inside that
 *  object so a newer client can safely share the same config file. */
export function mergeDashboardConfig(patch: DashboardGlobalConfig): DashboardGlobalConfig {
  const raw = readRawConfig();
  const existing = raw.dashboard && typeof raw.dashboard === 'object' && !Array.isArray(raw.dashboard)
    ? raw.dashboard as Record<string, unknown>
    : {};
  mergeGlobalConfig({ dashboard: { ...existing, ...patch } as DashboardGlobalConfig });
  return readGlobalConfig().dashboard ?? {};
}

/** 写入 notifier 的完整已知配置，同时保留配置块内的未来字段。 */
export function writeCodexNotifierConfig(config: CodexNotifierGlobalConfig): CodexNotifierGlobalConfig {
  const raw = readRawConfig();
  const existing = raw.codexNotifier && typeof raw.codexNotifier === 'object' && !Array.isArray(raw.codexNotifier)
    ? { ...raw.codexNotifier as Record<string, unknown> }
    : {};
  delete existing.enabled;
  delete existing.targetBotAppId;
  delete existing.notifyWhen;
  mergeGlobalConfig({ codexNotifier: { ...existing, ...config } as CodexNotifierGlobalConfig });
  return readGlobalConfig().codexNotifier ?? {};
}

/** 写入机器过载告警的完整已知配置，同时保留配置块内的未来字段。 */
export function writeHostOverloadAlertConfig(config: HostOverloadAlertGlobalConfig): HostOverloadAlertGlobalConfig {
  const raw = readRawConfig();
  const existing = raw.hostOverloadAlert && typeof raw.hostOverloadAlert === 'object' && !Array.isArray(raw.hostOverloadAlert)
    ? { ...raw.hostOverloadAlert as Record<string, unknown> }
    : {};
  delete existing.enabled;
  delete existing.targetBotAppId;
  delete existing.enterLoadRatio;
  delete existing.enterMemUsedFrac;
  mergeGlobalConfig({ hostOverloadAlert: { ...existing, ...config } as HostOverloadAlertGlobalConfig });
  return readGlobalConfig().hostOverloadAlert ?? {};
}

/** Merge only the maintenance sub-config, preserving unknown sibling keys.
 *  Shallow-merges at the task level (autoUpdate / autoRestart): callers send
 *  the full task object, so a present key replaces it wholesale. */
export function mergeMaintenanceConfig(patch: MaintenanceConfig): MaintenanceConfig {
  const raw = readRawConfig();
  const existing = raw.maintenance && typeof raw.maintenance === 'object' && !Array.isArray(raw.maintenance)
    ? raw.maintenance as Record<string, unknown>
    : {};
  mergeGlobalConfig({ maintenance: { ...existing, ...patch } as MaintenanceConfig });
  return readGlobalConfig().maintenance ?? {};
}

/** Convenience: set the global UI locale (or clear it when `null`). */
export function setGlobalLocale(loc: Locale | null): void {
  mergeGlobalConfig({ lang: loc });
}
