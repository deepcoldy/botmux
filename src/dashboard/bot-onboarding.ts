import { createRequire } from 'node:module';
import { readBotsJsonOrEmpty, writeBotsJsonAtomic } from '../setup/bots-store.js';
import { normalizeBotConfig } from '../setup/bot-config-editor.js';
import { tryRegisterApp, type RegisterAppOptions, type RegisterAppResult } from '../setup/register-app.js';
import { validateCredentials, type CredentialValidation } from '../setup/verify-permissions.js';
import * as Lark from '@larksuiteoapi/node-sdk';

const require = createRequire(import.meta.url);
const QRCode = require('qrcode-terminal/vendor/QRCode') as any;
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as Record<string, unknown>;

export type BotOnboardingStatus =
  | 'starting'
  | 'waiting_for_scan'
  | 'verifying'
  | 'completed'
  | 'failed';

export interface BotOnboardingSnapshot {
  id: string;
  status: BotOnboardingStatus;
  createdAt: number;
  updatedAt: number;
  qrUrl?: string;
  qrDataUrl?: string;
  expireAt?: number;
  appId?: string;
  brand?: 'feishu' | 'lark';
  addedBotIndex?: number;
  error?: string;
  message?: string;
}

type RegisterAppFn = (opts?: RegisterAppOptions) => Promise<RegisterAppResult>;
type ValidateCredentialsFn = (
  appId: string,
  appSecret: string,
  brand?: 'feishu' | 'lark',
) => Promise<CredentialValidation | { ok: true }>;

export interface BotOnboardingManagerOptions {
  botsJsonPath: string;
  registerApp?: RegisterAppFn;
  validateCredentials?: ValidateCredentialsFn;
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
  private readonly renderQrDataUrl: (url: string) => string;
  private readonly now: () => number;

  constructor(private readonly opts: BotOnboardingManagerOptions) {
    this.registerApp = opts.registerApp ?? tryRegisterApp;
    this.validateCredentials = opts.validateCredentials ?? validateCredentials;
    this.renderQrDataUrl = opts.renderQrDataUrl ?? renderQrSvgDataUrl;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): BotOnboardingJob {
    const id = `bot_${Math.random().toString(36).slice(2)}_${this.now().toString(36)}`;
    const createdAt = this.now();
    this.jobs.set(id, { id, status: 'starting', createdAt, updatedAt: createdAt });
    const done = this.run(id).catch(err => {
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

  private async run(id: string): Promise<void> {
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
    if (result.brand === 'lark') {
      this.patch(id, {
        status: 'failed',
        appId: result.appId,
        brand: result.brand,
        error: 'lark_unsupported',
        message: 'botmux 当前 daemon 运行链路仅支持飞书 (feishu.cn) 租户',
      });
      return;
    }

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

    const bot: Record<string, any> = {
      larkAppId: result.appId,
      larkAppSecret: result.appSecret,
      cliId: 'claude-code',
      workingDir: '~',
    };
    if (result.userOpenId) {
      // 优先存 union_id（on_，跨应用稳定），避免 open_id 在其他 bot 下报 cross-app 错误。
      // 用刚注册的应用自身凭证查询；若查询失败（无 contact 权限）则 fallback 到 open_id。
      bot.allowedUsers = [await resolveToUnionId(result.appId, result.appSecret, result.userOpenId)];
    }
    writeBotsJsonAtomic(this.opts.botsJsonPath, [...bots, normalizeBotConfig(bot)]);
    this.patch(id, { status: 'completed', addedBotIndex: bots.length });
  }
}

/**
 * 用指定应用的凭证把 open_id (ou_) 解析成 union_id (on_)。
 * union_id 跨应用稳定，适合写入 allowedUsers 供多个 bot 共用。
 * 若查询失败（无 contact 权限 / API 错误）则 fallback 返回原 open_id。
 */
async function resolveToUnionId(appId: string, appSecret: string, openId: string): Promise<string> {
  try {
    const client = new Lark.Client({ appId, appSecret, disableTokenCache: false });
    const res = await (client as any).contact.v3.user.get({
      path: { user_id: openId },
      params: { user_id_type: 'open_id' },
    });
    if (res.code === 0 && res.data?.user?.union_id) return res.data.user.union_id as string;
  } catch { /* fallback */ }
  return openId;
}
