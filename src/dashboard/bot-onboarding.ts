import { createRequire } from 'node:module';
import { readBotsJsonOrEmpty, writeBotsJsonAtomic } from '../setup/bots-store.js';
import { normalizeBotConfig, findInvalidAllowedUserEntries, hasOwnerEntry } from '../setup/bot-config-editor.js';
import { tryRegisterApp, type RegisterAppOptions, type RegisterAppResult } from '../setup/register-app.js';
import { validateCredentials, buildRemainingSteps, type CredentialValidation, type RemainingStep } from '../setup/verify-permissions.js';
import {
  automateOpenPlatformSetup,
  type OpenPlatformAutomationOptions,
  type OpenPlatformAutomationResult,
} from '../setup/open-platform-automation.js';
import type { CliId } from '../adapters/cli/types.js';
import { type Brand, sdkDomain } from '../im/lark/lark-hosts.js';
import * as Lark from '@larksuiteoapi/node-sdk';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode') as any;
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as Record<string, unknown>;

export type BotOnboardingStatus =
  | 'starting'
  | 'waiting_for_scan'
  | 'verifying'
  // bots.json 已写入, 正在自动配置开放平台权限 (导入 scope / redirect / 发版).
  | 'configuring_permissions'
  // 自动配置需要第二次扫码 (登录开放平台 Web 会话); 与建应用的 QR 不是同一个.
  | 'waiting_for_platform_scan'
  // 扫码人身份无法被新 app 验证 → 不落盘空 allowedUsers 的开放 bot, 等用户在
  // Dashboard 手动填写并通过校验的 owner 后才进入 completed (fail-closed).
  | 'needs_owner'
  | 'completed'
  | 'failed';

/** 开放平台权限自动配置结果, 供前端展示成功摘要或手动兜底步骤. */
export interface BotOnboardingPermission {
  ok: boolean;
  /** 成功导入的权限数 */
  scopeCount?: number;
  /** 当前租户目录里没有、被跳过的权限数 */
  skippedScopeCount?: number;
  /** 已提交发布的版本号 */
  versionId?: string;
  /** 部分权限注册失败的告警 */
  scopeWarning?: string;
  /** 失败原因 / 信息 (失败时给出手动步骤) */
  reason?: string;
  message?: string;
}

export interface BotOnboardingSnapshot {
  id: string;
  status: BotOnboardingStatus;
  createdAt: number;
  updatedAt: number;
  // 建应用扫码 (第 1 个二维码)
  qrUrl?: string;
  qrDataUrl?: string;
  expireAt?: number;
  // 开放平台登录扫码 (第 2 个二维码, 自动配置权限用; 缓存命中则不出现)
  platformQrDataUrl?: string;
  /** 自动配置进度文案 (来自 automation onStatus) */
  permissionStatusMsg?: string;
  appId?: string;
  brand?: 'feishu' | 'lark';
  // 实际写入的 CLI / 工作目录, 供前端完成页回显
  cliId?: string;
  workingDir?: string;
  addedBotIndex?: number;
  /**
   * 新 bot 是否已自动上线（`botmux start-bot`，无需整组 botmux restart）。
   * true = 已拉起单个 daemon 进程并开始收飞书消息；false = 尝试失败（回退到
   * 「请重启」提示）；undefined = 未尝试（无 startBotLive 注入，如单测）。
   */
  liveStarted?: boolean;
  /** 自动上线的诊断信息（成功给进程名，失败给原因），供前端提示。 */
  liveStartMessage?: string;
  permission?: BotOnboardingPermission;
  /** 自动配置失败时的手动权限步骤 (深链) */
  remainingSteps?: RemainingStep[];
  error?: string;
  message?: string;
}

