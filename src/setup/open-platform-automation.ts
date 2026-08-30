/**
 * Feishu Open Platform automation used by `botmux setup`.
 *
 * The primary Feishu path now uses one reusable Web session for the whole flow:
 * create app -> read AppID/AppSecret -> configure scopes/events/redirect ->
 * create and publish a version. The official SDK registerApp device flow stays
 * available as a fallback (notably for Lark international tenants).
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import qrcode from 'qrcode-terminal';
import bundledScopeManifest from './lark-scopes.json' with { type: 'json' };
import { registerBotmuxRedirectUrlCollector, VC_MEETING_BOT_EVENTS } from './verify-permissions.js';
import { readGlobalConfig } from '../global-config.js';
import { platformMachineBaseUrl, publicReverseProxyBaseUrl } from '../platform/binding.js';
import {
  parseOnlineVisibility,
  VisibilityParseError,
  type VisibilitySuggest,
} from './open-platform-visibility.js';

/**
 * All non-VC events (application identity) that the botmux dispatcher consumes.
 * `card.action.trigger` is intentionally NOT here: the Open Platform treats it
 * as a "callback" configured via `/developers/v1/callback/*`, see
 * BOT_BASELINE_CALLBACKS.
 */
export const BOT_BASELINE_APP_EVENTS = [
  'im.message.receive_v1',
  'im.chat.member.bot.added_v1',
  'im.chat.member.bot.deleted_v1',
  'drive.notice.comment_add_v1',
  'im.message.reaction.created_v1',
  'im.message.reaction.deleted_v1',
] as const;

/**
 * Best-effort app events: subscribed alongside the baseline but NEVER part of
 * the fail-closed verification (missingBaselineEvents / MANAGED_VERIFIED_EVENT_COUNT).
 * Used for enhancements that degrade gracefully when unsubscribed — membership
 * change events only drive chatStatsCache invalidation, whose 5-min TTL is the
 * documented fallback. Some tenants cannot grant the underlying member-read
 * scopes for user events; hard-requiring them would block bot onboarding.
 */
export const BOT_OPTIONAL_APP_EVENTS = [
  'im.chat.member.user.added_v1',
  'im.chat.member.user.deleted_v1',
] as const;

/** 缺了它 daemon 完全收不到消息——回读确认失败时整个自动配置 fail-closed。 */
export const BOT_CRITICAL_APP_EVENTS = ['im.message.receive_v1'] as const;

/** 卡片交互回调。缺了它卡片按钮点击无响应,同样 fail-closed。 */
export const BOT_BASELINE_CALLBACKS = ['card.action.trigger'] as const;

/** 开放平台「使用长连接接收事件/回调」对应的 mode 值。 */
export const LONG_CONNECTION_EVENT_MODE = 4;

const VC_MEETING_EVENT_IDENTITY = {
  'vc.bot.meeting_invited_v1': 'app',
  'vc.bot.meeting_activity_v1': 'app',
  'vc.bot.meeting_ended_v1': 'app',
  'vc.meeting.participant_meeting_joined_v1': 'user',
} as const satisfies Record<(typeof VC_MEETING_BOT_EVENTS)[number], 'app' | 'user'>;

export const VC_MEETING_APP_EVENTS = VC_MEETING_BOT_EVENTS.filter(
  eventName => VC_MEETING_EVENT_IDENTITY[eventName] === 'app',
);
export const VC_MEETING_USER_EVENTS = VC_MEETING_BOT_EVENTS.filter(
  eventName => VC_MEETING_EVENT_IDENTITY[eventName] === 'user',
);

export const BOTMUX_REDIRECT_URL = 'http://127.0.0.1:9768/callback';
const FEISHU_ACCOUNTS_ORIGIN = 'https://accounts.feishu.cn';
const ASK_FEISHU_ORIGIN = 'https://ask.feishu.cn';
const FEISHU_APP_ID = '12';
const FEISHU_COMMON_HEADERS = {
  'x-api-version': '1.0.28',
  'x-device-info':
    'device_id=0;device_name=Chrome;device_os=Mac;device_model=Chrome;lark_version=;channel=Release;package_name=feishu;tt_app_id=1658;is_dpop_support=true;is_iframe=false',
  'x-locale': 'zh-CN',
  'x-terminal-type': '2',
};

export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  hostOnly: boolean;
  expiresAt?: number;
  sameSite?: string;
}

/** 当前开放平台 Web session 对应的人与企业。创建前用它防止复用错租户。 */
export interface FeishuWebSessionIdentity {
  userId: string;
  userName: string;
  email?: string;
  tenantId: string;
  tenantName: string;
}

export interface ScopeManifest {
  scopes?: {
    tenant?: string[];
    user?: string[];
  };
}

export interface OpenPlatformScopeEntry {
  id: string;
  name: string;
  bucket?: 'tenant' | 'user';
}

export interface MappedScopeIds {
  tenantScopeIds: string[];
  userScopeIds: string[];
  missingTenantScopes: string[];
  missingUserScopes: string[];
}

/** console 的 `schemaType` 枚举：只有 SelectionExpression 这档有「数据范围」表单。 */
export const PRIVILEGE_SCHEMA_TYPE_SELECTION_EXPRESSION = 1;
/** console 的 `organizationType` 枚举：跨组织(B2B/B2C)那两档不在本机制内。 */
export const PRIVILEGE_ORG_TYPE_INTERNAL = 1;

/** 数据范围表单里的一个字段（只保留判定与拼 content 需要的部分）。 */
export interface OpenPlatformPrivilegeField {
  id: string;
  name: string;
  /** `data_source.type === 'select_staff'`，即「选人」控件。 */
  selectStaff: boolean;
  /** 支持 `in`（「包含」）操作符。 */
  supportsIn: boolean;
}

/** `privilege/all` 里的一条「权限可访问的数据范围」。 */
export interface OpenPlatformPrivilege {
  /** 原始条目，写回时浅拷贝改 content 用（服务端还会读其它字段）。 */
  raw: Record<string, unknown>;
  bizId: string;
  resource: string;
  name: string;
  /** 所属业务分类的显示名（来自同一响应的 `scopeBiz`），只用于 description。 */
  bizName: string;
  isRequired: boolean;
  content: string;
  schemaType?: number;
  organizationType?: number;
  fields: OpenPlatformPrivilegeField[];
}

export interface OpenPlatformPrivilegeState {
  privileges: OpenPlatformPrivilege[];
}

export type OpenPlatformAutomationResult =
  | {
      ok: true;
      sessionFile: string;
      sessionSource: FeishuWebSessionSource;
      cookieCount: number;
      scopeCount: number;
      skippedScopeCount: number;
      scopeWarning?: string;
      /**
       * 自动填好的「权限可访问的数据范围」条数（填成「与应用的可用范围一致」）。
       * 0 有两种成因：本来就没有待填的（常态），或写入失败（看
       * {@link privilegeRangeWarning}）——两者必须靠 warning 区分，别照 count 报「已配齐」。
       */
      privilegeRangeCount: number;
      /** 数据范围读取/写入失败的原因（非致命，仅影响后续审批快慢）。 */
      privilegeRangeWarning?: string;
      subscribedEventCount: number;
      eventWarning?: string;
      /** 回读后仍缺失的 VC 会议事件。普通建 bot 不阻断,VC listener 保存前必须为空。 */
      missingVcEvents: string[];
      /** 回读确认事件接收方式已是长连接(ok:true 时恒为 true,显式带回供门函数统一判定)。 */
      eventModeReady: boolean;
      /**
       * redirect 白名单是否写成功。白名单缺失 = authorize 直接 20029 硬失败
       * (群聊模式 / 会话群标签 / `/login` 全部授权不了),但它不阻断建 bot,
       * 所以必须显式带回,让调用方把「还差这一步」翻译成人话。
       */
      redirectConfigured: boolean;
      /** redirect 白名单写入失败的原因(仅 redirectConfigured=false 时有)。 */
      redirectWarning?: string;
      /** Managed onboarding only: exact same-session event mode readback. */
      eventMode?: number;
      /** Managed onboarding only: exact baseline event + callback count read back before session cleanup. */
      verifiedEventCount?: number;
      versionId?: string;
      /**
       * 本次因「无任何配置变更」而**跳过了 create+publish**。区别于「发了版但没解析到
       * versionId」：前者根本没建版（下游别去后台找不存在的草稿、也别把它当 warning）。
       */
      publishSkipped?: boolean;
      /**
       * 本次发布**复用了已存在的未提交草稿**（而不是新建版本）。撞上
       * `code=10043 版本已创建` 的历史卡死就是因为没这一步；带回来供调用方在日志里
       * 说清「提交了旧草稿」还是「发了新版本」。
       */
      versionReused?: boolean;
      /**
       * 版本提交后**回读发现它仍是草稿**（或回读本身失败）。`publish/commit` 回
       * `code=0` 不代表版本真的提交了——实测过 code=0 却留在草稿态，日志因此谎报
       * 「published」。有这个字段时**不能**对外宣称已发布。
       */
      versionWarning?: string;
      /**
       * 这一版提交后是否**秒过**（审批流全「自动通过」、零真人审批人）。
       * `undefined` = 判不出来（接口报错 / 算不出流程），调用方**不许**当成任一结论。
       */
      approvalAutoPassed?: boolean;
      /** 需要真人审批时，那些审批人的姓名（抄送人不算——抄送只知会、不阻塞）。 */
      approvalHumanApprovers?: string[];
    }
  | {
      ok: false;
      reason:
        | 'unsupported_brand'
        | 'missing_session'
        | 'invalid_session'
        | 'login_failed'
        | 'qr_expired'
        | 'timeout'
        | 'missing_csrf'
        | 'owner_session_mismatch'
        | 'scope_mapping_failed'
        | 'event_verification_failed'
        | 'version_verification_failed'
        | 'visibility_unreadable'
        | 'network'
        | 'api_error'
        /**
         * 应用正在飞书审核中（`code=10046`），开放平台把它的配置写入整体锁了。
         * **等待即自愈**，不是错误：审批通过后写操作恢复。与其它 reason 分开是为了让
         * 调用方既能说人话，又能跳过无意义的反复重试。
         */
        | 'app_under_review';
      message: string;
      sessionFile?: string;
      /** Number of events successfully subscribed (0 when event update failed before downstream error). */
      subscribedEventCount?: number;
      /** Warning from event subscription attempt, if any. */
      eventWarning?: string;
      /** 回读后仍缺失的 VC 会议事件(走到订阅阶段才有)。 */
      missingVcEvents?: string[];
      /** 事件接收方式是否回读确认为长连接(走到订阅阶段才有;早期失败为 undefined)。 */
      eventModeReady?: boolean;
      /** redirect 白名单是否写成功(csrf 就位后立刻尝试,失败不阻断本流程)。 */
      redirectConfigured?: boolean;
      /** redirect 白名单写入失败的原因。 */
      redirectWarning?: string;
      /** Managed onboarding exact event-mode ACK, preserved across later scope propagation failure. */
      eventMode?: number;
      /** Managed onboarding exact baseline count ACK, preserved across later scope propagation failure. */
      verifiedEventCount?: number;
      /** Exact published version ACK, preserved across later scope propagation failure. */
      versionId?: string;
      /**
       * `app_under_review` 专用：当前那个**待审版本**的 id（读不到时 undefined）。
       * 只用于上层「同一个待审版本别重复打扰管理员」的节流 key —— undefined 时上层
       * 自然退化成「不节流」，那是刻意的（见 automation 里 under_review 分支的注释）。
       */
      inReviewVersionId?: string;
    };

export interface OpenPlatformAutomationOptions {
  appId: string;
  brand?: 'feishu' | 'lark';
  sessionFilePath?: string;
  bytedcliFallbackSessionFilePath?: string;
  disableBytedcliFallback?: boolean;
  /** Ignore any shared cached account and require the exact App owner to scan. */
  forceQrLogin?: boolean;
  /** Reuse a valid cache or fail instead of presenting another QR. */
  disableQrLogin?: boolean;
  /** Require all baseline events/callbacks and a published version to be proven before managed activation. */
  requireVerifiedEvents?: boolean;
  /**
   * 「这个 app 是本次流程刚刚创建出来的」。**只有** setup / onboarding 的建应用链路
   * 能传 true。
   *
   * 唯一作用：允许 redirect 白名单在**读不到线上现值时**退化成覆盖写。刚建的应用
   * 白名单必然为空，覆盖不掉任何用户条目；对存量应用盲写则会静默清掉用户手配的
   * 回调地址（见 {@link WriteRedirectWhitelistOptions.allowBlindWrite}）。
   * 权限自愈 / VC 事件补订阅 / 批量修复这些跑在存量应用上的链路一律不传。
   */
  appJustCreated?: boolean;
  fetchImpl?: typeof fetch;
  scopeManifest?: ScopeManifest;
  /**
   * 调用方已经确知**当前已授权**的 scope 名字集合，**按 token 类型分桶**（来自
   * tenant-token `application/v6` 的 scope 列表，见 event-dispatcher 的
   * `checkRequiredScopes`——该接口每个 scope 条目自带 `token_types: (tenant|user)[]`）。
   *
   * 传入时，本函数会在**映射成 ID 之前**分别用 `tenant` / `user` 桶对 manifest 的
   * 对应桶做 name 差集，只对「该 token 类型下真正还没授权」的 scope 发 `scope/update`，
   * 并且**只在差集非空**时把 scope 记为一次变更（驱动末尾是否发版）。不传时保持历史
   * 行为：拿不到已授权信号，就以「发出过一次非空 scope/update」作为保守近似（宁可偶尔
   * 多发一版，也不少发导致新权限不生效）。
   *
   * ⚠️ 必须**按桶**做差、且在 name 空间做：`lark-scopes.json` 里约 121 个名字同时出现
   * 在 tenant 与 user 两个桶，而 tenant/user 是两份独立授权。若把已授权名字拍平成一个
   * 扁平集合去过滤两个桶，「tenant 已授权」会连带把 user 桶里的同名 scope 也误删，导致
   * 真正缺失的 user 侧权限被静默吞掉、永远补不上（PR #1044 R2）。catalog 映射后是 ID，
   * 与 name 不可直接比，故差集只能在 mapped 之前的 name 空间做。
   */
  grantedScopeNames?: { tenant: string[]; user: string[] };
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onQrCode?: (info: { qrText: string; qrPayload: string }) => void | Promise<void>;
  /** Emitted once only after Feishu reports this exact QR as scanned. */
  onQrScanConfirmed?: (info: { confirmedAt: number }) => void | Promise<void>;
  onStatus?: (message: string) => void | Promise<void>;
}


export type FeishuWebSessionSource = 'botmux_cache' | 'qr_login' | 'bytedcli_fallback';
export type FeishuWebSessionFailureReason = 'login_failed' | 'qr_expired' | 'timeout' | 'network' | 'invalid_session';

export type FeishuWebSessionPrepareResult =
  | {
      ok: true;
      sessionFile: string;
      source: FeishuWebSessionSource;
      cookies: StoredCookie[];
      cookieCount: number;
    }
  | {
      ok: false;
      reason: FeishuWebSessionFailureReason;
      message: string;
      sessionFile: string;
      fallbackSessionFile?: string;
    };

export interface FeishuWebSessionOptions {
  sessionFilePath?: string;
  bytedcliFallbackSessionFilePath?: string;
  disableBytedcliFallback?: boolean;
  /**
   * Ignore cached sessions and require a fresh QR login. Dashboard onboarding
   * uses this so the user always sees which account is authorizing the new app;
   * the resulting session is still cached for the remaining setup steps.
   */
  forceQrLogin?: boolean;
  /** Reuse a valid cache or fail; never present another QR code. */
  disableQrLogin?: boolean;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
  maxWaitMs?: number;
  onQrCode?: (info: { qrText: string; qrPayload: string }) => void | Promise<void>;
  /** Emitted once only after polling observes Feishu status=2 for this QR. */
  onQrScanConfirmed?: (info: { confirmedAt: number }) => void | Promise<void>;
  onStatus?: (message: string) => void | Promise<void>;
}

export type FeishuOpenPlatformSessionInspectionResult =
  | {
      ok: true;
      source: FeishuWebSessionSource;
      identity: FeishuWebSessionIdentity;
      sessionFile: string;
    }
  | {
      ok: false;
      reason: FeishuWebSessionFailureReason | 'missing_csrf' | 'identity_unavailable' | 'network';
      message: string;
      sessionFile?: string;
    };


export function parseSetupOpenPlatformAutoFlag(argv: string[]): boolean {
  let enabled = true;
  for (const arg of argv) {
    if (arg === '--open-platform-auto') enabled = true;
    if (arg === '--no-open-platform-auto') enabled = false;
  }
  return enabled;
}

export function botmuxFeishuSessionFilePath(configDir = join(homedir(), '.botmux')): string {
  return join(configDir, 'feishu-session.json');
}

export function bytedcliFeishuSessionFilePath(homeDir = homedir()): string {
  return join(homeDir, '.local', 'share', 'bytedcli', 'data', 'feishu_session.json');
}

