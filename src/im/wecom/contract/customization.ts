/**
 * WeCom-side rules of the customization center that other layers apply: which
 * bundle may enter which store, and what a WeCom session's `botmux customize`
 * says instead of touching a store. Data and pure functions only — shared by the
 * Dashboard API (dashboard/customization-api.ts) and the CLI
 * (core/skills/customize-command.ts); no gateway process code.
 */
import type { CustomizationBundle } from '../../../skills/customization-bundle.js';
import type { CustomizationScope } from '../../../services/customization-scope.js';

/** Keys only the WeCom store knows (the gateway's own lines, contract/prompt-fragments.ts). */
export const WECOM_ONLY_KEY_PREFIX = 'wecom.';

/** What `botmux customize` prints, and exits non-zero with, inside a WeCom session. */
export const WECOM_SESSION_CUSTOMIZE_REFUSAL =
  '这是企业微信会话：企业微信的提示词在 Dashboard「自定义 → 企业微信」页管理。'
  + 'botmux customize 在这里不可用，不会读取或写入任何自定义。';

export const WECOM_BUNDLE_ON_FEISHU = '这是从「企业微信」页导出的 bundle，只能在「企业微信」页导入。';
export const NOT_A_WECOM_BUNDLE = '「企业微信」页只接受从「企业微信」页导出的 bundle（带 "scope": "wecom" 标记）。';

/**
 * The one rule for WeCom-only keys and the Feishu store: whether `key` may be
 * written there (set, forced, imported). Removing one stays possible — callers
 * apply this to writes of a value only. No such key existed before the WeCom
 * store did, so this refuses nothing the Feishu store ever accepted for real.
 */
export function feishuStoreKeyRejection(key: string): string | undefined {
  return key.startsWith(WECOM_ONLY_KEY_PREFIX)
    ? `${key} 是企业微信专属片段，只能在「企业微信」页设置或导入。`
    : undefined;
}

/**
 * Why `bundle` may not be imported into `scope`'s store, if it may not:
 * the WeCom store takes only a WeCom export (it carries `scope: "wecom"`); the
 * Feishu store refuses a WeCom export and any WeCom-only key. A bundle with
 * neither — every bundle that could exist before the WeCom store did — passes
 * for Feishu exactly as before.
 */
export function customizationBundleScopeRejection(bundle: CustomizationBundle, scope: CustomizationScope): string | undefined {
  if (scope === 'wecom') return bundle.scope === 'wecom' ? undefined : NOT_A_WECOM_BUNDLE;
  if (bundle.scope === 'wecom') return WECOM_BUNDLE_ON_FEISHU;
  const keys = [
    ...Object.values(bundle.promptOverrides ?? {}).flatMap(map => Object.keys(map ?? {})),
    ...Object.keys(bundle.conditionalLines ?? {}),
  ];
  for (const key of keys) {
    const rejection = feishuStoreKeyRejection(key);
    if (rejection) return rejection;
  }
  return undefined;
}
