import { registerApp } from '@larksuiteoapi/node-sdk';
import qrcode from 'qrcode-terminal';

type SdkOptions = Parameters<typeof registerApp>[0];

export type RegisterBrand = 'feishu' | 'lark';

export type RegisterAppOk = {
  ok: true;
  appId: string;
  appSecret: string;
  brand: RegisterBrand;
  /**
   * 扫码人的 open_id（飞书 device flow `request_user_info=open_id tenant_brand`
   * 字段返回）。它只是 owner candidate：必须由目标应用验证并尽量转换为
   * union_id 后才能持久化，验证失败不得把这个 open_id fallback 写入
   * `allowedUsers`。没拿到时为 undefined（理论上不会，但接口可能改）。
   */
  userOpenId?: string;
};

export type RegisterAppErr = {
  ok: false;
  /**
   * - `aborted`: 用户 Ctrl-C / 主动取消
   * - `expired`: 二维码过期 (默认 10 分钟)
   * - `denied`: 用户在浏览器里拒绝
   * - `network`: 网络错误 / 端点不可达
   * - `unknown`: 其它 (含 SDK 抛非预期错误)
   */
  error: 'aborted' | 'expired' | 'denied' | 'network' | 'unconfirmed' | 'unknown';
  /** 给用户看的简短错误描述, 不含 secret. */
  message: string;
};

export type RegisterAppResult = RegisterAppOk | RegisterAppErr;

export interface RegisterAppOptions {
  addons?: SdkOptions['addons'];
  appPreset?: SdkOptions['appPreset'];
  appId?: string;
  /** 兼容模式只显示确认链接。 */
  linkOnly?: boolean;
  /** 取消信号 (Ctrl-C 时填充). */
  signal?: AbortSignal;
  /**
   * 渲染前回调, 测试时可注入静默打印. 默认在 stdout 打印二维码 + 链接.
   */
  onQRCodeReady?: (info: { url: string; expireIn: number }) => void;
  /** 状态变更回调, 主要用于"已切换到 Lark 域名"提示. */
  onStatusChange?: (info: { status: string; interval?: number }) => void;
}

function printRegistrationLink(info: { url: string; expireIn: number }, linkOnly: boolean): void {
  const mins = Math.max(1, Math.round(info.expireIn / 60));
  process.stderr.write(`\n请打开飞书应用确认链接（约 ${mins} 分钟内有效）：\n  ${info.url}\n\n`);
  // 二维码太密时，终端换行会使它无法扫描。此时保留上面的完整链接。
  if (!linkOnly && info.url.length <= 450) {
    qrcode.generate(info.url, { small: true }, qr => process.stderr.write(qr + '\n'));
  }
}

function defaultPrintStatus(info: { status: string; interval?: number }): void {
  if (info.status === 'domain_switched') {
    process.stderr.write('识别到国际版租户, 已切换到 larksuite.com 域名继续轮询。\n');
  } else if (info.status === 'slow_down' && info.interval) {
    process.stderr.write(`轮询过快, 间隔自动调整到 ${info.interval}s。\n`);
  }
}

/**
 * 尝试扫码建应用. 任何失败都返回 RegisterAppErr (不抛), 调用方可以回退手动粘.
 *
 * Secret 安全约束:
 * - SDK 返回的 client_secret 只放进返回值, 不打印, 不写日志
 * - 错误链里只放错误 code / 阶段, 不带 secret
 */
export async function tryRegisterApp(opts: RegisterAppOptions = {}): Promise<RegisterAppResult> {
  const onQR = opts.onQRCodeReady ?? (info => printRegistrationLink(info, opts.linkOnly === true));
  const onStatus = opts.onStatusChange ?? defaultPrintStatus;

  let switchedToLark = false;
  let linkShown = false;
  try {
    const result = await registerApp({
      signal: opts.signal,
      source: 'botmux',
      addons: opts.addons,
      appPreset: opts.appPreset,
      ...(opts.appId ? { appId: opts.appId } : { createOnly: true }),
      onQRCodeReady: info => {
        onQR(info);
        linkShown = true;
      },
      onStatusChange: info => {
        if (info.status === 'domain_switched') switchedToLark = true;
        onStatus(info);
      },
    });

    if (!result.client_id || !result.client_secret) {
      return {
        ok: false,
        error: 'unknown',
        message: 'SDK 返回的 client_id/client_secret 为空',
      };
    }

    if (opts.appId && result.client_id !== opts.appId) {
      return { ok: false, error: 'unknown', message: '确认结果的 App ID 与请求更新的应用不一致' };
    }
    const brand: RegisterBrand = switchedToLark || result.user_info?.tenant_brand === 'lark' ? 'lark' : 'feishu';
    const userOpenId =
      typeof result.user_info?.open_id === 'string' && result.user_info.open_id.startsWith('ou_')
        ? result.user_info.open_id
        : undefined;

    return {
      ok: true,
      appId: result.client_id,
      appSecret: result.client_secret,
      brand,
      userOpenId,
    };
  } catch (err: unknown) {
    const failure = err as { code?: string; message?: string } | undefined;
    if (failure?.code === 'abort') return { ok: false, error: 'aborted', message: '用户取消确认' };
    if (failure?.code === 'expired_token') return { ok: false, error: 'expired', message: '确认链接已过期，请重试' };
    if (failure?.code === 'access_denied') return { ok: false, error: 'denied', message: '用户在浏览器里拒绝授权' };
    if (linkShown) {
      return {
        ok: false,
        error: 'unconfirmed',
        message: '确认链接已发出，飞书未返回最终结果。请先到开放平台检查应用是否已创建或已更新。',
      };
    }
    if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|ECONNRESET|EAI_AGAIN|network/i.test(
      `${failure?.code ?? ''} ${failure?.message ?? ''}`,
    )) {
      return { ok: false, error: 'network', message: '飞书注册接口网络错误' };
    }
    return { ok: false, error: 'unknown', message: '飞书注册接口返回异常' };
  }
}