export function readStoredCookiesFromSessionFile(filePath: string): StoredCookie[] | null {
  if (!existsSync(filePath)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const cookies = (parsed as { cookies?: unknown }).cookies;
  if (!Array.isArray(cookies)) return null;
  return pruneExpiredCookies(cookies.filter(isStoredCookieRecord));
}

export function readStoredCookiesFromBytedcliSession(filePath: string): StoredCookie[] | null {
  return readStoredCookiesFromSessionFile(filePath);
}

export function writeStoredCookiesToSessionFile(filePath: string, cookies: StoredCookie[]): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
  const tmpPath = join(dir, `.${basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    writeFileSync(tmpPath, JSON.stringify({ cookies: pruneExpiredCookies(cookies) }, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    renameSync(tmpPath, filePath);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore.
    }
  }
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Best-effort on non-POSIX filesystems.
  }
}

export function getCookieHeader(cookies: StoredCookie[], requestUrl: string): string {
  const url = new URL(requestUrl);
  return pruneExpiredCookies(cookies)
    .filter(cookie => {
      if (cookie.secure && url.protocol !== 'https:') return false;
      if (!domainMatches(url.hostname, cookie)) return false;
      return pathMatches(url.pathname || '/', cookie.path || '/');
    })
    .sort((a, b) => b.path.length - a.path.length)
    .map(cookie => `${cookie.name}=${cookie.value}`)
    .join('; ');
}

export function extractOpenPlatformCsrfToken(html: string): string | null {
  const match =
    html.match(/\bwindow\.csrfToken\s*=\s*(['"])([^'"]+)\1/) ??
    html.match(/\bcsrfToken\s*:\s*(['"])([^'"]+)\1/);
  return match?.[2] ?? null;
}

/**
 * 开发者后台把当前登录人写入 `window.user = {...}`。只提取创建前需要展示和
 * 比对的稳定字段，不把头像、功能开关等整段页面状态带进 Dashboard API。
 */
export function extractOpenPlatformSessionIdentity(html: string): FeishuWebSessionIdentity | null {
  const marker = /\bwindow\.user\s*=\s*/g;
  const match = marker.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  const json = extractBalancedJsonObject(html, start);
  if (!json) return null;
  let user: Record<string, unknown>;
  try {
    user = asRecord(JSON.parse(json));
  } catch {
    return null;
  }
  const userId = pickString(user, ['id', 'userId', 'user_id']);
  const userName = pickString(user, ['name', 'userName', 'user_name'])
    ?? pickString(asRecord(user.displayName), ['value']);
  const tenantId = pickString(user, ['tenantId', 'tenant_id']);
  const tenantName = pickString(asRecord(user.tenantDisplayName), ['value'])
    ?? pickString(user, ['tenantName', 'tenant_name']);
  if (!userId || !userName || !tenantId || !tenantName) return null;
  const email = pickString(user, ['email']);
  return { userId, userName, ...(email ? { email } : {}), tenantId, tenantName };
}

export function extractOpenPlatformScopeEntries(payload: unknown): OpenPlatformScopeEntry[] {
  const out: OpenPlatformScopeEntry[] = [];
  collectScopeEntries(payload, undefined, out);
  const seen = new Set<string>();
  return out.filter(entry => {
    const key = `${entry.bucket ?? 'any'}:${entry.name}:${entry.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function mapManifestScopesToOpenPlatformIds(
  manifest: ScopeManifest,
  catalog: OpenPlatformScopeEntry[],
): MappedScopeIds {
  const tenant = uniqueStrings(manifest.scopes?.tenant ?? []);
  const user = uniqueStrings(manifest.scopes?.user ?? []);
  return {
    tenantScopeIds: mapScopeIds(tenant, catalog, 'tenant').ids,
    userScopeIds: mapScopeIds(user, catalog, 'user').ids,
    missingTenantScopes: mapScopeIds(tenant, catalog, 'tenant').missing,
    missingUserScopes: mapScopeIds(user, catalog, 'user').missing,
  };
}

/**
 * 把整份 scope 清单裁到「只保留 `wantedNames` 里点名的权限」，tenant / user 分桶
 * **原样沿用 manifest 的归属**。
 *
 * 权限自愈只缺某几项时，历史实现把整份 {@link readDefaultScopeManifest}（300+ 项）
 * 全量 `operation:'add'` 追加进去——「用缺失项当触发器，却拿完整清单当申请集合」，
 * 于是补一个 `im:feed_group_v1:read` 会连带申请日历/文档/表格等一大批 botmux 自己
 * 都不校验的权限。调用方先用本函数把 manifest 裁成缺失项，再传给
 * {@link automateOpenPlatformSetup} 的 `scopeManifest`，申请集合就与缺失集合一致。
 *
 * ⚠️ 故意**不**自己猜 bucket：`im:feed_group_v1:*` 只在 user 桶、`im:resource` 只在
 * tenant 桶，同名权限也可能同时落两个桶（manifest 里有 121 项 tenant∩user 重叠）。
 * 以 manifest 的分桶为准，能落哪个桶就保留哪个桶，避免把 user 权限误当 tenant 申请。
 * 不在 manifest 里的名字直接落空（automation 侧的 catalog 映射也会把它算进
 * skippedScopeCount），不硬塞。
 */
export function filterScopeManifest(manifest: ScopeManifest, wantedNames: string[]): ScopeManifest {
  const wanted = new Set(uniqueStrings(wantedNames));
  return {
    scopes: {
      tenant: uniqueStrings(manifest.scopes?.tenant ?? []).filter(name => wanted.has(name)),
      user: uniqueStrings(manifest.scopes?.user ?? []).filter(name => wanted.has(name)),
    },
  };
}

/**
 * 从 `POST /developers/v1/privilege/all/<appId>` 的返回里解析「权限可访问的数据
 * 范围」条目。
 *
 * ⚠️ 这是**独立于 scope/update 的第二条链路**：`scope/update` 只把权限点加进
 * 应用清单，而每个权限点还可能带一份「这个权限能看到哪些数据」的配置（console
 * 上是权限详情里的「权限可访问的数据范围」单选：全部 / 与应用的可用范围一致 /
 * 按条件筛选）。两者的 appId 相同但接口、payload、生效时机全不一样。
 *
 * 第三条相关链路是 `contact_range`（通讯录权限范围），又是另一个概念，不在这里。
 */
export function extractOpenPlatformPrivileges(payload: unknown): OpenPlatformPrivilegeState {
  const data = asRecord(asRecord(payload).data);
  const rawPrivileges = Array.isArray(data.privileges) ? data.privileges : [];
  const rawBizNames = Array.isArray(data.scopeBiz) ? data.scopeBiz : [];
  const bizNames = new Map<string, string>();
  for (const biz of rawBizNames) {
    const record = asRecord(biz);
    const bizId = pickString(record, ['bizId', 'biz_id']);
    const bizName = pickString(record, ['bizName', 'biz_name']);
    if (bizId && bizName) bizNames.set(bizId, bizName);
  }
  const privileges: OpenPlatformPrivilege[] = [];
  for (const entry of rawPrivileges) {
    const record = asRecord(entry);
    const bizId = pickString(record, ['bizId', 'biz_id']);
    // resource 允许为空串（contact 这类整 biz 一条的形态），但 bizId 必须有：
    // 缺了它连合并键都拼不出来，写回去也定位不到条目。
    if (!bizId) continue;
    privileges.push({
      raw: record,
      bizId,
      resource: pickString(record, ['resource']) ?? '',
      name: pickString(record, ['name']) ?? '',
      bizName: bizNames.get(bizId) ?? '',
      isRequired: record.isRequired === true,
      content: pickString(record, ['content']) ?? '',
      schemaType: typeof record.schemaType === 'number' ? record.schemaType : undefined,
      organizationType: typeof record.organizationType === 'number' ? record.organizationType : undefined,
      fields: extractPrivilegeStaffFields(record),
    });
  }
  return { privileges };
}

/**
 * 「与应用的可用范围一致」在飞书 console 里的内部取值。console 前端把这三个
 * mode 定义在同一个 enum 上（`availability_of_app` / `part` / `all`），选中第
 * 二项时写进 filter value 的就是这个字符串。
 */
export const PRIVILEGE_RANGE_SAME_AS_APP_AVAILABILITY = 'availability_of_app';

/**
 * 判断某条数据范围**能不能**用「与应用的可用范围一致」自动填。
 *
 * console 的判据（`em()` / `om()`，CDP 读前端 bundle 确认）是
 * `schemaType === SelectionExpression(1) && organizationType === InternalOrganization(1)`；
 * 在此之上本函数额外要求每个字段都是「选人」类型且支持 `in` 操作符，因为
 * `availability_of_app` 是**成员范围**语义——把它塞进「工作地点」这类字符串
 * 字段是无意义的（DLP 那条 privilege 就同时有 `member_range` 和 `place` 两个
 * 字段）。字段里只要有一个不满足就整条跳过，宁可留给人手配，也不猜一个可能
 * 被审核驳回的组合。
 */
export function canFillPrivilegeWithAppAvailability(privilege: OpenPlatformPrivilege): boolean {
  if (privilege.schemaType !== PRIVILEGE_SCHEMA_TYPE_SELECTION_EXPRESSION) return false;
  if (privilege.organizationType !== PRIVILEGE_ORG_TYPE_INTERNAL) return false;
  if (!privilege.fields.length) return false;
  return privilege.fields.every(field => field.selectStaff && field.supportsIn);
}

/**
 * 构造一条数据范围的 `content`——即 console 上选「与应用的可用范围一致」后保存
 * 的那个字符串。
 *
 * 形态是**逐字节复刻 console** 的（拿 6 个已由人手在 console 配好的线上应用
 * 对照，5 个完全相同，第 6 个只有 `description` 里的权限显示名是飞书改名前的
 * 旧文案 —— 说明 description 纯展示、不参与语义）：
 *   • `mode: 'part'` + 每个字段一条 `in` filter，filter value 是**再套一层
 *     JSON 字符串**的 `[{mode:'availability_of_app',members:[],…}]`
 *   • `expression` 是 filter 的 1-based 序号用 ` and ` 连起来
 *   • `description` 是给人看的摘要（console 的 `GC()` 拼的同款）
 */
export function buildPrivilegeAppAvailabilityContent(privilege: OpenPlatformPrivilege): string {
  const filters = privilege.fields.map(field => ({
    field: field.id,
    value: JSON.stringify([{
      mode: PRIVILEGE_RANGE_SAME_AS_APP_AVAILABILITY,
      members: [] as string[],
      departments: [] as string[],
      groups: [] as string[],
    }]),
    operator: 'in',
  }));
  const description =
    `${privilege.bizName} - ${privilege.name}\n`
    + privilege.fields.map(field => `\t${field.name} 包含 与应用的可用范围一致 `).join('')
    + '\n';
  return JSON.stringify({
    biz_id: privilege.bizId,
    mode: 'part',
    resource: privilege.resource,
    filters,
    expression: filters.map((_, index) => index + 1).join(' and '),
    description,
  });
}

/**
 * 这条数据范围是否已经被**收敛过**（即不需要我们再动它）。
 *
 * ⚠️ 不能简单判 `content` 非空。实测「一键创建智能体」模板建出来的应用，出生就
 * 带着 `{"mode":"all"}`（console 上显示为选中「全部」）——正是审批规则里要额外
 * 说明理由、视情况加签至 CEO-2 的那一档。按「有 content 就算配过」会把这个默认
 * 值当成用户的选择而跳过，于是新建 bot 永远带着「全部」提审，改动完全空转。
 *
 * 所以判据是「**已收敛到 all 以外**」：
 *   • `mode:'all'`（全部）→ 需要我们收窄，视为未配置
 *   • `mode:'part'` 但 `filters` 为空 → console 自己的 `XC()` 也不认这算配置好
 *     （它要求 `mode==='all' || filters.length>0`），是个「看着配过、其实空」的
 *     中间态，同样视为未配置
 *   • `mode:'part'` 且有 filters / 其它 → 人为或我们之前配过的具体范围，绝不覆盖
 *   • 空 / `mode` 缺失 / `mode:'null'`（console 的「无」）→ 未配置
 */
export function isPrivilegeRangeNarrowed(privilege: OpenPlatformPrivilege): boolean {
  if (!privilege.content) return false;
  let parsed: Record<string, unknown>;
  try {
    parsed = asRecord(JSON.parse(privilege.content));
  } catch {
    // content 存在但不是合法 JSON:不敢当成"配过了",也不敢覆盖——保守视为已配置,
    // 交给人处理(覆盖一个读不懂的值风险更大)。
    return true;
  }
  const mode = parsed.mode;
  if (typeof mode !== 'string' || mode === '' || mode === 'all' || mode === 'null') return false;
  // 与 console 的 XC() 对齐：非 all 的 mode 必须真的带上筛选条件才算配置好。
  return Array.isArray(parsed.filters) && parsed.filters.length > 0;
}

/**
 * 挑出「必须配、但还没收敛」且能安全自动填的数据范围条目。
 *
 * 只取 `isRequired`：console 自己的 gate（`jC()`）也只强制这一档，实测线上租户
 * 84 条 privilege 条目里 required 的只有 2 条（会议号查询会议信息 / 创建更新
 * 任务时可指定的人员范围）。已经收敛到具体范围的一律不碰——那可能是人手精心配
 * 过的，覆盖它比不配更糟；但模板默认的 `mode:'all'` **要**收窄（见
 * {@link isPrivilegeRangeNarrowed}）。
 */
export function selectPrivilegesNeedingAppAvailability(
  state: OpenPlatformPrivilegeState,
): OpenPlatformPrivilege[] {
  return state.privileges.filter(privilege =>
    privilege.isRequired
    && !isPrivilegeRangeNarrowed(privilege)
    && canFillPrivilegeWithAppAvailability(privilege));
}

/**
 * 构造 `POST /developers/v1/privilege/update/<appId>` 的 payload。
 *
 * ⚠️ 与 {@link buildSafeSettingPayload}（全量覆盖）**语义相反**：实测服务端按
 * `(bizId, resource)` **增量合并**——只传 1 条、改动它，同一应用里另一条已配好
 * 的数据范围逐字节不变。所以这里只传「本次要填的那几条」，不必像 console 前端
 * 那样把 84 条整包读回来再写。
 *
 * 每条都在原始条目上浅拷贝改 `content`，其余字段（schema / privilegeStatus /
 * isRequired…）原样回传，避免把服务端还会读的字段丢掉。
 */
export function buildPrivilegeUpdatePayload(appId: string, privileges: OpenPlatformPrivilege[]) {
  return {
    clientId: appId,
    privileges: privileges.map(privilege => ({
      ...privilege.raw,
      content: buildPrivilegeAppAvailabilityContent(privilege),
    })),
  };
}

/**
 * 读 `privilege/all` → 把「必须配但还没收敛」的数据范围写成「与应用的可用范围
 * 一致」。返回实际写了几条（0 = 没有待收窄的）。
 *
 * 抽成共享函数是因为**两条路径都必须做**，且各自发的是不同的版本：
 *   • {@link createOpenPlatformAppWithClient} —— 模板建完立刻发第一版
 *   • {@link automateOpenPlatformSetup} —— 权限自愈 / 补配时发下一版
 * 只做前者，存量 bot 永远不收窄；只做后者，新建 bot 的第一版仍带「全部」提审。
 *
 * 调用方决定失败怎么处理（两处都是非致命，但一处 warn 一处进 result.warning）。
 */
/**
 * 只读探查「这个应用为什么可能卡审批」，给管理员 DM 里补一句**具体线索**。
 *
 * 为什么值得单独探一次：光说「可能是数据范围没配」是转述，说「实测这两条现在是
 * 『全部/未配置』」才是证据 —— 人拿着它能直接去 console 对应位置改。审核锁只锁写，
 * `privilege/all` 这类读接口照常可用（实测），所以这次探查在审核中也能成功。
 *
 * 全程 best-effort：任何一步失败就返回空串，绝不让「补充线索」这种附加信息把主流程
 * （告诉管理员卡住了）搞坏。
 */
export async function inspectUnderReviewConfigHints(appId: string, brand?: 'feishu' | 'lark'): Promise<string> {
  if (brand === 'lark') return '';
  try {
    const prepared = await prepareFeishuWebSession({ disableQrLogin: true, disableBytedcliFallback: true });
    if (!prepared.ok) return '';
    const clientResult = await createOpenPlatformApiClient(prepared.cookies);
    if (!clientResult.ok) return '';
    const post = clientResult.client.postJson;
    const parts: string[] = [];
    // ① 数据范围：把「还没收敛」的必填条目点出来（这正是最常见的卡审批原因）
    try {
      const state = extractOpenPlatformPrivileges(await post(`/developers/v1/privilege/all/${appId}`, {}));
      const unnarrowed = state.privileges.filter(p => p.isRequired && !isPrivilegeRangeNarrowed(p));
      if (unnarrowed.length > 0) {
        const listed = unnarrowed.map(p => `${p.bizName || p.bizId}/${p.name || p.resource}`).join('、');
        parts.push(`实测该应用有 ${unnarrowed.length} 项必填「数据范围」尚未收敛（${listed}）——大概率就是卡点`);
      } else {
        parts.push('实测必填「数据范围」都已收敛，卡点可能是别的规则（看审批详情）');
      }
    } catch { /* 读不到就不提数据范围 */ }
    // ② 租户审批规则原文链接：比我们转述强 —— 万一卡的是别的规则，链接照样有用。
    // body 传空 `{}` 即可：实测跨 3 台（有草稿 / 审核中 / 无待发布版本）对照过
    // `{}` 与 `{versionId}`，两者返回**逐字相同**（都拿到 auditUrl + 452 字的
    // auditSummary）⟹ 该端点返回的是**租户级**规则、与具体版本无关，不必透传 versionId。
    try {
      const rule: any = await post(`/developers/v1/config/audit_rule/${appId}`, {});
      const auditUrl = pickString(asRecord(asRecord(rule).data), ['auditUrl']);
      if (auditUrl) parts.push(`企业审批规则原文：${auditUrl}`);
    } catch { /* 拿不到链接不影响其余线索 */ }
    return parts.length > 0 ? `\n\n**线索**：${parts.join('；')}。` : '';
  } catch {
    return '';
  }
}

async function narrowRequiredPrivilegeRanges(
  api: { postJson(path: string, body?: unknown): Promise<unknown> },
  appId: string,
): Promise<number> {
  const state = extractOpenPlatformPrivileges(await api.postJson(`/developers/v1/privilege/all/${appId}`, {}));
  const needFill = selectPrivilegesNeedingAppAvailability(state);
  if (needFill.length === 0) return 0;
  await api.postJson(`/developers/v1/privilege/update/${appId}`, buildPrivilegeUpdatePayload(appId, needFill));
  return needFill.length;
}

export function buildScopeUpdatePayload(appId: string, mapped: Pick<MappedScopeIds, 'tenantScopeIds' | 'userScopeIds'>) {
  return {
    clientId: appId,
    appScopeIDs: mapped.tenantScopeIds,
    userScopeIDs: mapped.userScopeIds,
    scopeIds: [],
    operation: 'add',
    isDeveloperPanel: true,
  };
}

export function buildSafeSettingPayload(appId: string, extraRedirectUrls: string[] = []) {
  return {
    clientId: appId,
    // 默认本机回贴地址 + 可选的 dashboard 自动回调地址（global-config
    // oauthRedirectBase 场景）。去重保持幂等。
    // ⚠️ 这里是**全量覆盖**语义：给什么，白名单就是什么。调用方必须先用
    // {@link writeRedirectWhitelist} 读回线上现值并合并，不要直接拿几条
    // botmux 自己的地址来调它——那会把用户手配的其它回调地址静默清掉。
    redirectURL: [...new Set([BOTMUX_REDIRECT_URL, ...extraRedirectUrls])],
  };
}

/**
 * botmux 自己知道的、应当出现在 redirect 白名单里的全部回调地址。
 *
 * 只有 `http://127.0.0.1:9768/callback` 是常量兜底（粘贴回调那条链路）；另外三条
 * 都是「本机 dashboard 对外可达基址」的不同来源，存在才追加 `<base>/oauth/callback`：
 *   • `oauthRedirectBase`（用户在 global-config 里手填的对外基址）
 *   • `platformMachineBaseUrl()`（接了中心平台 → `https://m-<machineId>.<平台域名>`）
 *   • `publicReverseProxyBaseUrl()`（自建反代 `BOTMUX_PUBLIC_URL`）
 * 今天这三条一条都没写进去，正是「配了 oauthRedirectBase 也还是要手动粘贴回调」的根因。
 *
 * ⚠️ 故意**不**推导「本机 host:port」：飞书白名单对**非 loopback 的明文 http**
 * 到底收不收、收了 authorize 时会不会仍报 20029，都还没实测过（见方案 T2）。
 * 猜一条塞进去，失败时会连累整批写入（虽然有最小集兜底，但白白多一次往返），
 * 而且 LAN 地址对话题里的其他人本来就不一定可达。等 T2 实测有结论再加。
 */
export function collectBotmuxRedirectUrls(): string[] {
  const urls: string[] = [BOTMUX_REDIRECT_URL];
  const pushBase = (base: string | null | undefined) => {
    const trimmed = base?.trim().replace(/\/+$/, '');
    if (trimmed && /^https?:\/\//.test(trimmed)) urls.push(`${trimmed}/oauth/callback`);
  };
  // 三个来源各自独立 try/catch：配置读不动 / 未绑定平台都不该拖垮其它两条。
  try { pushBase(readGlobalConfig().oauthRedirectBase); } catch { /* config unavailable */ }
  try { pushBase(platformMachineBaseUrl()); } catch { /* not bound to a platform */ }
  try { pushBase(publicReverseProxyBaseUrl()); } catch { /* env unavailable */ }
  return uniqueStrings(urls);
}

// verify-permissions 的 buildRemainingSteps 要按实际配置列重定向 URL，但它**不能**
// 反向 import 本模块（本模块在顶层 const 里用它的 VC_MEETING_BOT_EVENTS，静态互引
// 会 TDZ 崩）。所以由本模块单向把函数注册过去，依赖方向仍是 automation →
// verify-permissions 一条边。
registerBotmuxRedirectUrlCollector(collectBotmuxRedirectUrls);

/**
 * 从 `POST /developers/v1/safe_setting/<appId>` `{}` 的返回里解析现有 redirect 白名单。
 *
 * 返回 `null` 表示**没读出来**（端点不存在 / 结构变了 / 报错），与「读到了但是空数组」
 * 严格区分：前者只能退化成覆盖写（保住 botmux 自己能用），后者可以放心合并。
 * 实测返回形态（feishu.cn 租户，2026-08）：
 * `{code:0, data:{allowRefreshToken, ipWhiteList:[], redirectURL:[...], safeServerDomain:[]}}`。
 */
export function extractOpenPlatformRedirectUrls(payload: unknown): string[] | null {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const raw = data.redirectURL ?? data.redirectUrl ?? data.redirectURLs;
  if (!Array.isArray(raw)) return null;
  return uniqueStrings(raw.map(item => (typeof item === 'string' ? item.trim() : '')));
}

/** `automateOpenPlatformSetup` 内联 postJson / `OpenPlatformApiClient.postJson` 的公共形状。 */
export type OpenPlatformPostJson = (path: string, body?: unknown) => Promise<unknown>;

export interface RedirectWhitelistWriteResult {
  /**
   * • `unchanged`          — 幂等短路没发写请求
   * • `updated`            — 写了全集
   * • `updated_fallback`   — 全集被拒、退到最小集
   * • `skipped_unreadable` — 读不到线上现值且未获盲写授权 → **一次写请求都没发**
   */
  status: 'unchanged' | 'updated' | 'updated_fallback' | 'skipped_unreadable';
  /** 线上现有白名单（读不出来时为 null）。 */
  existing: string[] | null;
  /** 本次实际落地（或确认已在线上）的白名单。`skipped_unreadable` 时为空数组。 */
  redirectUrls: string[];
  /** `skipped_unreadable` 时的人话说明，由调用方记成 warning。 */
  warning?: string;
}

/**
 * 「这次想写的地址里，有哪几条最终没落在线上」——redirect 白名单**是否算配置成功**的
 * 唯一判据。
 *
 * 纯函数（无 IO、无状态），由 {@link automateOpenPlatformSetup} 与
 * `open-platform-redirect-repair.ts` 的批量修复**共用同一份结果**：两处各写一份完整性
 * 判断必然漂移——automation 曾经只特判 `skipped_unreadable`、其余一律报「已配置」，于是
 * `updated_fallback`（按定义至少漏掉一条 wanted）被假报成成功，用户拿到一个建好了、
 * 一授权就 20029 的 bot。
 *
 * 按**实际落盘结果**逐条核对 `wanted`，而不是特判某个 status：今天只有
 * `updated_fallback` 会漏条（最小集 = 线上现值 ∪ 本机回调，超出这个范围的 wanted 都被
 * 丢了），但兜底集的构成一旦调整，只有「拿 wanted 对一遍实际结果」这条判据不会跟着错。
 *
 * ⚠️ `skipped_unreadable`（读不到线上现值 → 一次写请求都没发）**不走这条路**：它是
 * 「没写」而不是「写漏了」，两者的下一步完全不同（前者要先修登录态/权限，后者去后台
 * 补地址），由两个调用方各自单独特判并给出区分开的措辞。
 */
export function missingRedirectUrls(wanted: string[], written: string[]): string[] {
  const live = new Set(written);
  return uniqueStrings(wanted).filter(url => !live.has(url));
}

export interface WriteRedirectWhitelistOptions {
  /**
   * 允许「读不出线上现值时直接全量覆盖写」。
   *
   * `buildSafeSettingPayload` 是全量覆盖语义，所以盲写 = 把线上白名单替换成
   * `wanted`。对**存量应用**这会静默清掉用户自己配的回调地址，违反「绝不删用户
   * 条目」契约；读接口只要抖一下（瞬时网络 / 结构变化 / 权限异常）就会踩到。
   * 因此默认 false：读不出来就零写入、回 `skipped_unreadable`。
   *
   * 只有调用方能**证明这个 app 是本次自动化刚刚创建出来的**（白名单必然为空，
   * 覆盖不掉任何东西）才允许传 true —— 见 `OpenPlatformAutomationOptions.appJustCreated`。
   */
  allowBlindWrite?: boolean;
}

/**
 * 读 → 合并 → 写 redirect 白名单，**绝不删用户已有条目**。
 *
 * `buildSafeSettingPayload` 是全量覆盖语义，历史实现直接拿 botmux 自己那几条去调，
 * 于是每次建 bot / 权限自愈都把用户在后台手配的其它回调地址静默清空。这里先读回
 * 线上现值再取并集。
 *
 * ⚠️ **读不出来时默认零写入**（`skipped_unreadable`）。历史实现在这里退化成全量
 * 覆盖写，等于把「读接口抖了一下」翻译成「清掉用户的自定义回调」——同一个契约违约，
 * 只是触发条件更隐蔽。只有 {@link WriteRedirectWhitelistOptions.allowBlindWrite}
 * （调用方能证明 app 是刚创建的）才恢复覆盖写。
 *
 * `postJson` 走参数注入而不是闭包捕获，是为了「批量修复存量 bot」能直接复用同一段
 * 逻辑——那条路径必须走 {@link createOpenPlatformApiClient}（它的 referer 是通用的
 * `<origin>/app`，可对任意 appId 调用），而不是 `automateOpenPlatformSetup` 里那份
 * referer 绑死单个 appId 的内联 postJson。
 *
 * 写失败时**只在「URL 被 console 判非法」这一类错误上**兜底重试一次「线上现值 ∪
 * 127.0.0.1 那条」：`wanted` 里某条 URL 的格式被拒时整批会一起失败，最小集能保住
 * 最核心的粘贴回调链路。网络抖动 / 403 鉴权失败不做第二次改写（见
 * {@link isRedirectUrlRejectedError}）。两次都失败才抛出，由调用方记成 warning
 * （不阻断建 bot）。
 */
export async function writeRedirectWhitelist(
  postJson: OpenPlatformPostJson,
  appId: string,
  wanted: string[] = collectBotmuxRedirectUrls(),
  options: WriteRedirectWhitelistOptions = {},
): Promise<RedirectWhitelistWriteResult> {
  let existing: string[] | null = null;
  let readError: string | undefined;
  try {
    const payload = await postJson(`/developers/v1/safe_setting/${appId}`, {});
    existing = extractOpenPlatformRedirectUrls(payload);
    if (existing === null) readError = '返回体里没有可识别的 redirectURL 数组';
  } catch (err: any) {
    // 端点不存在 / 网络抖动 / 403 → 当作读不出来。
    existing = null;
    readError = safeErrorMessage(err);
  }

  if (existing === null && !options.allowBlindWrite) {
    // 零写入：盲写会把线上白名单整体替换掉，读失败恰恰意味着「不知道线上有什么」。
    return {
      status: 'skipped_unreadable',
      existing: null,
      redirectUrls: [],
      warning: `读不到开放平台现有 redirect 白名单（${readError ?? '未知原因'}），为避免覆盖用户自定义回调地址，本次未写入`,
    };
  }

  const wantedUrls = uniqueStrings(wanted);
  if (existing !== null && wantedUrls.every(url => existing!.includes(url))) {
    // 幂等短路：想要的全在线上了，一次写请求都不发。
    return { status: 'unchanged', existing, redirectUrls: existing };
  }

  const merged = existing === null ? wantedUrls : uniqueStrings([...existing, ...wantedUrls]);
  const mergedPayload = buildSafeSettingPayload(appId, merged);
  try {
    await postJson(`/developers/v1/safe_setting/update/${appId}`, mergedPayload);
    return { status: 'updated', existing, redirectUrls: mergedPayload.redirectURL };
  } catch (err: any) {
    // 兜底只针对「某条 URL 被判非法」——网络异常重发同样会失败，403 重发只会再被拒，
    // 两者都只是白白多打一次 console。
    if (!isRedirectUrlRejectedError(err)) throw err;
    const minimalPayload = buildSafeSettingPayload(
      appId,
      existing === null ? [] : uniqueStrings([...existing, BOTMUX_REDIRECT_URL]),
    );
    // 最小集与刚被拒的全集一样 → 失败与「多余条目」无关，重发同一份没有意义。
    if (sameRedirectSet(minimalPayload.redirectURL, mergedPayload.redirectURL)) throw err;
    try {
      await postJson(`/developers/v1/safe_setting/update/${appId}`, minimalPayload);
    } catch (fallbackErr: any) {
      // `cause` 挂首次失败的**原始错误对象**（而不是只把它拼进字符串）：批量修复
      // 要靠 `OpenPlatformApiError` 的 status/code 把「这个 app 不属于当前登录账号」
      // （403 / code=10003）与普通写失败分开，字符串里拿不到状态码。首次失败的文案
      // 不重复拼进 message，交给 safeErrorMessage 顺 cause 链取——否则同一句会出现两遍。
      throw new Error(
        `全集与最小集兜底两次写入均失败（最小集: ${safeErrorMessage(fallbackErr)}）`,
        { cause: err },
      );
    }
    return { status: 'updated_fallback', existing, redirectUrls: minimalPayload.redirectURL };
  }
}

function sameRedirectSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every(item => set.has(item));
}

/**
 * 主题词：这句报错在说「某个 URL / 回调地址」。
 * 单独出现不构成拒绝（`redirect rate limited` 也含 redirect）。
 */
const REDIRECT_URL_SUBJECT_KEYWORDS = [
  'url', 'uri', 'redirect', 'callback', '回调', '重定向', '链接',
];

/**
 * 拒绝词：这句报错在说「它不合法 / 格式不对 / 不被接受」。
 * 同样单独出现不构成拒绝（`invalid csrf token` 也含 invalid）。
 */
const REDIRECT_URL_REJECTION_KEYWORDS = [
  'invalid', 'illegal', 'malformed', 'format', 'not allowed', 'not supported', 'unsupported',
  '非法', '不合法', '格式', '不支持', '不允许',
];

/**
 * 把一张关键词表编译成匹配函数：**英文/ASCII 词按词边界（独立单词）匹配，中文词按子串**。
 *
 * 英文必须卡词边界，否则普通单词内部的片段会被当成命中，实测三例：
 *   - `security token invalid`：`security` 里含 `uri`（主题词）+ `invalid`（拒绝词）
 *   - `invalid operation during request`：`during` 里含 `uri`
 *   - `callback information unavailable`：`information` 里含 `format`
 * 三句都与「白名单里有条非法 URL」毫无关系，裸 `includes` 却会让 botmux 再改一次
 * 线上安全设置。多词短语（`not allowed`）按整条短语卡首尾词边界；结尾允许一个复数
 * `s`（`one of the urls is invalid` 仍算主题命中），词内片段依旧不算。
 *
 * 中文没有词边界概念（`回调地址非法` 本就连写，`\b` 在中文串里也失去意义），继续 includes。
 * 大小写不敏感沿用旧行为：ASCII 正则带 `i`，中文无大小写之分。
 */
function compileKeywordMatcher(keywords: string[]): (message: string) => boolean {
  // 纯 ASCII 可打印字符 = 英文单词/短语；含中文的走 includes。
  const isAscii = (keyword: string) => /^[\x20-\x7e]+$/.test(keyword);
  // 关键词表里目前没有正则元字符，仍转义一次，免得以后加词时静默变成正则。
  const asciiWords = keywords.filter(isAscii).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const cjkKeywords = keywords.filter(keyword => !isAscii(keyword));
  const wordPattern = asciiWords.length > 0
    ? new RegExp(`\\b(?:${asciiWords.join('|')})s?\\b`, 'i')
    : null;
  return (message: string) => (wordPattern?.test(message) ?? false)
    || cjkKeywords.some(keyword => message.includes(keyword));
}

const matchesRedirectUrlSubject = compileKeywordMatcher(REDIRECT_URL_SUBJECT_KEYWORDS);
const matchesRedirectUrlRejection = compileKeywordMatcher(REDIRECT_URL_REJECTION_KEYWORDS);

/**
 * 判断一次 `safe_setting/update` 失败是不是「白名单里某条 URL 被 console 判非法」——
 * 只有这一类才值得用最小集再写一次。
 *
 * ⚠️ 开放平台没有公开这个端点的错误码表，仓库里也没有实测记录（截至本次改动），
 * 所以做不到「按 code 精确判定」。这里按**保守**顺序判：
 *   1. 传输层失败（fetch failed / ECONNRESET…）→ false。重发只会再失败一次。
 *   2. HTTP 401/403 或 console 的 owner 拒绝码 → false。这是鉴权问题，与写什么无关，
 *      重发还会被拒，而且会把 `not_owned` 的判定链拉长。
 *   3. HTTP 408/409/429 与所有 5xx → false。超时 / 冲突 / 限流 / 服务端故障都与
 *      「写了什么」无关，立刻改小重发只会再吃一次限流或再撞一次冲突。
 *   4. 其余（含 `code!=0` 的业务拒绝）→ **主题词 AND 拒绝词双命中**才算：文案里既要
 *      出现 url/uri/redirect/callback/回调/重定向/链接 这类**说的是地址**的词，又要出现
 *      invalid/illegal/malformed/format/not allowed/unsupported/非法/格式/不支持 这类
 *      **说它被拒**的词。英文词必须是**独立单词**（词边界），不认词内片段——
 *      `security token invalid`（security 含 uri）、`invalid operation during request`
 *      （during 含 uri）、`callback information unavailable`（information 含 format）
 *      这三句实测都会被裸 `includes` 判成双命中，见 {@link compileKeywordMatcher}。
 *
 * 曾经是一张 OR 关键词表，任一命中就兜底重写一次线上配置——`invalid csrf token`
 *（实测会误触发）、`operation not allowed` 这类与白名单毫无关系的报错都会让 botmux
 * 再写一次开放平台安全设置。判不出来就**不**兜底：少一次可能有用的重试，好过在
 * 网络 / 鉴权 / 限流故障上多改一次线上配置。
 */
function isRedirectUrlRejectedError(err: unknown): boolean {
  if (isLikelyTransientNetworkError(err)) return false;
  if (err instanceof OpenPlatformApiError) {
    if (err.status === 401 || err.status === 403) return false;
    if (err.status === 408 || err.status === 409 || err.status === 429) return false;
    if (err.status >= 500) return false;
    if (openPlatformOwnerAccessDenied(err)) return false;
  }
  const message = safeErrorMessage(err);
  return matchesRedirectUrlSubject(message) && matchesRedirectUrlRejection(message);
}

/**
 * Build the incremental event-subscription payload used by the developer
 * console (`updateEvent` in the console frontend bundle):
 * `{clientId, operation:'add', events, appEvents, userEvents, eventMode}`。
 * eventMode 必须回填读接口返回的当前值,事件按接收身份分桶(应用/用户)。
 */
export function buildEventSubscriptionPayload(
  appId: string,
  eventMode: number,
  appEvents: string[],
  userEvents: string[],
  events: string[] = [],
) {
  return {
    clientId: appId,
    operation: 'add',
    events,
    appEvents,
    userEvents,
    eventMode,
  };
}

/** 同款增量契约的回调版(console frontend `updateCallback`)。 */
export function buildCallbackSubscriptionPayload(appId: string, callbackMode: number, callbacks: string[]) {
  return {
    clientId: appId,
    operation: 'add',
    callbacks,
    callbackMode,
  };
}

export interface OpenPlatformEventState {
  eventMode?: number;
  /** 所有已订阅事件(顶层 events + 应用/用户身份分组的并集)。 */
  events: string[];
  appEvents: string[];
  userEvents: string[];
}

export interface OpenPlatformCallbackState {
  callbackMode?: number;
  callbacks: string[];
}

/** Extract the event mode and subscribed event ids from `/developers/v1/event/:clientId`. */
export function extractOpenPlatformEventState(payload: unknown): OpenPlatformEventState {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const appEvents = uniqueStrings([
    ...extractEventIds(data.appEvents),
    ...extractEventIdsFromDetails(data.appEventDetails),
  ]);
  const userEvents = uniqueStrings([
    ...extractEventIds(data.userEvents),
    ...extractEventIdsFromDetails(data.userEventDetails),
  ]);
  const genericEvents = uniqueStrings([
    ...extractEventIds(data.events),
    ...extractEventIdsFromDetails(data.eventDetails),
  ]);
  const eventMode = typeof data.eventMode === 'number' && Number.isFinite(data.eventMode)
    ? data.eventMode
    : undefined;
  return {
    eventMode,
    events: uniqueStrings([...genericEvents, ...appEvents, ...userEvents]),
    appEvents,
    userEvents,
  };
}

/** Extract the callback mode and subscribed callback ids from `/developers/v1/callback/:clientId`. */
export function extractOpenPlatformCallbackState(payload: unknown): OpenPlatformCallbackState {
  const root = asRecord(payload);
  const wrapped = asRecord(root.data);
  const data = Object.keys(wrapped).length > 0 ? wrapped : root;
  const callbackMode = typeof data.callbackMode === 'number' && Number.isFinite(data.callbackMode)
    ? data.callbackMode
    : undefined;
  return { callbackMode, callbacks: extractEventIds(data.callbacks) };
}

function extractEventIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value
    .map(item => typeof item === 'string' ? item : pickString(asRecord(item), ['id']))
    .filter((item): item is string => Boolean(item)));
}

function extractEventIdsFromDetails(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.flatMap(group => extractEventIds(asRecord(group).items)));
}

