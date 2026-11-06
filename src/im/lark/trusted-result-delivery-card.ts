import { simpleCard, urlButton } from './card-primitives.js';
import { appCenterAppLink, type Brand } from './lark-hosts.js';

export interface TrustedResultDeliveryCardOptions {
  accessUrl: string;
  expiresAt: string;
  brand: Brand;
}

/** Metadata-only entry card. Result text, filenames, counts and internal
 * handles deliberately never enter the Lark message body. */
export function buildTrustedResultDeliveryCard(
  opts: TrustedResultDeliveryCardOptions,
): string {
  const expires = new Date(opts.expiresAt);
  if (!/^https?:\/\//.test(opts.accessUrl) || !Number.isFinite(expires.getTime())) {
    throw new Error('invalid_plugin_result_entry');
  }
  const desktopUrl = appCenterAppLink(opts.accessUrl, opts.brand);
  return JSON.stringify(simpleCard({
    title: '结果已生成',
    template: 'blue',
    div: `结果仅限本次请求的发起人查看。入口有效期至 ${expires.toLocaleString('zh-CN', { hour12: false })}。`,
    buttons: [urlButton('查看或下载', 'primary', {
      url: desktopUrl,
      pc_url: desktopUrl,
      android_url: opts.accessUrl,
      ios_url: opts.accessUrl,
    })],
  }));
}
