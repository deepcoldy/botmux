import { simpleCard, urlButton } from './card-primitives.js';

export interface TrustedResultDeliveryCardOptions {
  accessUrl: string;
  expiresAt: string;
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
  return JSON.stringify(simpleCard({
    title: '结果已生成',
    template: 'blue',
    div: `结果仅限本次请求的发起人查看。入口有效期至 ${expires.toLocaleString('zh-CN', { hour12: false })}。`,
    buttons: [urlButton('查看或下载', 'primary', {
      url: opts.accessUrl,
      pc_url: opts.accessUrl,
      android_url: opts.accessUrl,
      ios_url: opts.accessUrl,
    })],
  }));
}