/**
 * 应用版本创建 payload,与 console launcher「一键创建智能体」同款极简结构
 * (CDP 抓包确认)。⚠️不要重新加回 applyReasonConfig / isAutoAudit:false ——
 * 那会让版本进入人工审核、发布后应用停在「未上架/未启用」(tenantAppStatus=0),
 * 事件配置进了草稿也无法在企业内生效。visibleSuggest.members 必须含创建者,
 * 否则同样不会自动上架启用。
 *
 * ⚠️ **visibleSuggest 是全量覆写语义**：这里给什么,新版本的可见范围就是什么,
 * 没给的集合会被清空而不是保持原样。因此**只有全新应用的首次发布**能用这个
 * 默认的空 departments/groups + isAll:0 —— 对已有应用发版,调用方必须先用
 * {@link parseOnlineVisibility} 读回线上可见范围并整块覆盖 visibleSuggest /
 * blackVisibleSuggest（见 automateOpenPlatformSetup 与 open-platform-rename）。
 * 曾经漏掉这一步,导致每次权限自愈自动发版都把「全员可见 / 部门 / 用户组」
 * 静默清空。
 */
export function buildAppVersionCreatePayload(appVersion: string, visibleMemberIds: string[] = []) {
  return {
    appVersion,
    mobileDefaultAbility: 'bot',
    pcDefaultAbility: 'bot',
    changeLog: 'Initial bot release.',
    visibleSuggest: {
      departments: [],
      members: visibleMemberIds,
      groups: [],
      isAll: 0,
    },
    blackVisibleSuggest: {
      departments: [],
      members: [],
      groups: [],
      isAll: 0,
    },
  };
}

export function buildFeishuQrPayload(token: string): string {
  return JSON.stringify({ qrlogin: { token } });
}

export function mapFeishuQrPollingStatus(status: number | null): string {
  if (status === 2) return '已经扫码，等待手机确认';
  if (status === 5) return '二维码已过期';
  return '等待飞书扫码';
}

export async function prepareFeishuWebSession(
  options: FeishuWebSessionOptions = {},
): Promise<FeishuWebSessionPrepareResult> {
  const fetcher = options.fetchImpl ?? fetch;
  const sessionFile = options.sessionFilePath ?? botmuxFeishuSessionFilePath();
  if (!options.forceQrLogin) {
    const cached = readStoredCookiesFromSessionFile(sessionFile);
    if (cached && cached.length > 0 && await validateFeishuWebSession(cached, fetcher)) {
      return {
        ok: true,
        sessionFile,
        source: 'botmux_cache',
        cookies: cached,
        cookieCount: cached.length,
      };
    }
  }

  if (options.disableQrLogin) {
    return {
      ok: false,
      reason: 'invalid_session',
      message: '没有可复用的 Feishu Web session；为避免意外出现第二个二维码，已停止自动登录',
      sessionFile,
    };
  }

  let loginError: unknown;
  try {
    const loggedIn = await loginFeishuWebSession(fetcher, options);
    writeStoredCookiesToSessionFile(sessionFile, loggedIn);
    return {
      ok: true,
      sessionFile,
      source: 'qr_login',
      cookies: loggedIn,
      cookieCount: loggedIn.length,
    };
  } catch (err) {
    loginError = err;
  }

  const fallbackSessionFile = options.bytedcliFallbackSessionFilePath ?? bytedcliFeishuSessionFilePath();
  if (!options.forceQrLogin && !options.disableBytedcliFallback) {
    const fallback = readStoredCookiesFromBytedcliSession(fallbackSessionFile);
    if (fallback && fallback.length > 0 && await validateFeishuWebSession(fallback, fetcher)) {
      writeStoredCookiesToSessionFile(sessionFile, fallback);
      return {
        ok: true,
        sessionFile,
        source: 'bytedcli_fallback',
        cookies: fallback,
        cookieCount: fallback.length,
      };
    }
  }

  return {
    ok: false,
    reason: classifyFeishuLoginError(loginError),
    message: safeErrorMessage(loginError),
    sessionFile,
    fallbackSessionFile: options.disableBytedcliFallback || options.forceQrLogin ? undefined : fallbackSessionFile,
  };
}