/** 调用方 (dashboard) 已校验过的表单输入: CLI / 工作目录 / model. */
export interface BotOnboardingInput {
  cliId?: CliId;
  /** 通用启动前缀（如 "aiden x claude"）；aiden×* 选项解析所得，普通 CLI 为空。 */
  wrapperCli?: string;
  workingDir?: string;
  /**
   * 新话题工作目录模式：'fixed' → 落 defaultWorkingDir（直接启动、不弹卡片）；
   * 'card' → 落 workingDir（仓库选择卡片的扫描根）。缺省按 'card' 处理——
   * 老前端 / 脚本不带该字段时行为不变；新 Web 表单默认发 'fixed'（推荐）。
   */
  dirMode?: 'fixed' | 'card';
  model?: string;
}

type RegisterAppFn = (opts?: RegisterAppOptions) => Promise<RegisterAppResult>;
type ValidateCredentialsFn = (
  appId: string,
  appSecret: string,
  brand?: 'feishu' | 'lark',
) => Promise<CredentialValidation | { ok: true }>;
type AutomateOpenPlatformFn = (opts: OpenPlatformAutomationOptions) => Promise<OpenPlatformAutomationResult>;

export interface BotOnboardingManagerOptions {
  botsJsonPath: string;
  registerApp?: RegisterAppFn;
  validateCredentials?: ValidateCredentialsFn;
  automateOpenPlatform?: AutomateOpenPlatformFn;
  renderQrDataUrl?: (url: string) => string;
  now?: () => number;
  /**
   * Bring the just-persisted bot online without a fleet-wide restart. Wired in
   * the dashboard to spawn `botmux start-bot <appId>`: the new daemon
   * self-registers, opens its Feishu WSClient long-connection, and publishes a
   * descriptor the dashboard auto-discovers — so a newly added bot works with no
   * `botmux restart`. Best-effort: a rejection/`ok:false` just falls back to the
   * restart hint. Omitted in tests → onboarding behaves as before (persist only,
   * `liveStarted` stays undefined).
   */
  startBotLive?: (appId: string) => Promise<{ ok: boolean; message?: string }>;
}

export interface BotOnboardingJob {
  id: string;
  done: Promise<void>;
}

function svgEscape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export function renderQrSvgDataUrl(value: string): string {
  const qrcode = new QRCode(-1, QRErrorCorrectLevel.L);
  qrcode.addData(value);
  qrcode.make();

  const moduleCount = qrcode.getModuleCount();
  const quiet = 4;
  const size = moduleCount + quiet * 2;
  const rects: string[] = [];
  for (let row = 0; row < moduleCount; row++) {
    for (let col = 0; col < moduleCount; col++) {
      if (qrcode.modules[row][col]) {
        rects.push(`<rect x="${col + quiet}" y="${row + quiet}" width="1" height="1"/>`);
      }
    }
  }
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code">`,
    `<title>${svgEscape(value)}</title>`,
    `<rect width="${size}" height="${size}" fill="#fff"/>`,
    `<g fill="#111">${rects.join('')}</g>`,
    '</svg>',
  ].join('');
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
}

export class BotOnboardingManager {
  private readonly jobs = new Map<string, BotOnboardingSnapshot>();
  // needs_owner 状态下「待落盘」的 bot 配置（含 secret）——故意不写进 bots.json,
  // 避免在 owner 确认前就有一个空 allowlist 的可启动 bot 留在磁盘上（重启即 fail-open）。
  // 也不放进 jobs 快照（那个会序列化给前端、会泄漏 secret）。owner 校验通过后才 append。
  private readonly pendingBots = new Map<string, Record<string, any>>();
  private readonly registerApp: RegisterAppFn;
  private readonly validateCredentials: ValidateCredentialsFn;
  private readonly automateOpenPlatform: AutomateOpenPlatformFn;
  private readonly renderQrDataUrl: (url: string) => string;
  private readonly now: () => number;
  private readonly startBotLive?: (appId: string) => Promise<{ ok: boolean; message?: string }>;

