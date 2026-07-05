/**
 * 飞书 Web 登录态刷新 —— dashboard 侧的「扫码授权」入口，与 `botmux setup` 复用
 * 同一份登录态（`~/.botmux/feishu-session.json`）。
 *
 * 背景：机器人改名走开放平台自动化（services/open-platform-rename.ts），需要一份
 * 有效的飞书 Web 登录态；缺失/过期时改名降级为仅改 dashboard 展示名并提示
 * 「请在服务器运行 botmux setup 重新扫码」。本 manager 把那次扫码搬进 dashboard：
 * 用户点「扫码登录」→ 后台起 {@link prepareFeishuWebSession}（与 setup、bot
 * onboarding 第二个二维码同一个飞书 Web QR 登录流程）→ onQrCode 渲染二维码给前端
 * 轮询展示 → 扫码成功即写回 feishu-session.json，之后改名直接走真·改名路径。
 *
 * 进程边界（重要前提）：当前部署模型下 dashboard 与所有 daemon **同机**
 * （proxyToDaemon 走 127.0.0.1），feishu-session.json 是机器级共享文件——
 * dashboard 进程写、任何 daemon 改名读，无需 per-bot / 跨机协调。因此本 manager
 * 是**机器级单例**（不按 bot 区分），与 {@link BotOnboardingManager} 同进程、
 * 同二维码渲染基础设施。⚠️ 若将来把 dashboard 与 daemon 拆到不同机器，这条
 * 「同机共享文件」假设即失效：改名 daemon 读不到 dashboard 那台写的 session，
 * 届时需把 session jar 下发到目标机、或把登录 manager 下沉到 daemon 侧
 * （proxyToDaemon 到具体 bot 的 daemon 执行登录，写它自己机器的 session）。
 */
import {
  prepareFeishuWebSession,
  type FeishuWebSessionOptions,
  type FeishuWebSessionPrepareResult,
} from '../setup/open-platform-automation.js';
import { renderQrSvgDataUrl } from './bot-onboarding.js';
import { logger } from '../utils/logger.js';

export type FeishuLoginStatus = 'starting' | 'awaiting_scan' | 'success' | 'failed';

export interface FeishuLoginSnapshot {
  status: FeishuLoginStatus;
  /** 二维码 SVG data URL（awaiting_scan 时有）。 */
  qrDataUrl?: string;
  /** 二维码大致有效期（now + maxWaitMs），供前端提示/倒计时。 */
  expireAt?: number;
  /** 轮询进度文案（onStatus：等待扫码 / 已扫码待确认 / 已过期）。 */
  message?: string;
  /** 失败原因码（qr_expired / timeout / network / login_failed / …）。 */
  reason?: string;
  /** 成功时的 cookie 数与来源（cache / qr_login / bytedcli_fallback）。 */
  cookieCount?: number;
  source?: string;
  updatedAt: number;
}

export interface FeishuLoginManagerOptions {
  /** 注入缝：默认 {@link prepareFeishuWebSession}。 */
  prepareSession?: (opts: FeishuWebSessionOptions) => Promise<FeishuWebSessionPrepareResult>;
  /** 注入缝：payload → 二维码 data URL。默认 {@link renderQrSvgDataUrl}。 */
  renderQr?: (payload: string) => string;
  now?: () => number;
  /** 单次扫码等待上限（毫秒）。默认 180s。 */
  maxWaitMs?: number;
}

export class FeishuLoginManager {
  private snapshot: FeishuLoginSnapshot | null = null;
  private settled = true;
  private readonly prepareSession: (opts: FeishuWebSessionOptions) => Promise<FeishuWebSessionPrepareResult>;
  private readonly renderQr: (payload: string) => string;
  private readonly now: () => number;
  private readonly maxWaitMs: number;

  constructor(opts: FeishuLoginManagerOptions = {}) {
    this.prepareSession = opts.prepareSession ?? prepareFeishuWebSession;
    this.renderQr = opts.renderQr ?? renderQrSvgDataUrl;
    this.now = opts.now ?? (() => Date.now());
    this.maxWaitMs = opts.maxWaitMs ?? 180_000;
  }

  get(): FeishuLoginSnapshot | null {
    return this.snapshot ? { ...this.snapshot } : null;
  }

  /**
   * 发起（或复用）一次扫码登录。幂等：已有进行中的登录（starting/awaiting_scan）
   * 直接返回其快照，避免并发起多个二维码；已成功/失败则允许重新发起（换新码）。
   */
  start(): FeishuLoginSnapshot {
    if (!this.settled && this.snapshot
      && (this.snapshot.status === 'starting' || this.snapshot.status === 'awaiting_scan')) {
      return { ...this.snapshot };
    }
    this.settled = false;
    this.snapshot = { status: 'starting', updatedAt: this.now() };
    void this.run();
    return { ...this.snapshot };
  }

  private patch(p: Partial<FeishuLoginSnapshot>): void {
    this.snapshot = { ...(this.snapshot ?? { status: 'starting', updatedAt: 0 }), ...p, updatedAt: this.now() };
  }

  private async run(): Promise<void> {
    try {
      const result = await this.prepareSession({
        maxWaitMs: this.maxWaitMs,
        onQrCode: ({ qrPayload }) => {
          this.patch({
            status: 'awaiting_scan',
            qrDataUrl: this.renderQr(qrPayload),
            expireAt: this.now() + this.maxWaitMs,
          });
        },
        onStatus: (message) => { this.patch({ message }); },
      });
      if (result.ok) {
        this.patch({
          status: 'success',
          cookieCount: result.cookieCount,
          source: result.source,
          qrDataUrl: undefined,
          message: undefined,
          reason: undefined,
        });
        logger.info(`[feishu-login] session ready via ${result.source} (${result.cookieCount} cookies)`);
      } else {
        this.patch({ status: 'failed', reason: result.reason, message: result.message, qrDataUrl: undefined });
        logger.warn(`[feishu-login] failed: ${result.reason} — ${result.message}`);
      }
    } catch (err) {
      this.patch({
        status: 'failed',
        reason: 'unexpected',
        message: err instanceof Error ? err.message : String(err),
        qrDataUrl: undefined,
      });
    } finally {
      this.settled = true;
    }
  }
}