export async function automateOpenPlatformSetup(
  options: OpenPlatformAutomationOptions,
): Promise<OpenPlatformAutomationResult> {
  const brand = options.brand ?? 'feishu';
  if (brand !== 'feishu') {
    return {
      ok: false,
      reason: 'unsupported_brand',
      message: '开放平台自动配置当前只支持 feishu.cn 租户',
      redirectConfigured: false,
    };
  }

  const fetcher = options.fetchImpl ?? fetch;
  const preparedSession = await prepareFeishuWebSession({
    sessionFilePath: options.sessionFilePath,
    bytedcliFallbackSessionFilePath: options.bytedcliFallbackSessionFilePath,
    disableBytedcliFallback: options.disableBytedcliFallback,
    forceQrLogin: options.forceQrLogin,
    disableQrLogin: options.disableQrLogin,
    fetchImpl: fetcher,
    pollIntervalMs: options.pollIntervalMs,
    maxWaitMs: options.maxWaitMs,
    onQrCode: options.onQrCode,
    onQrScanConfirmed: options.onQrScanConfirmed,
    onStatus: options.onStatus,
  });
  if (!preparedSession.ok) {
    return {
      ok: false,
      reason: preparedSession.reason,
      message: `获取 Feishu Web session 失败: ${preparedSession.message}`,
      sessionFile: preparedSession.sessionFile,
      redirectConfigured: false,
    };
  }

  const sessionFile = preparedSession.sessionFile;
  const session = new MutableCookieJar(preparedSession.cookies);
  const defaultOrigin = 'https://open.feishu.cn';
  const defaultAppHome = `${defaultOrigin}/app/${options.appId}`;
  // The botmux-managed Feishu Web login yields reusable cookies, not Open
  // Platform's page-scoped `window.csrfToken`. Load an Open Platform page with
  // those cookies and extract CSRF from HTML before calling `/developers/v1/*`.
  // Feishu tenants can redirect the console to open.larkoffice.com; API origin,
  // referer, CSRF token and cookies must stay on that final origin.
  let csrfToken: string | null = null;
  let apiOrigin = defaultOrigin;
  let appHome = defaultAppHome;
  try {
    const authPage = await session.fetchTextWithUrl(fetcher, `${defaultAppHome}/auth`);
    apiOrigin = new URL(authPage.finalUrl).origin;
    appHome = `${apiOrigin}/app/${options.appId}`;
    csrfToken = extractOpenPlatformCsrfToken(authPage.text);
    if (!csrfToken) {
      const homePage = await session.fetchTextWithUrl(fetcher, appHome);
      apiOrigin = new URL(homePage.finalUrl).origin;
      appHome = `${apiOrigin}/app/${options.appId}`;
      csrfToken = extractOpenPlatformCsrfToken(homePage.text);
    }
  } catch (err: any) {
    return {
      ok: false,
      reason: 'network',
      message: `读取开放平台页面失败: ${safeErrorMessage(err)}`,
      sessionFile,
      redirectConfigured: false,
    };
  }
  if (!csrfToken) {
    return {
      ok: false,
      reason: 'missing_csrf',
      message:
        'Feishu session 可读取，但开放平台页面没有返回 window.csrfToken；可能需要在浏览器完成开放平台登录',
      sessionFile,
      redirectConfigured: false,
    };
  }

  const postJson = async (path: string, body?: unknown): Promise<unknown> => {
    const url = `${apiOrigin}${path}`;
    const response = await session.fetchRaw(fetcher, url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: apiOrigin,
        referer: appHome,
        'x-csrf-token': csrfToken!,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data: any;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new OpenPlatformApiError(`HTTP ${response.status} ${path}: ${summarizeOpenPlatformPayload(data)}`, data, response.status);
    }
    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      throw new OpenPlatformApiError(`code=${data.code} msg=${data.msg ?? data.message ?? ''}`, data, response.status);
    }
    return data;
  };

  // redirect 白名单：csrf 一就位就立刻写,**不再留到流程末尾**。
  // 后面的 scope 读取 / robot 与事件开关 / 核心事件回读 任意一步失败都会提前
  // return,把白名单一起拖死;而白名单缺失是 authorize 的**硬失败**(20029,用户
  // 连飞书授权页都进不去,群聊模式 p2pMode=group、会话群标签、`/login` 全部授权
  // 不了)。这一步独立 try/catch:失败只记 redirectWarning,不 return、不阻断后续。
  let redirectConfigured = false;
  let redirectWarning: string | undefined;
  // 「本次自动化到底改没改过线上配置」。只有确实落地过写操作（redirect 白名单、
  // scope、事件、回调、接收模式）才置 true。用来在流程末尾判断是否值得再
  // create+publish 一个新版本——权限/事件全都本就齐全时，历史实现仍会无条件
  // 发一版（scope 不 diff、发版无短路），存量 bot 每次重启命中自检都凭空多一个
  // 版本。⚠️ scope/update 用整份 catalog 映射、平台侧幂等 add，botmux 拿不到
  // 「哪些本就已授权」的可靠信号（scope/all 只是可选权限目录，无 grant flag），
  // 所以这里以「本次 scope/update 是否真的发出且成功」作为保守近似：宁可偶尔
  // 多发一版，也不少发导致新权限不生效。
  let mutated = false;
  try {
    // wanted 显式算一次并原样传下去：`redirectConfigured` 要靠「wanted 是否全部落盘」
    // 判定（见 {@link missingRedirectUrls}），拿不到这份 wanted 就只能退回按 status
    // 猜——那正是 `updated_fallback` 被假报成成功的原因。
    const wantedRedirectUrls = collectBotmuxRedirectUrls();
    const written = await writeRedirectWhitelist(postJson, options.appId, wantedRedirectUrls, {
      // 只有「本次刚建出来的 app」才允许在读失败时盲写覆盖；存量 app 读不到就零写入。
      allowBlindWrite: options.appJustCreated === true,
    });
    // 只有真的发了写请求（updated / updated_fallback）才算改过；unchanged（幂等
    // 短路）与 skipped_unreadable（一次都没写）都不置位。
    if (written.status === 'updated' || written.status === 'updated_fallback') {
      mutated = true;
    }
    if (written.status === 'skipped_unreadable') {
      // 「读不到线上现值 → 一次写请求都没发」。与下面的「写了但没写全」是两回事：
      // 这里连线上有什么都不知道，谈不上缺哪几条，措辞也要分开。
      redirectWarning = written.warning;
    } else {
      const missing = missingRedirectUrls(wantedRedirectUrls, written.redirectUrls);
      if (missing.length === 0) {
        redirectConfigured = true;
      } else {
        // 写请求返回 200 ≠ 想要的地址都在线上。缺的那条正是本机这次要用的回调地址时，
        // authorize 照样 20029，报「已配置」等于把问题藏到用户踩坑那一刻。
        redirectWarning = written.status === 'updated_fallback'
          ? `完整地址列表被开放平台拒绝，已退回「线上现值 + 本机回调」最小集写入；仍缺: ${missing.join('、')}`
          : `写入已提交，但以下回调地址仍未生效: ${missing.join('、')}`;
      }
    }
  } catch (err: any) {
    redirectWarning = `写入 redirect 白名单失败: ${safeErrorMessage(err)}`;
  }

  let allScopesPayload: unknown;
  try {
    allScopesPayload = await postJson(`/developers/v1/scope/all/${options.appId}`);
  } catch (err: any) {
    return {
      ok: false,
      reason: openPlatformOwnerAccessDenied(err) ? 'owner_session_mismatch' : 'api_error',
      message: `读取开放平台 scope 列表失败: ${safeErrorMessage(err)}`,
      sessionFile,
      redirectConfigured,
      redirectWarning,
    };
  }

  const manifest = options.scopeManifest ?? readDefaultScopeManifest();
  // 调用方给了「已授权」名字集合时，在**映射成 ID 之前**做 name 差集，把 manifest
  // 收窄成「本次真正还缺的」——只有它非空才需要发 scope/update、也才算一次变更。
  // 这正是「无变更短路」在走默认全量 manifest 的生产链路里能真正生效的关键：否则
  // manifest 恒非空 → scope/update 恒发 → mutated 恒真 → 短路永不触发。
  //
  // 差集必须**按 token 桶各自做**：约 121 个名字同时在 tenant/user 两桶，而两者是
  // 两份独立授权。若拿一个扁平集合过滤两桶，「tenant 已授权」会连带删掉 user 桶的
  // 同名 scope，把真正缺的 user 侧权限静默吞掉（PR #1044 R2）。
  const grantedTenant = options.grantedScopeNames
    ? new Set(options.grantedScopeNames.tenant)
    : undefined;
  const grantedUser = options.grantedScopeNames
    ? new Set(options.grantedScopeNames.user)
    : undefined;
  const hasGrantedSignal = !!(grantedTenant || grantedUser);
  const effectiveManifest: ScopeManifest = hasGrantedSignal
    ? {
        scopes: {
          tenant: (manifest.scopes?.tenant ?? []).filter(name => !grantedTenant?.has(name)),
          user: (manifest.scopes?.user ?? []).filter(name => !grantedUser?.has(name)),
        },
      }
    : manifest;
  const catalog = extractOpenPlatformScopeEntries(allScopesPayload);
  const mapped = mapManifestScopesToOpenPlatformIds(effectiveManifest, catalog);
  const missing = [...mapped.missingTenantScopes, ...mapped.missingUserScopes];
  const skippedScopeCount = missing.length;
  if (missing.length > 0) {
    console.warn(`Warning: ${missing.length} scopes are not present in the Open Platform catalog and will be skipped: ${missing.slice(0, 8).join(', ')}`);
  }

  // "部分权限即成功"：有的租户目录下个别权限不可授予，整批 scope/update 会被拒。
  // 把权限注册做成非致命——失败只告警并继续配 redirect / 建版本，不让权限问题阻塞建 bot。
  let importedScopeCount = mapped.tenantScopeIds.length + mapped.userScopeIds.length;
  let scopeWarning: string | undefined;
  if (importedScopeCount > 0) {
    try {
      await postJson(`/developers/v1/scope/update/${options.appId}`, buildScopeUpdatePayload(options.appId, mapped));
      // 已知 granted 时：manifest 已收窄成「真正还缺的」，走到这里就一定有新增权限，
      // 记为变更、允许后续发版让新权限生效。未知 granted 时保守近似：拿不到「哪些本就
      // 已授权」的信号，只要成功发出了一次非空 scope/update 就当作可能改动过权限。
      mutated = true;
    } catch (err: any) {
      scopeWarning = safeErrorMessage(err);
      importedScopeCount = 0;
    }
  }

  // 权限点加进清单后，其中一部分还带一份「权限可访问的数据范围」要填（console
  // 上是权限详情里的单选：全部 / 与应用的可用范围一致 / 按条件筛选）。这些权限
  // 的 scope level 是「需审核」，而字节租户的审批规则明写「非必要不申请全员数据，
  // 如申请全员范围请提供充分的理由说明，视情况加签至 CEO-2」——留空提审时这一格
  // 是空的（privilegeStatus=Unset），且 schema 的 fallback_value 是 mode:'all'，
  // 等于把范围往「全部」那侧靠。所以这里主动收敛成「与应用的可用范围一致」：
  // 语义上正是 botmux 需要的（bot 只对能看到它的人干活），也是审批规则鼓励的方向。
  //
  // 非致命，与 scope 注册同档：数据范围没配好不该阻塞建 bot（它只影响后续审批
  // 快慢，不影响 bot 收发消息）。写入按 (bizId,resource) 增量合并，且只碰
  // 「isRequired 且当前为空」的条目——人手配过的范围一律不覆盖。
  let privilegeRangeCount = 0;
  let privilegeRangeWarning: string | undefined;
  try {
    privilegeRangeCount = await narrowRequiredPrivilegeRanges({ postJson }, options.appId);
    // 返回值就是「实际写进去的条目数」：>0 说明真发了 privilege/update，属于一次
    // 落地的配置变更，必须计入 mutated——否则「只有数据范围被收敛」的那一轮会走
    // 无变更短路、不发版，改动留在草稿里不生效（#1042 与 #1044 合并处新增）。
    if (privilegeRangeCount > 0) mutated = true;
  } catch (err: any) {
    privilegeRangeWarning = safeErrorMessage(err);
  }

  // Web 创建的是普通企业自建应用（不是 SDK PersonalAgent），需要显式开启
  // 机器人能力并把事件接收方式切到长连接。对已启用的 SDK/已有应用重复调用
  // 是幂等的；这里设为致命步骤，因为缺任一项 daemon 都无法正常收消息。
  try {
    await postJson(`/developers/v1/robot/switch/${options.appId}`, { clientId: options.appId, enable: true });
    await postJson(`/developers/v1/event/switch/${options.appId}`, { clientId: options.appId, eventMode: 4 });
  } catch (err: any) {
    // 「应用正在审核中」是**等待即自愈**的状态，不是配置错误：审核期间开放平台把整个
    // 应用配置写锁了（scope/update / robot/switch / safe_setting/update / base_info 全
    // 拒，读接口照常），审批通过后自然恢复。给它一个独立 reason，让上层能说人话、
    // 并且不要每次重启都把整条链路重跑一遍（线上两台 bot 各已空转 8 次）。
    // 注意：这一步**不是本函数第一个写操作**（redirect 白名单、scope/update、
    // privilege/update 都在它前面，也都会被 10046 拒），而是第一个**不吞错**的写 ——
    // 前三个各自 try/catch 成 warning 继续走，只有这里会把错误抛到这个 catch。所以
    // 归因放在这里是可行的（它无条件执行），但别据此以为前面没有写操作：真要提前
    // 识别 10046，得去看那几个 warning 而不是指望这里最先命中。
    if (openPlatformUnderReview(err)) {
      // ⚠️ **不自动撤回待审版本**（曾经写过，已删）。原先的推理是「缺必需权限 + 审核中
      // = 权限永远补不上 ⟹ 撤回是唯一出路」，那默认了「审批是中性的排队机制」。实际
      // **触发审批说明有配置不合规**：模板建的应用出生带「数据范围=全部」，正是租户
      // 审批规则里「申请全员范围要额外说明理由、视情况加签至 CEO-2」那一档（见
      // {@link isPrivilegeRangeNarrowed} 的注释），而 narrowRequiredPrivilegeRanges
      // 只收窄**新**版本 ⟹ 卡住的必然是没收窄过的旧版。
      //
      // ⟹ 撤回重提交会被**同一条规则再拦一次**，等于用不可逆动作（丢掉审批队列位置，
      // 线上见过排 18 / 23 天且不属于本机 owner 的）驱动一个死循环。更一般地：**审批是
      // 规则驱动的闸，不是队列**，撤回不绕过规则、只丢位置 —— 所以即便存在「配置合规
      // 但仍进审批」的情形，自动撤回照样不解决问题。正确处置是**告诉人、让人修配置**。
      //
      // 取待审版本 id 只为给上层做「同一个待审版本别重复打扰」的节流 key。这次读是
      // 只读（审核锁下照常可读）、且只在失败路径发生，常态零开销。
      //
      // ⚠️ 读失败必须降级成「没有 versionId」，**绝不能把已经确定的 app_under_review
      // 覆盖成 network / api_error**：分类是主信号，versionId 只是节流用的上下文，
      // 上下文取不到不能反过来污染主信号。拿不到 id 时上层自然退化成「不节流」——
      // 那也正是我们要的：「撞了 10046 却找不到待审版本」意味着模型与实际不一致，
      // 每次都值得说一遍（万一是我们判据自己有 bug，节流会掐掉唯一的信号）。
      let inReviewVersionId: string | undefined;
      try {
        inReviewVersionId = findInReviewVersionId(
          await postJson(`/developers/v1/app_version/list/${options.appId}`, {}),
        );
      } catch { /* 拿不到就不节流，见上 */ }
      return {
        ok: false,
        reason: 'app_under_review',
        message:
          '应用正在飞书审核中，开放平台暂时锁定了它的配置写入（权限申请、机器人能力、回调白名单都改不了）。'
          + '**审批被触发通常意味着有配置不合规**（最常见：权限的「数据范围」没配，默认成「全部/全员」，'
          + '撞上租户「非必要不申请全员数据」的加签规则）。需要人工处理：到开放平台看审批详情 → 修掉不合规项 '
          + '→ 撤回该待审版本 → 重新提交。注意：撤回后直接重提**不会**自动通过，规则会再拦一次。',
        sessionFile,
        redirectConfigured,
        redirectWarning,
        inReviewVersionId,
      };
    }
    return {
      ok: false,
      reason: 'api_error',
      message: `启用机器人或长连接事件能力失败: ${safeErrorMessage(err)}`,
      sessionFile,
      redirectConfigured,
      redirectWarning,
    };
  }

  // 事件与回调都走 console 前端同款「增量」契约:先读现状 → operation:add 只补
  // 缺失 → 回读确认。旧实现的 eventNames/eventNameList 参数和
  // /event_callback/update 端点在开放平台并不存在,请求全部失败还被吞成
  // warning——新建应用因此落地就没有任何事件订阅。核心项(im.message.receive_v1
  // 事件 + card.action.trigger 回调)回读仍缺失时直接判失败:缺了它们 daemon
  // 收不到消息/卡片点击,静默降级只会产出一个「建好了却不回话」的坏 bot。
  const eventWarnings: string[] = [];
  const readEventState = async () =>
    extractOpenPlatformEventState(await postJson(`/developers/v1/event/${options.appId}`, { needEventDetail: true }));
  const addEvents = async (appEvents: string[], userEvents: string[], eventMode: number) => {
    await postJson(
      `/developers/v1/event/update/${options.appId}`,
      buildEventSubscriptionPayload(options.appId, eventMode, appEvents, userEvents),
    );
  };

  let eventState: OpenPlatformEventState | undefined;
  try {
    eventState = await readEventState();
  } catch (err: any) {
    eventWarnings.push(`读取当前事件订阅失败: ${safeErrorMessage(err)}`);
  }
  const hasEvent = (name: string) => Boolean(eventState?.events.includes(name));
  const wantedAppEvents = [...BOT_BASELINE_APP_EVENTS, ...BOT_OPTIONAL_APP_EVENTS, ...VC_MEETING_APP_EVENTS];
  const missingAppEvents = wantedAppEvents.filter(name => !hasEvent(name));
  const missingUserEvents = VC_MEETING_USER_EVENTS.filter(name => !hasEvent(name));
  if (missingAppEvents.length > 0 || missingUserEvents.length > 0) {
    // 有缺失事件才进这一支，说明确实要发写请求补订阅——置 mutated。逐个补的
    // 兜底分支即使个别失败，也已经改过一部分，仍算改动过。
    mutated = true;
    const eventMode = eventState?.eventMode ?? LONG_CONNECTION_EVENT_MODE;
    try {
      await addEvents(missingAppEvents, missingUserEvents, eventMode);
    } catch {
      // 部分租户个别事件依赖的权限不可授予会拒掉整批——逐个补,别让长尾事件拖垮核心事件
      for (const name of missingAppEvents) {
        try {
          await addEvents([name], [], eventMode);
        } catch (err: any) {
          const optional = (BOT_OPTIONAL_APP_EVENTS as readonly string[]).includes(name) ? '（可选事件, 不影响核心功能）' : '';
          eventWarnings.push(`订阅事件 ${name} 失败${optional}: ${safeErrorMessage(err)}`);
        }
      }
      for (const name of missingUserEvents) {
        try {
          await addEvents([], [name], eventMode);
        } catch (err: any) {
          eventWarnings.push(`订阅事件 ${name} 失败: ${safeErrorMessage(err)}`);
        }
      }
    }
    try {
      eventState = await readEventState();
    } catch (err: any) {
      eventWarnings.push(`回读事件订阅失败: ${safeErrorMessage(err)}`);
    }
  }
  const missingBaselineEvents = BOT_BASELINE_APP_EVENTS.filter(name => !hasEvent(name));
  if (missingBaselineEvents.length > 0) {
    eventWarnings.push(`基础事件未确认订阅: ${missingBaselineEvents.join(', ')}`);
  }
  // VC 事件缺失不阻断普通建 bot,但要显式带回给 VC listener 保存门
  // (vcListenerEventGateError)——只看总 count 无法区分「缺的是不是 VC」。
  const missingVcEvents: string[] = VC_MEETING_BOT_EVENTS.filter(name => !hasEvent(name));
  if (missingVcEvents.length > 0) {
    eventWarnings.push(`VC 会议事件未确认订阅: ${missingVcEvents.join(', ')}`);
  }

  // 卡片回调(card.action.trigger)在开放平台是「回调」不是「事件」,配置走
  // /developers/v1/callback/*;回调接收方式独立于事件,需要单独切到长连接。
  const readCallbackState = async () =>
    extractOpenPlatformCallbackState(await postJson(`/developers/v1/callback/${options.appId}`, {}));
  let callbackState: OpenPlatformCallbackState | undefined;
  try {
    callbackState = await readCallbackState();
  } catch (err: any) {
    eventWarnings.push(`读取当前回调订阅失败: ${safeErrorMessage(err)}`);
  }
  if (callbackState && callbackState.callbackMode !== LONG_CONNECTION_EVENT_MODE) {
    // 回调接收模式不是长连接才需要切——发了 switch 写请求即算改动过。
    mutated = true;
    try {
      await postJson(`/developers/v1/callback/switch/${options.appId}`, {
        clientId: options.appId,
        callbackMode: LONG_CONNECTION_EVENT_MODE,
      });
      callbackState = await readCallbackState();
    } catch (err: any) {
      eventWarnings.push(`切换回调长连接模式失败: ${safeErrorMessage(err)}`);
    }
  }
  let missingCallbacks = BOT_BASELINE_CALLBACKS.filter(name => !callbackState?.callbacks.includes(name));
  if (missingCallbacks.length > 0) {
    // 有缺失回调才补——发了 callback/update 写请求即算改动过。
    mutated = true;
    try {
      await postJson(
        `/developers/v1/callback/update/${options.appId}`,
        buildCallbackSubscriptionPayload(
          options.appId,
          callbackState?.callbackMode ?? LONG_CONNECTION_EVENT_MODE,
          [...missingCallbacks],
        ),
      );
    } catch (err: any) {
      eventWarnings.push(`订阅卡片回调失败: ${safeErrorMessage(err)}`);
    }
    try {
      callbackState = await readCallbackState();
    } catch (err: any) {
      eventWarnings.push(`回读回调订阅失败: ${safeErrorMessage(err)}`);
    }
    missingCallbacks = BOT_BASELINE_CALLBACKS.filter(name => !callbackState?.callbacks.includes(name));
  }

  const subscribedEventCount =
    [...wantedAppEvents, ...VC_MEETING_USER_EVENTS].filter(name => hasEvent(name)).length
    + BOT_BASELINE_CALLBACKS.filter(name => callbackState?.callbacks.includes(name)).length;
  const eventWarning = eventWarnings.length > 0 ? eventWarnings.join('; ') : undefined;
  const criticalIssues: string[] = [
    ...(options.requireVerifiedEvents ? missingBaselineEvents : BOT_CRITICAL_APP_EVENTS.filter(name => !hasEvent(name))),
    ...missingCallbacks,
  ];
  // 长连接模式必须以回读为准:switch 接口返回成功≠生效,mode 不是 4 时
  // daemon 走长连接同样收不到事件/回调。eventModeReady 显式带回结果——
  // dashboard listener 门要靠它识别「订阅名齐但接收方式不对」的黑洞。
  const eventModeReady = eventState?.eventMode === LONG_CONNECTION_EVENT_MODE;
  if (!eventModeReady) {
    criticalIssues.push(`事件接收模式=${eventState?.eventMode ?? '未知'}(需长连接 ${LONG_CONNECTION_EVENT_MODE})`);
  }
  if (callbackState?.callbackMode !== LONG_CONNECTION_EVENT_MODE) {
    criticalIssues.push(`回调接收模式=${callbackState?.callbackMode ?? '未知'}(需长连接 ${LONG_CONNECTION_EVENT_MODE})`);
  }
  if (criticalIssues.length > 0) {
    return {
      ok: false,
      reason: options.requireVerifiedEvents ? 'event_verification_failed' : 'api_error',
      message: `核心事件/回调订阅未生效(${criticalIssues.join('; ')}),机器人将收不到消息或卡片点击;请到开放平台「事件与回调」手动补齐后重试`,
      sessionFile,
      subscribedEventCount,
      eventWarning,
      missingVcEvents,
      eventModeReady,
      redirectConfigured,
      redirectWarning,
    };
  }

  // 无变更短路：redirect / scope / 事件 / 回调 / 接收模式一路下来都没落地过任何
  // 写操作，说明应用配置本就齐全，再 create+publish 一个新版本纯属凭空多一版
  // （存量 bot 每次重启命中权限自检/VC 自检都发一版）。此时跳过发版，直接回成功。
  //
  // 两个例外**必须**照常发版：
  //  • appJustCreated —— 刚建出来的 app 要靠首次发版才能上架启用；
  //  • requireVerifiedEvents —— 受管 onboarding/恢复靠回读到的精确 versionId 作为
  //    激活 ACK（见 bot-onboarding 的 hasExactManagedAutomationAck / versionId 读取），
  //    不发版就拿不到 versionId，激活会判失败。
  // 这两条都传 false / 未传时，才走无变更短路。
  //
  // ⚠️ 第三个例外：**存在未提交的草稿**。草稿会让后续 `app_version/create` 一律撞
  // `code=10043 版本已创建`（见下方 findUncommittedDraftVersionId 处的长注释），而
  // 「有草稿」与「本轮有没有配置变更」是两件独立的事：一个 scope 已齐、事件已订阅、
  // 数据范围已收窄的 bot，`mutated` 恒为 false，会在这里短路 return —— 下面那段
  // 「提交草稿」的代码**永远到不了**，草稿就一直卡着。这正是本次要修的死锁，所以
  // 有草稿时必须往下走，把它提交掉（提交草稿本身不新建版本、不烧版本号）。
  // 读一次版本列表：既用来判「有没有卡住的草稿」（决定能否走无变更短路），也直接
  // 复用给下面的发版逻辑，避免同一轮里重复请求。读失败不阻断——退回「按 mutated 判」
  // 的旧行为，最坏是少救一次草稿，不会因为一个读请求把整条自愈判死。
  let versionList: unknown;
  try {
    versionList = await postJson(`/developers/v1/app_version/list/${options.appId}`, {});
  } catch (err: any) {
    await options.onStatus?.(`读取版本列表失败（${safeErrorMessage(err)}），跳过草稿检查`);
  }
  const pendingDraftVersionId = versionList === undefined ? undefined : findUncommittedDraftVersionId(versionList);
  const mustPublish = options.appJustCreated === true || options.requireVerifiedEvents === true;
  if (!mutated && !mustPublish && !pendingDraftVersionId) {
    return {
      ok: true,
      sessionFile,
      sessionSource: preparedSession.source,
      cookieCount: preparedSession.cookieCount,
      scopeCount: importedScopeCount,
      skippedScopeCount,
      scopeWarning,
      privilegeRangeCount,
      privilegeRangeWarning,
      subscribedEventCount,
      eventWarning,
      missingVcEvents,
      eventModeReady,
      redirectConfigured,
      redirectWarning,
      // 没发版：versionId 留空，另置 publishSkipped 标记「本次确实没建版」。非受管
      // 路径本就不依赖 versionId（受管路径已被 mustPublish 排除在短路之外），下游据
      // publishSkipped 区分「跳过发版」与「发了版但没解析到 versionId」——前者不该被
      // classifySetupOpenPlatformOutcome 计入 warning，也不该让 CLI 提示去后台找草稿。
      versionId: undefined,
      publishSkipped: true,
    };
  }

  try {
    // 原样镜像**线上版本**的可见范围（白/黑名单都带）——绝不注入「当前 Web
    // session 操作者」:automateOpenPlatformSetup 也被 VC listener 保存 / 权限自愈 /
    // 选择已有应用等路径调用,那里操作者不一定是创建者/现有可见成员,注入会悄悄
    // 扩大已有 bot 的可见范围。新建应用的「上架启用」由 createOpenPlatformAppWithClient
    // 的首次发布(含创建者可见)完成,与本处无关。
    //
    // ⚠️ 数据来源必须是 visible/online（应用可见范围），不是 contact_range
    // （通讯录权限范围，是另一个概念）。历史上这里读的是 contact_range 且只取
    // members、把 departments/groups/isAll 写死空值,于是每次自动发版都把「全员
    // 可见 / 按部门授权 / 按用户组授权」静默清成「仅少数个人可见」——权限自愈
    // 一重启就发版,受影响的人第二天集体访问不了应用。
    //
    // 解析失败 fail closed：此时还没建版,可见范围零改动,调用方降级为给管理员
    // 发 DM 手动处理,绝不发布一个可能把人关在门外的版本。
    let visibility: { visibleSuggest: VisibilitySuggest; blackVisibleSuggest: VisibilitySuggest };
    try {
      visibility = parseOnlineVisibility(await postJson(`/developers/v1/visible/online/${options.appId}`, {}));
    } catch (err: any) {
      if (!(err instanceof VisibilityParseError)) throw err;
      return {
        ok: false,
        reason: 'visibility_unreadable',
        message: `无法可靠读取应用现有可见范围（${err.message}），已中止发版以免重置可见范围；请到开放平台手动发布新版本`,
        sessionFile,
        subscribedEventCount,
        eventWarning,
        missingVcEvents,
        eventModeReady,
        redirectConfigured,
        redirectWarning,
      };
    }
    const versions = versionList ?? await postJson(`/developers/v1/app_version/list/${options.appId}`, {});
    // 已存在的**未提交草稿**要先消化掉，不能直接 create：飞书不允许并存两个未提交
    // 版本，有草稿时 create 一律回 `code=10043 版本已创建，请刷新`。历史行为是撞上就
    // 整个自愈失败并给管理员发 DM，而下次重启又原样重跑——一个草稿把自愈**永久**卡死
    // （线上实测 3 台、一天各 5 次）。
    //
    // 修法是**提交那个草稿**而不是绕过它：草稿的 scope 集合就是应用当前已声明的集合
    // （实测逐项相等，181/181 零差集），正是我们想发的内容；`scope/update` 早在本函数
    // 上半段就已经把缺失权限加进清单了，草稿会带上它们。实测直接 commit 即
    // `versionStatus` 0→2（已上线），不新建版本、不烧版本号。
    //
    // 故意**不**做「取消草稿再重建」：那需要引入一个破坏性的删除端点（本仓库从未用过
    // 任何 delete/cancel 版本的端点），还会多烧一个版本号，收益为零。
    //
    // ⚠️ 已知取舍：复用草稿等于发布**草稿自己那份可见范围快照**，而不是上面刚从
    // `visible/online` 读出来的现值（`visibleSuggest` 只在新建版本时才用得上）。本次
    // 涉及的两台 bot 实测草稿与线上版本的可见范围逐字相同（同一个 open_id、无部门/
    // 黑名单），所以没有收窄发生；但一个**很久以前**留下的草稿理论上可能带着过时的
    // 可见范围。这仍然比现状好：现状是自愈**永久失败**、权限一项都到不了位。真出现
    // 过时草稿时，用户在开放平台能看到该版本的可见范围并自行修正。
    const draftVersionId = findUncommittedDraftVersionId(versions);
    let versionId: string | undefined;
    let versionReused = false;
    if (draftVersionId) {
      versionId = draftVersionId;
      versionReused = true;
    } else {
      const appVersion = nextAppVersion(versions);
      const versionPayload = buildAppVersionCreatePayload(appVersion) as unknown as Record<string, unknown>;
      versionPayload.visibleSuggest = visibility.visibleSuggest;
      versionPayload.blackVisibleSuggest = visibility.blackVisibleSuggest;
      const created = await postJson(`/developers/v1/app_version/create/${options.appId}`, versionPayload);
      versionId = extractVersionId(created);
    }
    if (options.requireVerifiedEvents && !versionId) {
      return {
        ok: false,
        reason: 'version_verification_failed',
        message: '开放平台未返回可发布的精确版本 ID，受管机器人保持未激活',
        sessionFile,
        subscribedEventCount,
        eventWarning,
        missingVcEvents,
        eventModeReady,
        redirectConfigured,
        redirectWarning,
      };
    }
    let versionWarning: string | undefined;
    let approvalAutoPassed: boolean | undefined;
    let approvalHumanApprovers: string[] | undefined;
    if (versionId) {
      // 提交前先问一句「这一版提交后会不会秒过」。判据见 {@link predictApprovalFlow}：
      // 全自动通过 + 零真人审批人 ⟹ 提交不打扰任何人、立即生效，尽管提。
      //
      // 反过来，有真人审批人时**仍然照常提交**——这是既有行为，不改：botmux 建 bot /
      // 补权限本来就需要发版才生效，替用户提审是本来的分工。这里查流程的作用是**把
      // 「秒过」与「要人审」分开告知**：秒过的一声不吭办完；要人审的明确说「已提交，
      // 需要 X 审批」，让用户知道在等谁、以及别再重复点。
      //
      // 判不出来（known:false，接口报错 / 没有可判定的关卡）时不猜：既不宣称秒过，
      // 也不宣称要人审，只在日志里留原因。
      const prediction = await fetchApprovalFlowPrediction(postJson, options.appId, versionId, visibility);
      if (prediction.known) {
        approvalAutoPassed = prediction.autoApproved;
        if (prediction.humanApprovers.length > 0) approvalHumanApprovers = prediction.humanApprovers;
      } else if (prediction.reason) {
        await options.onStatus?.(`审批流程预判不可用（${prediction.reason}），按常规提交`);
      }
      await postJson(`/developers/v1/publish/commit/${options.appId}/${versionId}`, { clientId: options.appId });
      // commit 返回 code=0 ≠ 版本真的提交了：线上实测过 commit 回 `{code:0,isOk:true}`
      // 而版本仍停在草稿态，于是日志谎报「published」，留下的草稿正是卡死后续自愈的
      // 元凶。回读一次把「以为发了」和「真发了」分开——查得到就是查得到，别再拿返回码
      // 当结论。回读本身失败不改判结果（版本可能已经提交成功），只记 warning。
      try {
        const after = await postJson(`/developers/v1/app_version/list/${options.appId}`, {});
        if (!isVersionCommitted(after, versionId)) {
          versionWarning =
            `版本 ${versionId} 提交后回读仍是「未提交审核」草稿：请到开放平台「版本管理」手动点「申请发布」`;
        }
      } catch (err: any) {
        versionWarning = `版本 ${versionId} 提交状态回读失败（无法确认是否已提交）: ${safeErrorMessage(err)}`;
      }
    }
    return {
      ok: true,
      sessionFile,
      sessionSource: preparedSession.source,
      cookieCount: preparedSession.cookieCount,
      scopeCount: importedScopeCount,
      skippedScopeCount,
      scopeWarning,
      privilegeRangeCount,
      privilegeRangeWarning,
      subscribedEventCount,
      eventWarning,
      missingVcEvents,
      eventModeReady,
      redirectConfigured,
      redirectWarning,
      versionReused,
      versionWarning,
      approvalAutoPassed,
      approvalHumanApprovers,
      ...(options.requireVerifiedEvents
        ? {
            eventMode: eventState?.eventMode,
            verifiedEventCount: BOT_BASELINE_APP_EVENTS.length + BOT_BASELINE_CALLBACKS.length,
          }
        : {}),
      versionId,
    };
  } catch (err: any) {
    return {
      ok: false,
      reason: 'api_error',
      message: `开放平台自动配置失败: ${safeErrorMessage(err)}`,
      sessionFile,
      subscribedEventCount,
      eventWarning,
      missingVcEvents,
      eventModeReady,
      redirectConfigured,
      redirectWarning,
    };
  }
}