  constructor(private readonly opts: BotOnboardingManagerOptions) {
    this.registerApp = opts.registerApp ?? tryRegisterApp;
    this.validateCredentials = opts.validateCredentials ?? validateCredentials;
    this.automateOpenPlatform = opts.automateOpenPlatform ?? automateOpenPlatformSetup;
    this.renderQrDataUrl = opts.renderQrDataUrl ?? renderQrSvgDataUrl;
    this.now = opts.now ?? (() => Date.now());
    this.startBotLive = opts.startBotLive;
  }

  /**
   * Best-effort auto-start of the just-persisted bot's daemon (no fleet restart).
   * Records the outcome on the job snapshot so the frontend shows "已自动上线"
   * instead of the restart hint. Never throws.
   */
  private async runLiveStart(id: string, appId: string): Promise<void> {
    if (!this.startBotLive) return;
    try {
      const r = await this.startBotLive(appId);
      this.patch(id, { liveStarted: r.ok, liveStartMessage: r.message });
    } catch (err) {
      this.patch(id, { liveStarted: false, liveStartMessage: err instanceof Error ? err.message : String(err) });
    }
  }

  start(input: BotOnboardingInput = {}): BotOnboardingJob {
    const id = `bot_${Math.random().toString(36).slice(2)}_${this.now().toString(36)}`;
    const createdAt = this.now();
    this.jobs.set(id, { id, status: 'starting', createdAt, updatedAt: createdAt });
    const done = this.run(id, input).catch(err => {
      this.patch(id, {
        status: 'failed',
        error: 'unexpected_error',
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return { id, done };
  }

  get(id: string): BotOnboardingSnapshot | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  private patch(id: string, patch: Partial<BotOnboardingSnapshot>): void {
    const current = this.jobs.get(id);
    if (!current) return;
    this.jobs.set(id, { ...current, ...patch, updatedAt: this.now() });
  }

  private async run(id: string, input: BotOnboardingInput = {}): Promise<void> {
    const result = await this.registerApp({
      onQRCodeReady: info => {
        this.patch(id, {
          status: 'waiting_for_scan',
          qrUrl: info.url,
          qrDataUrl: this.renderQrDataUrl(info.url),
          expireAt: this.now() + info.expireIn * 1000,
        });
      },
      onStatusChange: info => {
        if (info.status === 'slow_down') this.patch(id, { message: 'slow_down' });
        if (info.status === 'domain_switched') this.patch(id, { message: 'domain_switched' });
      },
    });

    if (!result.ok) {
      this.patch(id, { status: 'failed', error: result.error, message: result.message });
      return;
    }
    // brand (feishu / lark) 由扫码 tenant_brand 自动识别后落盘；daemon 链路
    // 全程从 BotConfig.brand 派生域名，feishu / lark 都能直接跑。
    this.patch(id, { status: 'verifying', appId: result.appId, brand: result.brand });
    const validation = await this.validateCredentials(result.appId, result.appSecret, result.brand);
    if (!validation.ok) {
      this.patch(id, {
        status: 'failed',
        error: 'credential_validation_failed',
        message: 'message' in validation ? validation.message : 'credential validation failed',
      });
      return;
    }

    const bots = readBotsJsonOrEmpty(this.opts.botsJsonPath);
    if (bots.some((bot: any) => bot?.larkAppId === result.appId)) {
      this.patch(id, { status: 'failed', error: 'duplicate_app', message: 'App ID already exists in bots.json' });
      return;
    }

    // CLI / 工作目录 / model 来自前端表单 (dashboard 已用 resolveCliId +
    // invalidWorkingDirs 校验过). 留空回退到 setup 同款默认: claude-code / '~'.
    const cliId: CliId = input.cliId ?? 'claude-code';
    const workingDir = input.workingDir?.trim() || '~';
    const bot: Record<string, any> = {
      larkAppId: result.appId,
      larkAppSecret: result.appSecret,
      cliId,
      // aiden × claude/codex 等启动前缀；普通 CLI 不写此字段。
      ...(input.wrapperCli ? { wrapperCli: input.wrapperCli } : {}),
      // 'fixed' → defaultWorkingDir（新话题直接启动、不弹卡片，扫描根回退 ~）；
      // 'card'/缺省 → workingDir（仓库选择卡片扫描根，兼容旧调用方语义）。
      ...(input.dirMode === 'fixed' ? { defaultWorkingDir: workingDir } : { workingDir }),
    };
    if (input.model && input.model.trim()) bot.model = input.model.trim();
    // brand 落盘：只在国际版写字段，feishu 留空（向后兼容，见 normalizeBrand）。
    if (result.brand === 'lark') {
      bot.brand = 'lark';
    }
    // 注意：此处 **不** 立刻把 bot 写进 bots.json。空 allowedUsers 的 bot 一旦落盘,
    // 就是一个「可被 botmux start/restart 读取、运行时按无白名单全开放」的 fail-open
    // 隐患（哪怕没出 restart hint, 关弹窗 / 重启 / pm2 重启都会以开放模式起）。
    // 只有「能确认 owner」时才落盘——见下方两条路径。

    // 跑 setup 同款开放平台自动配置 (导入权限 / 配 redirect / 建并发版)。
    const auto = await this.runPermissionAutomation(id, result.appId, result.brand, { cliId, workingDir });

    // 关键顺序：先确认 owner, 再决定是否落盘 + 终态。completed 必须意味着「bots.json
    // 里这个 bot 带着至少一个 owner」, 绝不产出空 allowedUsers 的可启动 bot。
    let ownerEntry: string | undefined;
    if (result.userOpenId) {
      // registerApp 返回的 open_id 来自扫码链路; 用新 app 自身凭证验证, 失败不
      // fallback 写入该 (常为跨 app 的) ou_——避免把其他 app 视角的 open_id 固化
      // 成 owner, 导致 /grant 和授权卡片一直判 non-owner。
      ownerEntry = await resolveScannerAllowedUser(result.appId, result.appSecret, result.userOpenId, result.brand);
    }

    if (ownerEntry) {
      const addedBotIndex = this.persistBot({ ...bot, allowedUsers: [ownerEntry] });
      await this.runLiveStart(id, result.appId);
      this.finalizePermissions(id, result.appId, result.brand, addedBotIndex, auto, 'completed');
    } else {
      // owner 没法自动确认：bot 先不落盘, 暂存内存等用户手动填 owner 校验通过后再写。
      this.pendingBots.set(id, bot);
      this.finalizePermissions(id, result.appId, result.brand, undefined, auto, 'needs_owner');
    }
  }

  /** 把 bot append/更新进 bots.json（按 larkAppId upsert, 幂等），返回它的行号。 */
  private persistBot(bot: Record<string, any>): number {
    const bots = readBotsJsonOrEmpty(this.opts.botsJsonPath);
    const normalized = normalizeBotConfig(bot);
    const existing = bots.findIndex((b: any) => b?.larkAppId === bot.larkAppId);
    if (existing >= 0) {
      const next = [...bots];
      next[existing] = normalized;
      writeBotsJsonAtomic(this.opts.botsJsonPath, next);
      return existing;
    }
    const index = bots.length;
    writeBotsJsonAtomic(this.opts.botsJsonPath, [...bots, normalized]);
    return index;
  }

  /**
   * 用户在 needs_owner 状态下手动提交 owner。先做格式校验, 再用新 app 凭证 best-effort
   * 校验「填的身份在本应用里是否可用」：只对能确凿判定的错误 (跨 app 的 ou_ / 不在本
   * 企业的邮箱) 拒绝；scope 未生效 / 权限不足 / 网络错误等无法证伪的情况不拦截, 避免把
   * 用户永久卡在 needs_owner。校验通过才落盘 allowedUsers 并进入 completed。
   */
  async submitOwner(id: string, rawEntries: string[]): Promise<{ ok: boolean; error?: string; message?: string }> {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: 'unknown_onboarding_job' };
    if (job.status !== 'needs_owner') return { ok: false, error: 'not_awaiting_owner' };
    const pending = this.pendingBots.get(id);
    if (!pending) return { ok: false, error: 'missing_app' };

    const entries = rawEntries.map(e => e.trim()).filter(Boolean);
    const invalid = findInvalidAllowedUserEntries(entries);
    if (invalid.length > 0) {
      return { ok: false, error: 'invalid_entries', message: `不是完整邮箱、union_id(on_) 或 open_id(ou_)：${invalid.join(', ')}` };
    }
    if (!hasOwnerEntry(entries)) {
      return { ok: false, error: 'no_owner', message: '至少需要一个完整邮箱、union_id(on_) 或 open_id(ou_) 作为 owner。' };
    }

    const appId = typeof pending.larkAppId === 'string' ? pending.larkAppId : '';
    const appSecret = typeof pending.larkAppSecret === 'string' ? pending.larkAppSecret : '';
    const brand: Brand = job.brand ?? 'feishu';

    const unusable = await detectUnusableOwnerEntries(appId, appSecret, brand, entries);
    if (unusable.length > 0) {
      return {
        ok: false,
        error: 'unusable_owner',
        message: `以下身份在当前应用里无法解析（可能是其他应用的 open_id，或邮箱不在本企业）：${unusable.join(', ')}。请改用本企业邮箱或 union_id(on_)。`,
      };
    }

    // 校验通过才落盘：此刻 bot 第一次进入 bots.json, 且带着非空 allowedUsers。
    const addedBotIndex = this.persistBot({ ...pending, allowedUsers: entries });
    this.pendingBots.delete(id);
    await this.runLiveStart(id, appId);
    this.patch(id, { status: 'completed', addedBotIndex });
    return { ok: true };
  }

  /**
   * 跑开放平台权限自动配置 (复用 setup 的 automateOpenPlatformSetup)。只负责把进度
   * 推给前端 (configuring_permissions / waiting_for_platform_scan) 并返回结果——终态
   * 由调用方在 owner 落盘后统一决定 (见 finalizePermissions)。
   */
  private async runPermissionAutomation(
    id: string,
    appId: string,
    brand: 'feishu' | 'lark',
    meta: { cliId: string; workingDir: string },
  ): Promise<OpenPlatformAutomationResult> {
    this.patch(id, {
      status: 'configuring_permissions',
      appId,
      cliId: meta.cliId,
      workingDir: meta.workingDir,
    });

    try {
      return await this.automateOpenPlatform({
        appId,
        brand,
        onQrCode: info => {
          this.patch(id, {
            status: 'waiting_for_platform_scan',
            platformQrDataUrl: this.renderQrDataUrl(info.qrPayload),
          });
        },
        onStatus: msg => {
          // 只更新进度文案, 不动 status——onStatus 在 onQrCode 之后的轮询里就会
          // 触发 ('等待飞书扫码'), 若把 status 拨回 configuring_permissions 会瞬间
          // 把刚弹出的第二个二维码 (waiting_for_platform_scan) 盖掉.
          this.patch(id, { permissionStatusMsg: msg });
        },
      });
    } catch (err) {
      // automation 不应抛 (内部已结构化返回), 兜底当作失败 → 手动步骤.
      return {
        ok: false,
        reason: 'api_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * 统一落终态：completed (已落盘 + 有 owner) 或 needs_owner (尚未落盘、待用户手动填)。
   * needs_owner 时 addedBotIndex 为 undefined——bot 还没进 bots.json, 没有行号。
   */
  private finalizePermissions(
    id: string,
    appId: string,
    brand: 'feishu' | 'lark',
    addedBotIndex: number | undefined,
    auto: OpenPlatformAutomationResult,
    status: 'completed' | 'needs_owner',
  ): void {
    const permission: BotOnboardingPermission = auto.ok
      ? {
          ok: true,
          scopeCount: auto.scopeCount,
          skippedScopeCount: auto.skippedScopeCount,
          versionId: auto.versionId,
          scopeWarning: auto.scopeWarning,
        }
      : { ok: false, reason: auto.reason, message: auto.message };
    this.patch(id, {
      status,
      ...(addedBotIndex !== undefined ? { addedBotIndex } : {}),
      platformQrDataUrl: undefined,
      permission,
      ...(auto.ok ? {} : { remainingSteps: buildRemainingSteps(appId, brand) }),
    });
  }
}

/**
 * 用新应用自身凭证验证扫码链路拿到的 open_id。
 * 能解析 union_id 时写 on_；没有 union_id 但 open_id 对当前 app 有效时写 ou_。
 * 查询失败或用户不在当前 app 视角时返回 undefined，调用方不得 fallback 写入该 ou_。
 */
async function resolveScannerAllowedUser(appId: string, appSecret: string, openId: string, brand: Brand = 'feishu'): Promise<string | undefined> {
  try {
    const client = new Lark.Client({ appId, appSecret, domain: sdkDomain(brand), disableTokenCache: false });
    const res = await (client as any).contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });
    if (res.code === 0 && res.data?.user) {
      return res.data.user.union_id ?? openId;
    }
  } catch { /* do not trust scanner open_id when verification fails */ }
  return undefined;
}

// 跨 app open_id 的固定错误码：用本 app 凭证查别的 app 视角的 ou_ 必返这个。
const CROSS_APP_OPEN_ID_CODE = 99992361;

/**
 * best-effort 找出「确凿不可用」的 owner 条目, 供 submitOwner 拒绝。只在能明确判定时
 * 才判不可用——避免 scope 未生效 / 权限不足 / 网络错误时把合法条目误杀:
 *   - ou_：本 app 查到跨 app 错误码 (99992361) → 不可用 (典型误填别的 app 的 open_id)。
 *   - 邮箱：batchGetId 成功返回但该邮箱没有对应 user → 不可用 (不在本企业)。
 *   - on_：union_id 无法构造确凿的「不属于本 app」信号, 一律放行 (留给运行时解析)。
 * 任何抛错 / 非确定性响应都视为「无法证伪」→ 不计入 unusable。
 */
async function detectUnusableOwnerEntries(
  appId: string,
  appSecret: string,
  brand: Brand,
  entries: string[],
): Promise<string[]> {
  if (!appSecret) return [];
  let client: any;
  try {
    client = new Lark.Client({ appId, appSecret, domain: sdkDomain(brand), disableTokenCache: false });
  } catch {
    return [];
  }
  const unusable: string[] = [];
  for (const entry of entries) {
    try {
      if (entry.startsWith('ou_')) {
        const res = await client.contact.v3.user.get({
          path: { user_id: entry },
          params: { user_id_type: 'open_id' },
        });
        if (res?.code === CROSS_APP_OPEN_ID_CODE) unusable.push(entry);
      } else if (entry.startsWith('on_')) {
        // union_id：无确凿的跨 app 否定信号, 放行。
        continue;
      } else {
        const res = await client.contact.v3.user.batchGetId({
          params: { user_id_type: 'open_id' },
          data: { emails: [entry], include_resigned: false },
        });
        // 单封邮箱查询：成功响应里没有任何带 user_id 的条目 → 确凿不在本企业。
        // 用「是否存在 user_id」而非「邮箱精确匹配」判定, 避开 API 侧邮箱规范化误杀。
        if (res?.code === 0) {
          const list: any[] = res.data?.user_list ?? [];
          if (!list.some(u => u?.user_id)) unusable.push(entry);
        }
      }
    } catch { /* 无法证伪：不计入 unusable */ }
  }
  return unusable;
}
