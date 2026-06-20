import { createRequire } from 'node:module';
import { readBotsJsonOrEmpty, writeBotsJsonAtomic } from '../setup/bots-store.js';
import { normalizeBotConfig } from '../setup/bot-config-editor.js';
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
  private readonly registerApp: RegisterAppFn;
  private readonly validateCredentials: ValidateCredentialsFn;
  private readonly automateOpenPlatform: AutomateOpenPlatformFn;
  private readonly renderQrDataUrl: (url: string) => string;
  private readonly now: () => number;

  constructor(private readonly opts: BotOnboardingManagerOptions) {
    this.registerApp = opts.registerApp ?? tryRegisterApp;
    this.validateCredentials = opts.validateCredentials ?? validateCredentials;
    this.automateOpenPlatform = opts.automateOpenPlatform ?? automateOpenPlatformSetup;
    this.renderQrDataUrl = opts.renderQrDataUrl ?? renderQrSvgDataUrl;
    this.now = opts.now ?? (() => Date.now());
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
      workingDir,
    };
    if (input.model && input.model.trim()) bot.model = input.model.trim();
    // brand 落盘：只在国际版写字段，feishu 留空（向后兼容，见 normalizeBrand）。
    if (result.brand === 'lark') {
      bot.brand = 'lark';
    }
    if (result.userOpenId) {
      // 优先存 union_id（on_，跨应用稳定），避免 open_id 在其他 bot 下报 cross-app 错误。
      // 用刚注册的应用自身凭证查询；若查询失败（无 contact 权限）则 fallback 到 open_id。
      bot.allowedUsers = [await resolveToUnionId(result.appId, result.appSecret, result.userOpenId, result.brand)];
    }
    const addedBotIndex = bots.length;
    writeBotsJsonAtomic(this.opts.botsJsonPath, [...bots, normalizeBotConfig(bot)]);

    // bots.json 已落盘——bot 本身已添加. 接下来跑 setup 同款开放平台自动配置
    // (导入权限 / 配 redirect / 建并发版). 这一步失败不回滚 bot, 只降级到
    // 手动权限步骤提示——和 `botmux setup` 的 finishOpenPlatformSetup 行为一致.
    await this.configurePermissions(id, result.appId, result.brand, { cliId, workingDir, addedBotIndex });
  }

  /**
   * 跑开放平台权限自动配置. 复用 setup 的 automateOpenPlatformSetup:
   * - 缓存命中 (~/.botmux/feishu-session.json 有效) → 静默自动配置, 不出二维码
   * - 否则 → 通过 onQrCode 抛出第二个二维码 (登录开放平台), 前端渲染让用户扫
   * - 成功 → completed + 权限摘要; 失败 → completed + 手动步骤 (buildRemainingSteps)
   *
   * 无论自动配置成败, bot 都已写入 bots.json, 所以终态恒为 'completed'.
   */
  private async configurePermissions(
    id: string,
    appId: string,
    brand: 'feishu' | 'lark',
    meta: { cliId: string; workingDir: string; addedBotIndex: number },
  ): Promise<void> {
    this.patch(id, {
      status: 'configuring_permissions',
      appId,
      cliId: meta.cliId,
      workingDir: meta.workingDir,
    });

    let auto: OpenPlatformAutomationResult;
    try {
      auto = await this.automateOpenPlatform({
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
      auto = {
        ok: false,
        reason: 'api_error',
        message: err instanceof Error ? err.message : String(err),
      };
    }

    if (auto.ok) {
      this.patch(id, {
        status: 'completed',
        addedBotIndex: meta.addedBotIndex,
        platformQrDataUrl: undefined,
        permission: {
          ok: true,
          scopeCount: auto.scopeCount,
          skippedScopeCount: auto.skippedScopeCount,
          versionId: auto.versionId,
          scopeWarning: auto.scopeWarning,
        },
      });
      return;
    }

    // 自动配置失败: bot 已添加, 给手动权限步骤 (与 setup 失败回退一致).
    this.patch(id, {
      status: 'completed',
      addedBotIndex: meta.addedBotIndex,
      platformQrDataUrl: undefined,
      permission: { ok: false, reason: auto.reason, message: auto.message },
      remainingSteps: buildRemainingSteps(appId, brand),
    });
  }
}

/**
 * 用指定应用的凭证把 open_id (ou_) 解析成 union_id (on_)。
 * union_id 跨应用稳定，适合写入 allowedUsers 供多个 bot 共用。
 * 若查询失败（无 contact 权限 / API 错误）则 fallback 返回原 open_id。
 */
async function resolveToUnionId(appId: string, appSecret: string, openId: string, brand: Brand = 'feishu'): Promise<string> {
  try {
    const client = new Lark.Client({ appId, appSecret, domain: sdkDomain(brand), disableTokenCache: false });
    const res = await (client as any).contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });
    if (res.code === 0 && res.data?.user?.union_id) return res.data.user.union_id as string;
  } catch { /* fallback */ }
  return openId;
}