/**
 * dashboard 保存 VC 会议监听 bot 前的事件订阅门。普通建 bot 允许 VC 事件缺失
 * (只记 warning),但 listener 缺 VC 事件=会议邀请黑洞,必须阻断保存。
 * 只看 subscribedEventCount 总数无法区分「缺的是不是 VC」,所以要看
 * missingVcEvents。返回错误描述;可保存时返回 null。
 */
export function vcListenerEventGateError(result: {
  eventWarning?: string;
  subscribedEventCount?: number;
  missingVcEvents?: string[];
  eventModeReady?: boolean;
}): string | null {
  if (result.eventWarning && (result.subscribedEventCount ?? 0) === 0) {
    return `事件订阅全部失败(${result.eventWarning})`;
  }
  // 订阅名齐但接收方式不是长连接同样收不到——eventModeReady 显式 false 才阻断,
  // undefined(走到订阅阶段前就失败)保持原 best-effort 语义。
  if (result.eventModeReady === false) {
    return `事件接收方式未确认为长连接${result.eventWarning ? `(${result.eventWarning})` : ''}`;
  }
  const missingVc = result.missingVcEvents ?? [];
  if (missingVc.length > 0) {
    return `VC 会议事件未订阅成功(${missingVc.join(', ')})${result.eventWarning ? `;${result.eventWarning}` : ''}`;
  }
  return null;
}

// ─── 已有应用列表 / 凭证读取（setup「选择已有应用」路径）───────────────────────
//
// 复用同一套 Web session + console CSRF 机制，调 console 前端同款接口
// （bundle 里的 getAppList / getAppSecret）。与 automateOpenPlatformSetup 的
// 内联 postJson 少量重复——那条链路已实测稳定且 CSRF 种子页 / referer 都绑定
// 具体 appId，不强行合并，避免动到已验证的自动配置路径。

export interface OpenPlatformAppSummary {
  clientId: string;
  name: string;
  /** 应用描述（接口给什么用什么，仅展示）。 */
  description?: string;
}

export interface OpenPlatformApiClient {
  apiOrigin: string;
  postJson(path: string, body?: unknown): Promise<unknown>;
  /**
   * 语义幂等的 console POST（重复调用无副作用：设值型 switch、只读拉取）。
   * 与 GET/HEAD 同权享受完整的瞬态错误退避重试，且**预算只在 fetchRaw 这一层**
   * —— 调用方不要再在外面套第二轮 retry，那会与内层相乘（实测 3×3=9 次）。
   */
  postJsonIdempotent(path: string, body?: unknown): Promise<unknown>;
  postForm(path: string, body: FormData): Promise<unknown>;
}

export type OpenPlatformClientResult =
  | { ok: true; client: OpenPlatformApiClient; identity?: FeishuWebSessionIdentity }
  | { ok: false; reason: 'missing_csrf' | 'network'; message: string };

/**
 * 用已就绪的 Web session cookies 构造开放平台 console API 客户端：加载 console
 * 页面提取 `window.csrfToken` 与最终 origin（部分租户会把控制台重定向到
 * open.larkoffice.com），返回可调 `/developers/v1/*` 的 postJson。
 */
export async function createOpenPlatformApiClient(
  cookies: StoredCookie[],
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<OpenPlatformClientResult> {
  const fetcher = opts.fetchImpl ?? fetch;
  const session = new MutableCookieJar(cookies);
  let csrfToken: string | null = null;
  let apiOrigin = 'https://open.feishu.cn';
  let referer = `${apiOrigin}/app`;
  let identity: FeishuWebSessionIdentity | undefined;
  try {
    const page = await session.fetchTextWithUrl(fetcher, `${apiOrigin}/app`);
    apiOrigin = new URL(page.finalUrl).origin;
    referer = page.finalUrl;
    csrfToken = extractOpenPlatformCsrfToken(page.text);
    identity = extractOpenPlatformSessionIdentity(page.text) ?? undefined;
  } catch (err) {
    return { ok: false, reason: 'network', message: `读取开放平台页面失败: ${safeErrorMessage(err)}` };
  }
  if (!csrfToken) {
    return {
      ok: false,
      reason: 'missing_csrf',
      message: '开放平台页面没有返回 window.csrfToken；Web session 可能已过期或未完成开放平台登录',
    };
  }

  const request = async (
    path: string, body?: BodyInit, contentType?: string, opts: { idempotent?: boolean } = {},
  ): Promise<unknown> => {
    const url = `${apiOrigin}${path}`;
    const response = await session.fetchRaw(fetcher, url, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        origin: apiOrigin,
        referer,
        'x-csrf-token': csrfToken!,
        ...(contentType ? { 'content-type': contentType } : {}),
      },
      body,
    }, 10, opts);
    let data: any;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) {
      throw new OpenPlatformApiError(`HTTP ${response.status} ${path}: ${summarizeOpenPlatformPayload(data)}`, data, response.status);
    }
    if (data && typeof data === 'object' && typeof data.code === 'number' && data.code !== 0) {
      throw new OpenPlatformApiError(`code=${data.code} msg=${data.msg ?? data.message ?? ''}`, data, response.status);
    }
    return data;
  };

  const postJson = async (path: string, body?: unknown): Promise<unknown> =>
    request(path, body === undefined ? undefined : JSON.stringify(body), body === undefined ? undefined : 'application/json');
  const postJsonIdempotent = async (path: string, body?: unknown): Promise<unknown> =>
    request(
      path,
      body === undefined ? undefined : JSON.stringify(body),
      body === undefined ? undefined : 'application/json',
      { idempotent: true },
    );
  const postForm = async (path: string, body: FormData): Promise<unknown> => request(path, body);

  return { ok: true, client: { apiOrigin, postJson, postJsonIdempotent, postForm }, identity };
}

/**
 * 只检查现有缓存，不展示二维码。Dashboard 打开添加表单时调用；返回的账号/企业
 * 会显示给用户，并在真正创建前再次比对，避免旧 cookie 把应用建到错误租户。
 */
export async function inspectCachedFeishuOpenPlatformSession(
  options: Pick<FeishuWebSessionOptions, 'sessionFilePath' | 'fetchImpl'> = {},
): Promise<FeishuOpenPlatformSessionInspectionResult> {
  const prepared = await prepareFeishuWebSession({
    ...options,
    disableQrLogin: true,
    disableBytedcliFallback: true,
  });
  if (!prepared.ok) return prepared;
  const clientResult = await createOpenPlatformApiClient(prepared.cookies, { fetchImpl: options.fetchImpl });
  if (!clientResult.ok) {
    return {
      ok: false,
      reason: clientResult.reason,
      message: clientResult.message,
      sessionFile: prepared.sessionFile,
    };
  }
  if (!clientResult.identity) {
    return {
      ok: false,
      reason: 'identity_unavailable',
      message: '开放平台没有返回当前账号与企业信息；为避免创建到错误租户，未复用该登录态',
      sessionFile: prepared.sessionFile,
    };
  }
  return {
    ok: true,
    source: prepared.source,
    identity: clientResult.identity,
    sessionFile: prepared.sessionFile,
  };
}

export type CreateFeishuOpenPlatformAppResult =
  | {
      ok: true;
      appId: string;
      appSecret: string;
      brand: 'feishu';
      sessionFile: string;
      sessionSource: FeishuWebSessionSource;
      sessionIdentity: FeishuWebSessionIdentity;
    }
  | {
      ok: false;
      reason:
        | FeishuWebSessionFailureReason
        | 'missing_csrf'
        | 'missing_icon'
        | 'identity_unavailable'
        | 'session_changed'
        | 'api_error';
      message: string;
      /** 应用已经建成但读取 Secret 失败时返回，调用方不得再创建一个重复应用。 */
      appId?: string;
      sessionFile?: string;
    };

export interface CreateFeishuOpenPlatformAppOptions extends FeishuWebSessionOptions {
  name: string;
  description?: string;
  /** 测试/定制图标；默认复用 botmux dashboard 的 512x512 favicon。 */
  iconFilePath?: string;
  /** Dashboard 表单打开时显示过的缓存身份；创建前必须仍是同一人、同一企业。 */
  expectedIdentity?: Pick<FeishuWebSessionIdentity, 'userId' | 'tenantId'>;
  /** 已拿到并验证账号/企业、但尚未创建应用时触发。 */
  onSessionReady?: (info: {
    source: FeishuWebSessionSource;
    identity: FeishuWebSessionIdentity;
  }) => void | Promise<void>;
}

class CreatedOpenPlatformAppError extends Error {
  constructor(readonly appId: string, cause: unknown) {
    super(`应用 ${appId} 已创建，但启用机器人能力或读取 AppSecret 失败: ${safeErrorMessage(cause)}`);
  }
}

function defaultBotmuxAppIconPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // npm build: dist/setup/open-platform-automation.js -> dist/dashboard-web/favicon.png
    join(here, '..', 'dashboard-web', 'favicon.png'),
    // tsx / vitest: src/setup/open-platform-automation.ts -> src/dashboard/web/favicon.png
    join(here, '..', 'dashboard', 'web', 'favicon.png'),
  ];
  return candidates.find(existsSync);
}

function pickPayloadString(payload: unknown, keys: string[]): string | undefined {
  const record = asRecord(payload);
  return pickString(record, keys) ?? pickString(asRecord(record.data), keys);
}

/** 「一键创建智能体」(backend_oneclick launcher) 使用的应用清单模板 ID。 */
export const ONECLICK_APP_MANIFEST_TEMPLATE_ID = 'developer_console';

/**
 * Build the payload for `POST /developers/v1/manifest/upsert_by_template` —
 * the console launcher's one-click agent creation endpoint (CDP 抓包确认)。
 * 该模板建出的应用开箱自带 bot 能力、长连接事件/回调模式、基础事件订阅与
 * card.action.trigger 回调,正是「正常申请默认带的权限」。
 */
export function buildManifestTemplateCreatePayload(
  name: string,
  description: string,
  avatar: string,
  cid: string,
) {
  return {
    appManifestTemplateID: ONECLICK_APP_MANIFEST_TEMPLATE_ID,
    createAppUserCustomField: {
      i18n: { zh_cn: { name, description } },
      avatar,
      primaryLang: 'zh_cn',
    },
    cid,
    HTTPHead: {},
  };
}

/**
 * 模板创建是否属于服务端「明确拒绝」——即可确定应用没有建出来,允许安全
 * 回退 app/create。业务错误码(code!==0,服务端解析请求后拒绝)与 HTTP 404
 * (端点不存在)算明确拒绝;传输错误(ECONNRESET/timeout,非
 * OpenPlatformApiError)、HTTP 5xx、code=0 缺 ClientID 都属「结果未知」——
 * 服务端可能已 commit,跨端点重建会产生孤儿 + 重复应用,必须 fail-closed。
 */
function isDefiniteTemplateRejection(err: unknown): boolean {
  if (!(err instanceof OpenPlatformApiError)) return false;
  const code = (asRecord(err.payload) as { code?: unknown }).code;
  if (typeof code === 'number' && code !== 0) return true;
  return /^HTTP 404\b/.test(err.message);
}

/**
 * 用已经登录的开放平台 Web session 创建一个企业自建应用并读取凭证。
 *
 * 首选 console launcher 的「一键创建智能体」模板接口
 * (manifest/upsert_by_template):模板应用出生即带 bot 能力、长连接、基础
 * 事件与卡片回调,新建 bot 不再依赖后续订阅补齐。模板 ID 属内部契约,被
 * 服务端明确拒绝时自动回退旧 app/create(裸自建应用,事件/回调由
 * automateOpenPlatformSetup 增量补齐并 fail-closed 兜底);创建结果未知时
 * 不回退(见 isDefiniteTemplateRejection)。Secret 只存在返回值中,不打印、
 * 不写日志。
 */
export async function createOpenPlatformAppWithClient(
  client: OpenPlatformApiClient,
  // creatorUserId 必填:首次「启用发布」的版本可见范围必须含创建者,否则发布后
  // 应用不会自动上架启用。调用方(createFeishuOpenPlatformApp)已保证 session
  // identity 可用才会走到这里。
  options: { name: string; description?: string; iconFilePath?: string; creatorUserId: string },
): Promise<{ appId: string; appSecret: string }> {
  const name = options.name.trim();
  if (!name) throw new Error('应用名称不能为空');
  if (!options.creatorUserId) throw new Error('创建应用缺少创建者 userId,无法完成上架启用');
  const iconFile = options.iconFilePath ?? defaultBotmuxAppIconPath();
  if (!iconFile || !existsSync(iconFile)) throw new Error('找不到 botmux 默认应用图标');

  const icon = readFileSync(iconFile);
  const form = new FormData();
  form.append('file', new Blob([icon], { type: 'image/png' }), 'botmux.png');
  form.append('uploadType', '4'); // Open Platform console enum: Icon
  form.append('isIsv', 'false'); // 企业自建应用
  form.append('scale', JSON.stringify({ width: 512, height: 512 }));
  const uploaded = await client.postForm('/developers/v1/app/upload/image', form);
  const avatar = pickPayloadString(uploaded, ['url']);
  if (!avatar) throw new Error('开放平台上传图标后没有返回 url');

  const description = options.description?.trim() || 'AI coding assistant powered by botmux';
  let appId: string | undefined;
  try {
    const created = await client.postJson(
      '/developers/v1/manifest/upsert_by_template',
      buildManifestTemplateCreatePayload(name, description, avatar, randomUUID()),
    );
    const templateAppId = pickPayloadString(created, ['ClientID', 'clientID', 'clientId', 'appId']);
    if (!templateAppId?.startsWith('cli_')) {
      // code=0 却没有 ClientID:应用可能已建成(响应结构变化),结果未知——
      // 不能落入 fallback 再 create,让下面的 catch 按「非明确拒绝」抛出。
      throw new Error('一键智能体模板创建返回成功但没有 ClientID(结果未知);请到开放平台确认是否已创建同名应用后重试');
    }
    appId = templateAppId;
  } catch (err) {
    if (!isDefiniteTemplateRejection(err)) throw err;
    console.warn(`一键智能体模板创建被拒,回退普通自建应用: ${safeErrorMessage(err)}`);
    appId = undefined;
  }
  if (!appId) {
    const created = await client.postJson('/developers/v1/app/create', {
      appSceneType: 0, // SelfBuild
      name,
      desc: description,
      avatar,
      i18n: { zh_cn: { name, description } },
      primaryLang: 'zh_cn',
    });
    appId = pickPayloadString(created, ['ClientID', 'clientID', 'clientId', 'appId']);
  }
  if (!appId?.startsWith('cli_')) throw new Error('开放平台创建应用后没有返回 ClientID');

  try {
    // 模板应用出生已带 bot + 长连接(重复调用幂等);fallback 的裸自建应用
    // 则必须显式开启——这两步是「一扫即用」的必要条件,在返回凭证前完成。
    // robot/event switch 都是幂等设值,故对宿主机↔飞书的瞬态网络抖动小步重试:
    // 一次 undici `fetch failed` 不该让「应用已建成但没启用能力」半途而废
    // (那会把用户丢进手动读 Secret + CLI 续跑的恢复路径)。
    await client.postJsonIdempotent(`/developers/v1/robot/switch/${appId}`, { clientId: appId, enable: true });
    await client.postJsonIdempotent(`/developers/v1/event/switch/${appId}`, { clientId: appId, eventMode: 4 }); // WebSocket

    // 模板建出来的应用，「权限可访问的数据范围」出生就是 `mode:'all'`（console 上
    // 显示「全部」）——而这里紧接着就要发**第一个版本**。不先收窄，这一版就带着
    // 「全部」进审批：正是租户规则里要补充理由、视情况加签至 CEO-2 的那一档。
    // 后续 automateOpenPlatformSetup 也会做同一件事，但它发的是**下一个**版本，
    // 救不回这一版，所以两处都必须做。
    //
    // 非致命：数据范围只影响审批快慢，不影响应用能不能收发消息。这里正处在
    // 「应用已建成、还没发版」的窗口里，为它把整条创建链路判死（用户被丢进手动读
    // Secret 的恢复路径）代价明显更大。
    await narrowRequiredPrivilegeRanges(client, appId).catch((err: unknown) => {
      console.warn(`权限数据范围自动收窄失败（不影响建 bot，可到开放平台手动选「与应用的可用范围一致」）: ${safeErrorMessage(err)}`);
    });

    // 复刻 console launcher「一键创建智能体」的最后一步:立刻用极简版本发布一次,
    // 让应用**上架启用**(tenantAppStatus 0→2)。这样返回的就是一个「已启用、可
    // 收发消息」的应用——等价于旧 SDK registerApp 直接产出可用 PersonalAgent 的效果。
    // 这一步 fail-closed:拿到 versionId 后 commit 失败、或 code=0 却没 versionId
    // (可能留下未发布草稿),都视为创建失败抛出(带 appId,由调用方兜底/提示)。
    //
    // 这里**不做**「回读版本状态 + 补一刀 commit」:线上那 3 台卡死 bot 的 1.0.0
    // (本函数发的版本)全部 `status=1 已上线`,即本步的 commit 是成功的;卡死源是随后
    // automateOpenPlatformSetup 发的 1.0.1 草稿(见那边的 findUncommittedDraftVersionId)。
    // 给没有证据坏的路径加重试,只会给建应用链路凭空引入一个 fail-closed 抛点。
    // ⚠️ version/create、publish/commit 是非幂等写操作(传输失败即结果未知,
    // 重放会重复建版/撞版本号),故绝不套 retryIdempotent… 包装,与 fetchRaw
    // 只对 GET/HEAD 重试同源。
    const versionCreated = await client.postJson(
      `/developers/v1/app_version/create/${appId}`,
      buildAppVersionCreatePayload('1.0.0', [options.creatorUserId]),
    );
    const enableVersionId = extractVersionId(versionCreated);
    if (!enableVersionId) {
      throw new Error('上架启用版本创建返回成功但没有 versionId(可能已留下未发布草稿);请到开放平台确认后重试');
    }
    await client.postJson(`/developers/v1/publish/commit/${appId}/${enableVersionId}`, { clientId: appId });

    // 读 Secret 是纯只读 POST(getAppSecret 同款,不触碰 reset),幂等可重试:
    // 应用已建成、已发布,唯独最后一步读 Secret 撞网络抖动而失败最可惜——
    // 重试让它自愈,而不是把整条链路判死。
    const appSecret = await fetchOpenPlatformAppSecret(client, appId!, { idempotentRetry: true });
    return { appId, appSecret };
  } catch (err) {
    throw new CreatedOpenPlatformAppError(appId, err);
  }
}

/**
 * Read-only probe: are this app's VC meeting events (vc.bot.meeting_* +
 * participant_meeting_joined) subscribed, and is event mode the long connection?
 * Uses ONLY the cached Feishu Web session (disableQrLogin) and never publishes a
 * version — so it is safe to call at daemon startup. The caller decides whether
 * to run the full (publishing) automateOpenPlatformSetup based on the result:
 * only when events are actually missing / mode is wrong.
 */
export type VcMeetingEventProbeResult =
  | { ok: true; missingVcEvents: string[]; eventModeReady: boolean; sessionFile?: string }
  | { ok: false; reason: string; message: string; sessionFile?: string };

export async function probeVcMeetingEventSubscription(
  appId: string,
  options: Pick<FeishuWebSessionOptions, 'sessionFilePath' | 'fetchImpl'> = {},
): Promise<VcMeetingEventProbeResult> {
  const prepared = await prepareFeishuWebSession({
    ...options,
    disableQrLogin: true,
    disableBytedcliFallback: true,
  });
  if (!prepared.ok) {
    return { ok: false, reason: prepared.reason, message: prepared.message, sessionFile: prepared.sessionFile };
  }
  const clientResult = await createOpenPlatformApiClient(prepared.cookies, { fetchImpl: options.fetchImpl });
  if (!clientResult.ok) {
    return { ok: false, reason: clientResult.reason, message: clientResult.message, sessionFile: prepared.sessionFile };
  }
  try {
    const eventState = extractOpenPlatformEventState(
      await clientResult.client.postJson(`/developers/v1/event/${appId}`, { needEventDetail: true }),
    );
    const has = (name: string) => eventState.events.includes(name);
    return {
      ok: true,
      missingVcEvents: VC_MEETING_BOT_EVENTS.filter(name => !has(name)),
      eventModeReady: eventState.eventMode === LONG_CONNECTION_EVENT_MODE,
      sessionFile: prepared.sessionFile,
    };
  } catch (err: any) {
    return { ok: false, reason: 'api_error', message: `读取事件订阅失败: ${safeErrorMessage(err)}`, sessionFile: prepared.sessionFile };
  }
}

/**
 * 单次飞书 Web 扫码完成应用创建。session 会写入 ~/.botmux，后续
 * automateOpenPlatformSetup 会直接复用，因此权限/redirect/发版不再二次扫码。
 */
export async function createFeishuOpenPlatformApp(
  options: CreateFeishuOpenPlatformAppOptions,
): Promise<CreateFeishuOpenPlatformAppResult> {
  const prepared = await prepareFeishuWebSession(options);
  if (!prepared.ok) {
    return {
      ok: false,
      reason: prepared.reason,
      message: `获取 Feishu Web session 失败: ${prepared.message}`,
      sessionFile: prepared.sessionFile,
    };
  }

  const clientResult = await createOpenPlatformApiClient(prepared.cookies, { fetchImpl: options.fetchImpl });
  if (!clientResult.ok) {
    return {
      ok: false,
      reason: clientResult.reason,
      message: clientResult.message,
      sessionFile: prepared.sessionFile,
    };
  }
  if (!clientResult.identity) {
    return {
      ok: false,
      reason: 'identity_unavailable',
      message: '开放平台没有返回当前账号与企业信息；为避免创建到错误租户，未创建应用',
      sessionFile: prepared.sessionFile,
    };
  }
  if (options.expectedIdentity
    && (clientResult.identity.userId !== options.expectedIdentity.userId
      || clientResult.identity.tenantId !== options.expectedIdentity.tenantId)) {
    return {
      ok: false,
      reason: 'session_changed',
      message: `当前登录账号或企业已变化（${clientResult.identity.userName} · ${clientResult.identity.tenantName}）；请重新确认后再创建`,
      sessionFile: prepared.sessionFile,
    };
  }

  try {
    await options.onSessionReady?.({ source: prepared.source, identity: clientResult.identity });
    const credentials = await createOpenPlatformAppWithClient(clientResult.client, {
      ...options,
      creatorUserId: clientResult.identity.userId,
    });
    return {
      ok: true,
      ...credentials,
      brand: 'feishu',
      sessionFile: prepared.sessionFile,
      sessionSource: prepared.source,
      sessionIdentity: clientResult.identity,
    };
  } catch (err) {
    const message = safeErrorMessage(err);
    return {
      ok: false,
      reason: /默认应用图标/.test(message) ? 'missing_icon' : 'api_error',
      message,
      ...(err instanceof CreatedOpenPlatformAppError ? { appId: err.appId } : {}),
      sessionFile: prepared.sessionFile,
    };
  }
}

/**
 * 列出当前登录人可见的自建应用（console `getAppList` 同款：
 * POST /developers/v1/app/list，body {Count, Cursor, QueryFilter}，响应
 * data.apps + totalCount，分页拉全）。console 是内部接口，item 字段名做
 * 宽松解析，取不到 cli_ 开头 clientId 的条目丢弃。失败抛错（含 API 错误）。
 */
export async function listOpenPlatformApps(
  client: OpenPlatformApiClient,
  opts: { pageSize?: number; maxApps?: number } = {},
): Promise<OpenPlatformAppSummary[]> {
  const pageSize = opts.pageSize ?? 100;
  const maxApps = opts.maxApps ?? 500;
  const out: OpenPlatformAppSummary[] = [];
  for (let cursor = 0; cursor < maxApps; cursor += pageSize) {
    const payload = await client.postJson('/developers/v1/app/list', {
      Count: pageSize,
      Cursor: cursor,
      QueryFilter: {},
    });
    const record = asRecord(payload);
    const data = asRecord(record.data);
    const apps = Array.isArray(data.apps) ? data.apps : Array.isArray(record.apps) ? (record.apps as unknown[]) : [];
    for (const item of apps) {
      const rec = asRecord(item);
      const clientId = pickString(rec, ['clientId', 'client_id', 'appId', 'app_id', 'appID']);
      if (!clientId || !clientId.startsWith('cli_')) continue;
      const name = pickString(rec, ['name', 'appName', 'app_name']) ?? clientId;
      const description = pickString(rec, ['description', 'desc', 'appDesc', 'app_desc']);
      out.push({ clientId, name, ...(description ? { description } : {}) });
    }
    const totalCount = typeof data.totalCount === 'number' ? data.totalCount
      : typeof record.totalCount === 'number' ? (record.totalCount as number) : undefined;
    if (apps.length < pageSize) break;
    if (totalCount !== undefined && cursor + pageSize >= totalCount) break;
  }
  return out;
}

/**
 * 读取指定应用的 App Secret（console `getAppSecret` 同款：
 * POST /developers/v1/secret/:clientId，响应含 secret 字段）。
 * 只读接口——绝不触碰 /v1/secret/reset/*（会轮换 secret、打断在跑的 bot）。
 */
export async function fetchOpenPlatformAppSecret(
  client: OpenPlatformApiClient,
  clientId: string,
  opts: { idempotentRetry?: boolean } = {},
): Promise<string> {
  // 纯只读 POST（不触碰 reset）⟹ 语义幂等。建应用链路显式开启重试：应用已建成
  // 已发布，唯独最后一步读 Secret 撞网络抖动最可惜。预算只在 fetchRaw 一层。
  const payload = opts.idempotentRetry
    ? await client.postJsonIdempotent(`/developers/v1/secret/${clientId}`, {})
    : await client.postJson(`/developers/v1/secret/${clientId}`, {});
  const record = asRecord(payload);
  const secret = pickString(asRecord(record.data), ['secret']) ?? pickString(record, ['secret']);
  if (!secret) throw new Error('开放平台没有返回 secret 字段');
  return secret;
}

async function validateFeishuWebSession(cookies: StoredCookie[], fetcher: typeof fetch): Promise<boolean> {
  if (cookies.length === 0) return false;
  const session = new MutableCookieJar(cookies);
  try {
    const response = await session.fetchRaw(fetcher, `${ASK_FEISHU_ORIGIN}/`, { method: 'GET' });
    if (!response.ok) return false;
    const text = await response.text();
    return !isFeishuLoginLikeValue(text);
  } catch {
    return false;
  }
}

async function loginFeishuWebSession(fetcher: typeof fetch, options: FeishuWebSessionOptions): Promise<StoredCookie[]> {
  const session = new MutableCookieJar([]);
  const redirectUrl = `${ASK_FEISHU_ORIGIN}/`;
  // Implements Feishu Web QR session login directly: initialize
  // `/accounts/qrlogin/init`, poll `/accounts/qrlogin/polling`, follow the
  // returned cross-login URI, then persist the resulting cookie jar privately.
  const qrInit = await initFeishuQrLogin(session, fetcher, redirectUrl);
  const qrPayload = buildFeishuQrPayload(qrInit.token);
  const qrText = await renderTerminalQr(qrPayload);
  const onQrCode = options.onQrCode ?? defaultPrintFeishuQrCode;
  await onQrCode({ qrText, qrPayload });

  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const maxWaitMs = options.maxWaitMs ?? 120_000;
  const start = Date.now();
  let lastStatusMessage = '';
  let scanConfirmationEmitted = false;
  for (;;) {
    if (Date.now() - start > maxWaitMs) {
      throw new FeishuWebSessionError('等待飞书扫码超时', 'timeout');
    }

    const poll = await pollFeishuQrLogin(session, fetcher, qrInit.flowKey);
    if (poll.status === 2 && !scanConfirmationEmitted) {
      scanConfirmationEmitted = true;
      await options.onQrScanConfirmed?.({ confirmedAt: Date.now() });
    }
    if (poll.nextStep === 'enter_app') {
      if (poll.crossLoginUri) {
        await session.fetchRaw(fetcher, poll.crossLoginUri, { method: 'GET' });
      }
      await session.fetchRaw(fetcher, redirectUrl, { method: 'GET' });
      const cookies = session.toJSON();
      if (!await validateFeishuWebSession(cookies, fetcher)) {
        throw new FeishuWebSessionError('飞书扫码已完成，但没有拿到可复用的 Web session', 'invalid_session');
      }
      return cookies;
    }

    const statusMessage = mapFeishuQrPollingStatus(poll.status);
    if (options.onStatus && statusMessage !== lastStatusMessage) {
      lastStatusMessage = statusMessage;
      await options.onStatus(statusMessage);
    }
    if (poll.status === 5) {
      throw new FeishuWebSessionError('二维码已过期', 'qr_expired');
    }
    await sleep(pollIntervalMs);
  }
}

async function initFeishuQrLogin(
  session: MutableCookieJar,
  fetcher: typeof fetch,
  authorizeUrl: string,
): Promise<{ flowKey: string; token: string }> {
  const endpoint = `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/init?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`;
  const response = await session.fetchRaw(fetcher, endpoint, {
    method: 'POST',
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      biz_type: null,
      redirect_uri: authorizeUrl,
    }),
  });
  const data = await response.json();
  assertFeishuApiOk(data, 'Feishu QR init failed');
  const token = asRecord(asRecord(data).data).step_info
    ? pickString(asRecord(asRecord(asRecord(data).data).step_info), ['token'])
    : undefined;
  const flowKey = response.headers.get('x-flow-key') ?? '';
  if (!flowKey || !token) {
    throw new FeishuWebSessionError('Feishu QR init missing flow key or token', 'login_failed');
  }
  return { flowKey, token };
}

async function pollFeishuQrLogin(
  session: MutableCookieJar,
  fetcher: typeof fetch,
  flowKey: string,
): Promise<{ nextStep: string | null; status: number | null; crossLoginUri: string | null }> {
  const endpoint = `${FEISHU_ACCOUNTS_ORIGIN}/accounts/qrlogin/polling?_r${10000 + Math.floor(Math.random() * 80000)}=${Date.now()}`;
  const response = await session.fetchRaw(fetcher, endpoint, {
    method: 'POST',
    headers: {
      ...FEISHU_COMMON_HEADERS,
      'x-app-id': FEISHU_APP_ID,
      'x-flow-key': flowKey,
      accept: 'application/json',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ biz_type: null }),
  });
  const data = await response.json();
  assertFeishuApiOk(data, 'Feishu QR polling failed');
  const payload = asRecord(asRecord(data).data);
  const stepInfo = asRecord(payload.step_info);
  return {
    nextStep: pickString(payload, ['next_step']) ?? null,
    status: typeof stepInfo.status === 'number' ? stepInfo.status : null,
    crossLoginUri: pickString(stepInfo, ['cross_login_uri']) ?? null,
  };
}

export function readDefaultScopeManifest(): ScopeManifest {
  // Static JSON import (bundledScopeManifest) rather than readFileSync of a
  // module-relative path: Bun's `--compile` inlines the import into the binary,
  // whereas readFileSync(join(__dirname, ...)) resolves against the read-only
  // virtual /$bunfs at runtime and always missed — the first `setup --create-app`
  // from a curl install died with "找不到 botmux lark-scopes.json". structuredClone
  // so callers (e.g. filterScopeManifest) can mutate without corrupting the shared
  // bundled object.
  return structuredClone(bundledScopeManifest) as ScopeManifest;
}

// 宿主机到飞书的偶发网络抖动（DNS EAI_AGAIN、连接被重置、路由瞬断等）会让
// undici 把整个请求直接抛成 TypeError('fetch failed')，一次失败就中断 console
// 自动化链路（dashboard 改名/改头像、VC 事件订阅检查都实测偶发中招）。这类
// 错误按错误码识别，只对幂等请求小步退避重试。
const TRANSIENT_NETWORK_ERROR_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EPIPE',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [300, 900];

/**
 * 「TLS 握手完成之前连接就断了」——Node 内置 `_tls_wrap.js` 的 `onConnectEnd`
 * 唯一产出这句话（`ConnResetException`，code=ECONNRESET）。它的关键性质是
 * **可证明零副作用**，因此连非幂等写请求都能安全重放。
 *
 * 证明链（Node + undici 的 dispatch 时序，**不是**「握手未完成 ⟹ 没有加密通道」
 * —— 那个说法对 TLS 1.3 不成立：ServerHello 之后的握手消息已加密，协议还定义了
 * 0-RTT early data。成立的是下面这条客户端实现约束）：
 *   • undici 的 connector 只在 TLSSocket 的 `secureConnect` 监听器里回调
 *     （`socket.setNoDelay(true).once('secureConnect', … cb(null, this))`），
 *     HTTP client 拿到这个 socket 之后才 dispatch/write 请求；
 *   • `onConnectEnd` 只在建 socket 时 `prependListener('end', …)` 挂上，并在
 *     `onConnectSecure` 里摘掉。注意源码顺序是**先** `emit('secureConnect')`
 *     **再** `removeListener`，所以不能说成「先摘监听器再交给 undici」；成立的是：
 *     远端 FIN / `end` 只可能在后续 I/O 分派中被处理，而那时监听器已摘。因此这句
 *     错误产出时，`secureConnect` 监听器没有成功走完 ⟹ undici 还没拿到可 dispatch
 *     的连接 ⟹ 应用请求行 / 头 / body 未写出；
 *   • Node 目前也没有让 fetch 走 TLS 0-RTT early data 的路径。
 *   • 实测（本机 TCP 抓包型探针）：服务端只收到 1583 字节且首字节 0x16
 *     （TLS handshake record），文本里 **不含** 请求方法、路径与 body 字段；
 *     对照组「握手完成后才断」收到 248 字节应用数据，且错误换成
 *     `UND_ERR_SOCKET / other side closed` —— 两类错误可靠可分。
 *
 * 代理场景下「零字节」限定为**目标应用的 HTTP 请求**：HTTP proxy 的 CONNECT 可能
 * 已经发给代理，但目标 POST 尚未通过隧道发出，故「无重复副作用」的结论仍成立。
 *
 * ⚠️ 仅此一句话享受该待遇。`ECONNRESET` 本身**不够**：连接建成、请求已送达后
 * 被 RST 同样是 ECONNRESET，那种情况服务端可能已处理，重放会重复提交。
 *
 * ⚠️ 该形态绑定 Node/undici。Bun 原生 fetch 对同一真实故障抛的是顶层 `TypeError`
 * （message `The socket connection was closed unexpectedly...`、code=ECONNRESET、
 * **无 cause**），不满足本判据 ⟹ 不命中、不重试（保持旧行为）。这是已知的跨运行时
 * 缺口而非安全问题；要覆盖 Bun 必须先为它的文案建立同等级的「只可能握手前」证明。
 */
const PRE_TLS_DISCONNECT_MESSAGE =
  'Client network socket disconnected before secure TLS connection was established';

/**
 * 传输层失败是否**可证明「请求未送达」**，即重放绝不会产生重复副作用。
 * 只认 {@link PRE_TLS_DISCONNECT_MESSAGE} 那一句（唯一可证明未送达的
 * ECONNRESET）。外层会被 undici 包成 `TypeError('fetch failed', { cause })`，
 * 故顺**单一 cause 链**找。
 *
 * ⚠️ 刻意**不支持 AggregateError**，这是有意收窄而非遗漏：
 *   • 真实的 Node pre-TLS 断连本来就不是聚合体 —— `net.internalConnectMultiple`
 *     只在**所有** TCP connect 尝试失败时才构造 `NodeAggregateError`（成员一律
 *     来自 `createConnectionError(…, 'connect', …)`），而这句文案由
 *     `_tls_wrap.onConnectEnd` 在某条腿 connect **成功之后**才可能产出，两者
 *     互斥；
 *   • 一旦支持聚合体，就要对 `.errors` 与 `AggregateError` 同样合法的 `.cause`
 *     同时做全称量词检查，任一遗漏都是 fail-open（实测：
 *     `new AggregateError([preTls], '', { cause: socketHangUp })` 会被放行）。
 *     provably 的证明责任配不上这点收益。
 *
 * 同理，精确文案的节点若**自带 cause**，说明它不是我们证明过的那个
 * `ConnResetException`（Node 构造它时不挂 cause），一律 fail-closed。
 */
function isProvablyUnsentTransportError(err: unknown, depth = 0): boolean {
  if (depth > 4 || !(err instanceof Error)) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  if (err instanceof AggregateError) return false;
  if ((err as { code?: unknown }).code === 'ECONNRESET' && err.message === PRE_TLS_DISCONNECT_MESSAGE) {
    return err.cause === undefined;
  }
  return isProvablyUnsentTransportError((err as { cause?: unknown }).cause, depth + 1);
}

function isLikelyTransientNetworkError(err: unknown, depth = 0): boolean {
  if (depth > 4 || !(err instanceof Error)) return false;
  // 调用方主动 abort / 超时不算网络抖动，重试会违背调用方意图。
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_NETWORK_ERROR_CODES.has(code)) return true;
  if (err instanceof AggregateError && err.errors.some(item => isLikelyTransientNetworkError(item, depth + 1))) {
    return true;
  }
  // undici 网络层失败统一表现为 TypeError('fetch failed', { cause })；cause 缺失
  // （老版本/被吞）时按瞬态处理——多试两次的代价远小于误报一次给用户。
  if (err instanceof TypeError && err.message === 'fetch failed') {
    return err.cause === undefined || isLikelyTransientNetworkError(err.cause, depth + 1);
  }
  return isLikelyTransientNetworkError((err as { cause?: unknown }).cause, depth + 1);
}

class MutableCookieJar {
  private cookies: StoredCookie[];

  constructor(cookies: StoredCookie[]) {
    this.cookies = pruneExpiredCookies(cookies);
  }

  toJSON(): StoredCookie[] {
    this.cookies = pruneExpiredCookies(this.cookies);
    return this.cookies.map(cookie => ({ ...cookie }));
  }

  async fetchText(fetcher: typeof fetch, url: string): Promise<string> {
    const response = await this.fetchRaw(fetcher, url, { method: 'GET' });
    return await response.text();
  }

  async fetchTextWithUrl(fetcher: typeof fetch, url: string): Promise<{ text: string; finalUrl: string }> {
    const response = await this.fetchRaw(fetcher, url, { method: 'GET' });
    return {
      text: await response.text(),
      finalUrl: finalResponseUrl(response, url),
    };
  }

  async fetchRaw(
    fetcher: typeof fetch,
    url: string,
    init: RequestInit = {},
    maxHops = 10,
    opts: { idempotent?: boolean } = {},
  ): Promise<Response> {
    let current = url;
    let referer: string | undefined;
    // 幂等的 GET/HEAD：任意瞬态网络错误都可小步退避重试。
    // POST 全是 console 写操作或登录流程，传输错误时服务端可能已 commit（结果
    // 未知），重试等于重复提交 —— 唯一例外是「TLS 握手完成前就断连」，那类错误
    // 可证明请求一个字节都没发出去（见 isProvablyUnsentTransportError），重放
    // 不可能产生重复副作用；不放过它的代价是一次网络毛刺就让用户的改名/改头像
    // 整轮失败。
    // `opts.idempotent` 让调用方声明「这个 POST 重复调用无副作用」（robot/event
    // switch 设值、只读拉 Secret），从而与 GET/HEAD 同权：认全部瞬态错误。
    // 关键是预算**只此一层**——历史上这三处在外层另包了一轮 retry，与内层相乘
    // 成 9 次（实测 4.8s 退避）；预算集中在这里后总尝试恒为 3。
    const method = (init.method ?? 'GET').toUpperCase();
    const retryable = opts.idempotent === true || method === 'GET' || method === 'HEAD';
    for (let hop = 0; hop <= maxHops; hop += 1) {
      const headers = new Headers(init.headers);
      const cookieHeader = getCookieHeader(this.cookies, current);
      if (cookieHeader) headers.set('cookie', cookieHeader);
      headers.set('user-agent', headers.get('user-agent') ?? DEFAULT_BROWSER_USER_AGENT);
      if (referer && !headers.has('referer')) headers.set('referer', referer);

      let response: Response;
      for (let attempt = 0; ; attempt += 1) {
        try {
          response = await fetcher(current, { ...init, headers, redirect: 'manual' });
          break;
        } catch (err) {
          // 可重试 = 幂等方法遇任意瞬态错误，或任意方法遇「可证明未送达」的
          // pre-TLS 断连。后者对写操作也安全（零字节送达 ⟹ 无副作用）。
          const mayRetry = retryable
            ? isLikelyTransientNetworkError(err)
            : isProvablyUnsentTransportError(err);
          if (attempt >= TRANSIENT_FETCH_RETRY_DELAYS_MS.length || !mayRetry) {
            throw err;
          }
          await sleep(TRANSIENT_FETCH_RETRY_DELAYS_MS[attempt]);
        }
      }
      this.loadFromResponse(current, response.headers);
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return response;
        referer = current;
        current = new URL(location, current).toString();
        continue;
      }
      markFinalResponseUrl(response, current);
      return response;
    }
    throw new Error('Too many redirects while accessing open platform');
  }

  private loadFromResponse(responseUrl: string, headers: Headers): void {
    const rawSetCookies = typeof (headers as any).getSetCookie === 'function'
      ? (headers as any).getSetCookie()
      : splitSetCookieHeader(headers.get('set-cookie'));
    for (const raw of rawSetCookies) {
      const cookie = parseSetCookie(responseUrl, raw);
      if (!cookie) continue;
      const idx = this.cookies.findIndex(item => item.name === cookie.name && item.domain === cookie.domain && item.path === cookie.path);
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= Date.now()) {
        if (idx >= 0) this.cookies.splice(idx, 1);
        continue;
      }
      if (idx >= 0) this.cookies[idx] = cookie;
      else this.cookies.push(cookie);
    }
    this.cookies = pruneExpiredCookies(this.cookies);
  }
}

export class OpenPlatformApiError extends Error {
  constructor(message: string, readonly payload: unknown, readonly status: number) {
    super(message);
  }
}

function openPlatformOwnerAccessDenied(error: unknown): boolean {
  if (!(error instanceof OpenPlatformApiError)) return false;
  const payload = asRecord(error.payload);
  return error.status === 403 && payload.code === 10003;
}

/**
 * 飞书开放平台的「应用整体正在审核中」锁：`code=10046 审核中, 请刷新`。
 *
 * 审核期间应用配置被**整体写锁**——实测被拒的不只是发版，还包括
 * `scope/update`（申请权限本体）、`robot/switch`、`safe_setting/update`、`base_info`；
 * 读接口（`scope/all` / `privilege/all` / `app_version/list` / `visible/online` /
 * `event/` / `callback/`）全部照常可读。
 *
 * 所以这是一种**等待即可自愈**的状态，不是配置错误：审批通过后写操作自然恢复。历史
 * 行为是把它当普通 `api_error` 硬失败，于是每次 daemon 重启都把整条链路重跑一遍、
 * 再报一次「开放平台 API 错误」（线上两台别人的 bot 今天各撞 8 次），既没用又盖掉了
 * 真实原因。识别出来单独给个 reason，让调用方能说人话、并且**不必反复重试**。
 */
export function openPlatformUnderReview(error: unknown): boolean {
  if (!(error instanceof OpenPlatformApiError)) return false;
  return asRecord(error.payload).code === 10046;
}

class FeishuWebSessionError extends Error {
  constructor(message: string, readonly reason: FeishuWebSessionFailureReason) {
    super(message);
  }
}

const DEFAULT_BROWSER_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

function defaultPrintFeishuQrCode(info: { qrText: string }): void {
  process.stderr.write('\n请用飞书 App 扫码完成开放平台自动配置登录：\n\n');
  process.stderr.write(`${info.qrText}\n`);
  process.stderr.write('如果当前环境无法扫码，可重新运行 `botmux setup --no-open-platform-auto` 跳过自动配置。\n\n');
}

async function renderTerminalQr(payload: string): Promise<string> {
  return await new Promise((resolve) => qrcode.generate(payload, { small: true }, qr => resolve(qr)));
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertFeishuApiOk(payload: unknown, message: string): void {
  const record = asRecord(payload);
  if (record.code === 0) return;
  const msg = pickString(record, ['message', 'msg']) ?? 'unknown error';
  throw new FeishuWebSessionError(`${message}: ${msg}`, 'login_failed');
}

function isFeishuLoginLikeValue(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized.includes('/accounts/') || normalized.includes('/login') || normalized.includes('qrlogin');
}

function classifyFeishuLoginError(err: unknown): FeishuWebSessionFailureReason {
  if (err instanceof FeishuWebSessionError) return err.reason;
  const message = err instanceof Error ? err.message : String(err);
  if (/timeout|timed out|超时/i.test(message)) return 'timeout';
  if (/expired|过期/i.test(message)) return 'qr_expired';
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|fetch failed|network/i.test(message)) return 'network';
  return 'login_failed';
}

function collectScopeEntries(value: unknown, bucket: 'tenant' | 'user' | undefined, out: OpenPlatformScopeEntry[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectScopeEntries(item, bucket, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  const name = pickString(record, ['scope_name', 'scopeName', 'name', 'key', 'scopeKey']);
  const id = pickString(record, ['id', 'scope_id', 'scopeId', 'scopeID']);
  if (name && id) out.push({ name, id, bucket });
  for (const [key, child] of Object.entries(record)) {
    const nextBucket = /user/i.test(key)
      ? 'user'
      : /app|client|tenant/i.test(key)
        ? 'tenant'
        : bucket;
    if (child && typeof child === 'object') collectScopeEntries(child, nextBucket, out);
  }
}

/**
 * 从一条 privilege 里取出数据范围表单的字段定义。
 *
 * 字段在响应里出现**两处**：解析好的 `schemaContent.selectionExpressionSchemaContent`
 * 和原始 JSON 字符串 `schema`（内层 key 是首字母大写的
 * `SelectionExpressionSchemaContent`）。优先用前者，缺失时回退解析后者——两者
 * 在实测数据里内容一致，但结构化那份不保证一直在。
 */
function extractPrivilegeStaffFields(record: Record<string, unknown>): OpenPlatformPrivilegeField[] {
  const structured = asRecord(asRecord(record.schemaContent).selectionExpressionSchemaContent);
  let rawFields = Array.isArray(structured.fields) ? structured.fields : undefined;
  if (!rawFields) {
    const schemaText = pickString(record, ['schema']);
    if (schemaText) {
      try {
        const parsed = asRecord(asRecord(JSON.parse(schemaText)).schema_content);
        const inner = asRecord(parsed.SelectionExpressionSchemaContent);
        if (Array.isArray(inner.fields)) rawFields = inner.fields;
      } catch {
        // schema 不是合法 JSON:当作没有字段,上层 canFill… 会因此跳过这条
      }
    }
  }
  if (!rawFields) return [];
  const fields: OpenPlatformPrivilegeField[] = [];
  for (const entry of rawFields) {
    const field = asRecord(entry);
    const id = pickString(field, ['id']);
    if (!id) continue;
    const operators = Array.isArray(field.operators) ? field.operators : [];
    fields.push({
      id,
      name: pickString(field, ['name']) ?? '',
      selectStaff: pickString(asRecord(field.data_source), ['type']) === 'select_staff',
      supportsIn: operators.includes('in'),
    });
  }
  return fields;
}

function mapScopeIds(scopeNames: string[], catalog: OpenPlatformScopeEntry[], bucket: 'tenant' | 'user') {
  const ids: string[] = [];
  const missing: string[] = [];
  for (const scopeName of scopeNames) {
    const matched =
      catalog.find(entry => entry.name === scopeName && entry.bucket === bucket) ??
      catalog.find(entry => entry.name === scopeName && entry.bucket === undefined) ??
      catalog.find(entry => entry.name === scopeName);
    if (matched) ids.push(matched.id);
    else missing.push(scopeName);
  }
  return { ids: uniqueStrings(ids), missing };
}

/** 从 app_version/list 响应算下一个版本号（最新已发布 +1，无发布版 → 0.0.1）。 */
export function nextAppVersion(payload: unknown): string {
  const data = asRecord(asRecord(payload).data);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  // 取所有版本(含未发布草稿)里的最大三段号 +1——不能只看已发布版本:若存在
  // 未发布草稿(如上架启用失败留下的 1.0.0),只看已发布会算出 0.0.1 撞车,导致
  // 二次发版被平台以「版本号未递增」拒掉,应用永远停在未启用。
  const triples = versions
    .map(item => pickString(asRecord(item), ['appVersion']))
    .filter((version): version is string => Boolean(version))
    .map(version => version.split('.').map(part => Number.parseInt(part, 10)))
    .filter(parts => parts.length === 3 && parts.every(part => Number.isFinite(part)));
  if (triples.length === 0) return '0.0.1';
  const max = triples.reduce((a, b) => {
    for (let i = 0; i < 3; i++) {
      if (b[i] !== a[i]) return b[i] > a[i] ? b : a;
    }
    return a;
  });
  return [max[0], max[1], max[2] + 1].join('.');
}

/**
 * console `app_version/list` 里 `versionStatus` 的取值。**别用公开 API
 * (`application/v6/.../app_versions`) 的 `status` 语义去读它** ——两套枚举不一样，
 * 实测同一批版本的对照（左 console / 右公开 API）：
 *
 * | console `versionStatus` | 公开 API `status` | 含义 |
 * |---|---|---|
 * | `0`   | `4` | 未提交审核（草稿） |
 * | `1`   | `3` | 审核中 |
 * | `2`   | `1` | 已上线（当前线上版本） |
 * | `100` | `1` | 历史已上线版本 |
 *
 * 草稿定 `DRAFT`、审核中定 `IN_REVIEW`：两者语义**相反**（草稿要提交，审核中要撤回），
 * 各有一个消费者。判据一律写成 `=== 常量`，别写 `!== 某个` 这种反向式——那会把
 * `100`/`2`（历史/当前线上版本）也一起卷进来。
 */
export const CONSOLE_VERSION_STATUS_DRAFT = 0;
export const CONSOLE_VERSION_STATUS_IN_REVIEW = 1;

/**
 * 找出 `app_version/list` 里那个**未提交审核的草稿**（console 上「待提交」）。
 *
 * 为什么需要它：飞书**不允许并存两个未提交版本**——存在草稿时 `app_version/create`
 * 一律回 `code=10043 版本已创建，请刷新`。而 botmux 的权限自愈每次都想发一版，于是
 * 一个草稿就能把自愈**永久**卡死：每次 daemon 重启都重跑一遍必败的请求，还给管理员
 * 重发一遍「缺 N 项权限」的 DM（线上实测一天 5 次，其中一台还是别人的 bot）。
 *
 * ⚠️ **只认草稿（`versionStatus=0`），绝不碰审核中（`versionStatus=1`）。** 审核中
 * 的版本是别人真的提交上去、正在排队的东西，自动流程去动它等于把人家的审批干掉。
 * 线上就有两台处于审核中且**不属于本机 owner**，所以这个边界是硬的。
 *
 * 返回草稿的 `versionId`；没有草稿返回 undefined。
 */
export function findUncommittedDraftVersionId(payload: unknown): string | undefined {
  const data = asRecord(asRecord(payload).data);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  for (const item of versions) {
    const record = asRecord(item);
    if (record.versionStatus !== CONSOLE_VERSION_STATUS_DRAFT) continue;
    const versionId = pickString(record, ['versionId', 'version_id', 'id']);
    if (versionId) return versionId;
  }
  return undefined;
}

/**
 * 回读 `app_version/list`，确认某个 versionId **真的离开了草稿态**。
 *
 * `publish/commit` 返回 `code=0` **不等于**版本已提交：线上实测过一次
 * commit 回 `{code:0, data:{isOk:true}}`、版本却仍停在 `versionStatus=0`，于是日志
 * 高高兴兴写「version … published」，实际留下的正是卡死后续所有自愈的那个草稿。
 * 同文件里 `eventModeReady` 早就立了「switch 接口返回成功≠生效，必须回读」的规矩，
 * 发版这条链路照抄一遍。
 *
 * 返回 true = 该版本已不是草稿（已上线或已进审核）。
 */
export function isVersionCommitted(payload: unknown, versionId: string): boolean {
  const data = asRecord(asRecord(payload).data);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  for (const item of versions) {
    const record = asRecord(item);
    if (pickString(record, ['versionId', 'version_id', 'id']) !== versionId) continue;
    return record.versionStatus !== CONSOLE_VERSION_STATUS_DRAFT;
  }
  // 版本号在列表里找不到 → 无法证明它已提交，保守判 false（宁可多报一句 warning，
  // 也不要重复上一次「拿 code=0 当已发布」的错）。
  return false;
}

/**
 * 找出正在**审核中**的版本（console 上「审核中」）。
 *
 * 与 {@link findUncommittedDraftVersionId} 是**互补的两种卡死**：草稿（0）让
 * `app_version/create` 撞 `code=10043`；审核中（1）让开放平台把**整个应用配置写锁**
 * （`scope/update` / `robot/switch` / `safe_setting/update` 全回 `code=10046`），
 * 详见 {@link openPlatformUnderReview}。
 *
 * 审核中的版本**只能先撤回**才能改配置——console 自己也这么说（"Unable to edit, as
 * the organization administrator is reviewing the app's version release request."），
 * 它的 Withdraw 按钮打的就是 {@link cancelPendingReviewVersion} 里那个端点。
 */
export function findInReviewVersionId(payload: unknown): string | undefined {
  const data = asRecord(asRecord(payload).data);
  const versions = Array.isArray(data.versions) ? data.versions : [];
  for (const item of versions) {
    const record = asRecord(item);
    if (record.versionStatus !== CONSOLE_VERSION_STATUS_IN_REVIEW) continue;
    const versionId = pickString(record, ['versionId', 'version_id', 'id']);
    if (versionId) return versionId;
  }
  return undefined;
}

/**
 * 撤回一个正在审核中的版本，好让应用配置重新可写。
 *
 * 端点是从 console 实测抓来的（**不是猜的**）：版本详情页的 Withdraw 按钮打
 * `POST /developers/v1/publish/cancel_commit/<appId>/<versionId>`，body `{}` ——
 * 与既有的 `publish/commit/<appId>/<versionId>` 完全对称。当时用页面内 hook 拦下了
 * 请求所以没有真撤掉别人的审批。
 *
 * 🔴 **当前没有任何自动调用方，这是刻意的。** 曾经在「缺必需权限 + 审核中」时自动撤，
 * 后来判定那是错的：**触发审批通常意味着有配置不合规**（最常见是数据范围默认「全部」，
 * 撞租户加签规则），撤回重提会被同一条规则再拦一次 ⟹ 等于用不可逆动作（丢掉审批队列
 * 位置，线上见过排 18 / 23 天的）驱动一个死循环。更一般地：**审批是规则驱动的闸，不是
 * 队列**，撤回不绕过规则、只丢位置。所以正确处置是告诉人、让人改配置后自己撤。
 *
 * 保留它是为了「检测」与将来可能的**人工辅助**入口（比如显式命令）。若要再接自动调用，
 * 先回答「撤回之后凭什么这次能过」—— 答不上就不该撤。
 *
 * 撤回后**回读确认**：`cancel_commit` 返回 code=0 不等于状态真的变了（同一个坑在
 * `publish/commit` 上已经栽过一次，见 {@link isVersionCommitted}）。
 */
export async function cancelPendingReviewVersion(
  postJson: OpenPlatformPostJson,
  appId: string,
  versionId: string,
): Promise<{ ok: boolean; message?: string }> {
  try {
    await postJson(`/developers/v1/publish/cancel_commit/${appId}/${versionId}`, {});
  } catch (err: any) {
    return { ok: false, message: `撤回审核中版本失败: ${safeErrorMessage(err)}` };
  }
  try {
    const after = await postJson(`/developers/v1/app_version/list/${appId}`, {});
    if (findInReviewVersionId(after) === versionId) {
      return { ok: false, message: `版本 ${versionId} 撤回后回读仍是「审核中」` };
    }
    return { ok: true };
  } catch (err: any) {
    // 撤回请求本身没报错，只是回读失败 ⟹ 状态未知。当作失败处理（保守），让上层
    // 落回「审核中」提示而不是继续往一个可能仍锁着的应用上写。
    return { ok: false, message: `撤回后状态回读失败（无法确认）: ${safeErrorMessage(err)}` };
  }
}

/**
 * 「提交发布后会不会**秒过**」的预判结果。
 *
 * `autoApproved: true` = 审批流里除「发起 / 结束 / 抄送」外的节点全是「自动通过」，
 * 没有任何真人审批人 ⟹ 提交它不打扰任何人、立即生效。
 */
export interface ApprovalFlowPrediction {
  /** 能否确定地判断（false = 接口报错 / 结构不认识 / 算不出流程，调用方必须 fail-closed）。 */
  known: boolean;
  /** 全自动通过且零真人审批人。仅 known:true 时有意义。 */
  autoApproved: boolean;
  /** 流程里的真人审批人姓名（抄送人不算——抄送只是知会，不阻塞）。 */
  humanApprovers: string[];
  /** 无法判断时的原因（进日志用）。 */
  reason?: string;
}

/** 审批流程里「不构成审批关卡」的节点名（中英文环境都出现过）。 */
const APPROVAL_FLOW_NON_GATE_NODES = new Set(['发起', '结束', 'Initiate', 'End']);
/** console 对「这一关不需要人审」的节点类型取值（中/英文环境）。 */
const APPROVAL_FLOW_AUTO_NODE_TYPES = new Set(['自动通过', 'Auto approved']);

/**
 * 解析 `approval_nodes/get` 的返回，判断这一版提交后是否会自动通过。
 *
 * ⚠️ **两个「名字像在回答这个问题、实际答的是另一个」的字段，都不能当判据**：
 *
 * | 字段 | 来源 | 实测 | 真实语义 |
 * |---|---|---|---|
 * | `canAutoApproval` | 同一个 `approval_nodes/get` 响应 | 秒过那台是 **false**、无待发布版本那台反而 **true** | 更像「理论上能否免审」，与本次会不会秒过**相反** |
 * | `ApprovalType` | `config/audit_rule` | 秒过/要人审的 **4 台全是 1**，只有无待发布版本那台是 0 | 更像「有没有审批流」 |
 *
 * 两个都跨 5～6 台实测过。判据只能落在 `applyNodes` 的节点类型上 —— 上面那张表是为了
 * 让后人别图省事去读那两个字段（名字比 `applyNodes` 好懂得多，正因如此才危险）。
 *
 * ⚠️ 解析路径是 `data.applyInstanceInfo.applyNodes`。**不是** `approvalNodes.nodes`
 * ——按那个路径读，跨 6 台 bot 全部返回空数组，「所有输入同一输出」正是判据失效的
 * 特征（当时打了原始 JSON 才找到真路径）。
 *
 * 抄送人（`nodeCcUser`）**不算**审批人：抄送只知会、不阻塞流程，把它算进去会让本可
 * 自动提交的版本被误判成需要人工。
 */
export function predictApprovalFlow(payload: unknown): ApprovalFlowPrediction {
  const nodes = asRecord(asRecord(asRecord(payload).data).applyInstanceInfo).applyNodes;
  if (!Array.isArray(nodes) || nodes.length === 0) {
    // 空数组的正常成因是「没有待发布版本，无流程可算」，不是故障；但既然算不出来，
    // 就必须让调用方走保守路径，不能默认成「可以自动提交」。
    return { known: false, autoApproved: false, humanApprovers: [], reason: '审批流程为空（可能没有待发布版本）' };
  }
  const gates = nodes
    .map(node => asRecord(node))
    .filter(node => {
      const name = pickString(node, ['nodeName']) ?? '';
      if (APPROVAL_FLOW_NON_GATE_NODES.has(name)) return false;
      // 抄送节点：有 nodeCcUser 且没有 nodeUser
      const cc = Array.isArray(node.nodeCcUser) ? node.nodeCcUser : [];
      const users = Array.isArray(node.nodeUser) ? node.nodeUser : [];
      return !(cc.length > 0 && users.length === 0);
    });
  if (gates.length === 0) {
    return { known: false, autoApproved: false, humanApprovers: [], reason: '审批流程里没有可判定的关卡节点' };
  }
  const humanApprovers: string[] = [];
  for (const gate of gates) {
    for (const entry of (Array.isArray(gate.nodeUser) ? gate.nodeUser : [])) {
      const name = pickString(asRecord(asRecord(entry).approver), ['name', 'enName']);
      if (name) humanApprovers.push(name);
    }
  }
  const allAuto = gates.every(gate => APPROVAL_FLOW_AUTO_NODE_TYPES.has(pickString(gate, ['nodeType']) ?? ''));
  return {
    known: true,
    autoApproved: allAuto && humanApprovers.length === 0,
    humanApprovers: uniqueStrings(humanApprovers),
  };
}

/**
 * 查这一版提交后是否会自动通过。
 *
 * body 必须**带全字段**：只传 `{}` 会被开放平台拒 `code=10001 请求错误，请刷新页面后重试`。
 * `visibleSuggest` 用线上现值原样填（与发版同源，见 {@link parseOnlineVisibility}），
 * 因为可见范围会影响审批规则（申请全员范围要加签）。
 *
 * 任何异常都返回 `known:false`，由调用方 fail-closed —— 判不出来时**不许**自动提交。
 */
export async function fetchApprovalFlowPrediction(
  postJson: OpenPlatformPostJson,
  appId: string,
  versionId: string,
  visibility: { visibleSuggest: VisibilitySuggest; blackVisibleSuggest: VisibilitySuggest },
): Promise<ApprovalFlowPrediction> {
  try {
    const payload = await postJson(`/developers/v1/approval_nodes/get/${appId}`, {
      visibleSuggest: visibility.visibleSuggest,
      blackVisibleSuggest: visibility.blackVisibleSuggest,
      b2cShareSplitConfigSuggest: {
        b2cGroupChatShareEnable: false,
        b2cP2PChatShareEnable: false,
        b2cP2PChatNeedAudit: false,
      },
      versionId,
      notCalculateFlow: false,
    });
    return predictApprovalFlow(payload);
  } catch (err: any) {
    return { known: false, autoApproved: false, humanApprovers: [], reason: safeErrorMessage(err) };
  }
}

/** 从 app_version/create 响应提取 versionId（多种响应形态兼容）。 */
export function extractVersionId(payload: unknown): string | undefined {
  const direct = pickString(asRecord(payload), ['versionId', 'version_id', 'id']);
  if (direct) return direct;
  const data = asRecord(asRecord(payload).data);
  return pickString(data, ['versionId', 'version_id', 'id']) ?? pickString(asRecord(data.appVersion), ['versionId', 'version_id', 'id']);
}

function extractBalancedJsonObject(input: string, start: number): string | null {
  if (input[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < input.length; i += 1) {
    const char = input[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return input.slice(start, i + 1);
    }
  }
  return null;
}

function pickString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function isStoredCookieRecord(value: unknown): value is StoredCookie {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const cookie = value as Partial<StoredCookie>;
  return typeof cookie.name === 'string'
    && typeof cookie.value === 'string'
    && typeof cookie.domain === 'string'
    && typeof cookie.path === 'string'
    && typeof cookie.secure === 'boolean'
    && typeof cookie.httpOnly === 'boolean'
    && typeof cookie.hostOnly === 'boolean';
}

function pruneExpiredCookies(cookies: StoredCookie[]): StoredCookie[] {
  const now = Date.now();
  return cookies.filter(cookie => cookie.expiresAt === undefined || cookie.expiresAt > now);
}

function domainMatches(hostname: string, cookie: StoredCookie): boolean {
  const host = hostname.toLowerCase();
  const domain = cookie.domain.replace(/^\./, '').toLowerCase();
  if (cookie.hostOnly) return host === domain;
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function splitSetCookieHeader(header: string | null): string[] {
  if (!header) return [];
  const parts: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < header.length; i += 1) {
    const slice = header.slice(Math.max(0, i - 8), i + 1).toLowerCase();
    if (slice.endsWith('expires=')) inExpires = true;
    if (inExpires && header[i] === ';') inExpires = false;
    if (!inExpires && header[i] === ',') {
      parts.push(header.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(header.slice(start).trim());
  return parts.filter(Boolean);
}

function parseSetCookie(responseUrl: string, header: string): StoredCookie | null {
  const url = new URL(responseUrl);
  const parts = header.split(';').map(part => part.trim()).filter(Boolean);
  const first = parts.shift();
  if (!first) return null;
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const cookie: StoredCookie = {
    name: first.slice(0, eq),
    value: first.slice(eq + 1),
    domain: url.hostname,
    path: '/',
    secure: false,
    httpOnly: false,
    hostOnly: true,
  };
  for (const part of parts) {
    const partEq = part.indexOf('=');
    const key = (partEq >= 0 ? part.slice(0, partEq) : part).trim().toLowerCase();
    const value = partEq >= 0 ? part.slice(partEq + 1).trim() : '';
    if (key === 'domain' && value) {
      cookie.domain = value.toLowerCase();
      cookie.hostOnly = false;
    } else if (key === 'path' && value) {
      cookie.path = value;
    } else if (key === 'secure') {
      cookie.secure = true;
    } else if (key === 'httponly') {
      cookie.httpOnly = true;
    } else if (key === 'expires' && value) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) cookie.expiresAt = parsed;
    } else if (key === 'max-age' && value) {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) cookie.expiresAt = Date.now() + seconds * 1000;
    } else if (key === 'samesite' && value) {
      cookie.sameSite = value;
    }
  }
  return cookie;
}

function summarizeOpenPlatformPayload(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return String(payload);
  const record = payload as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ['code', 'msg', 'message', 'error', 'error_msg']) {
    if (record[key] !== undefined) summary[key] = record[key];
  }
  return JSON.stringify(summary).slice(0, 500);
}

export function safeErrorMessage(err: unknown): string {
  // undici 把网络失败包成 TypeError('fetch failed', { cause })，真实原因
  // （ECONNRESET / EAI_AGAIN / 具体地址等）全在 cause 链里——不带上它，用户和
  // 排障方永远只能看到一句 "fetch failed"。
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof AggregateError && !current.message && current.errors.length > 0) {
      current = current.errors[0];
    }
    const message = current instanceof Error ? current.message : String(current);
    const code = (current as { code?: unknown }).code;
    const part = typeof code === 'string' && code && !message.includes(code)
      ? (message ? `${message} (${code})` : code)
      : message;
    if (part && parts[parts.length - 1] !== part) parts.push(part);
    current = current instanceof Error ? current.cause : undefined;
  }
  const combined = parts.join(': ') || (err instanceof Error ? err.message : String(err));
  return combined.replace(/[A-Za-z0-9_=-]{24,}/g, '***');
}

function markFinalResponseUrl(response: Response, finalUrl: string): void {
  try {
    Object.defineProperty(response, 'botmuxFinalUrl', {
      value: finalUrl,
      configurable: true,
    });
  } catch {
    // Response can be non-extensible in some runtimes; fall back to response.url.
  }
}

function finalResponseUrl(response: Response, fallbackUrl: string): string {
  return typeof (response as any).botmuxFinalUrl === 'string'
    ? (response as any).botmuxFinalUrl
    : response.url || fallbackUrl;
}
