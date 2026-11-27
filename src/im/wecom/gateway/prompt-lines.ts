/**
 * The gateway's per-turn <botmux_task> lines, resolved through the WeCom
 * customization store (contract/prompt-fragments.ts lists them).
 *
 * The gateway reads the `wecom` scope of the store under its own data dir — a
 * fleet member's SESSION_DATA_DIR, i.e. the same `customizations-wecom` store
 * the Dashboard writes and the managed core is handed (config/managed-core-env.ts).
 * Read-only, short-TTL cached by the store, so a Dashboard edit reaches the
 * next admitted message without a restart. Master switch off, no override, or
 * any read failure → the factory text, byte-identical to the gateway before the
 * lines became editable.
 */
import { customizationEnabled, readCustomizationState } from '../../../services/customization-store.js';
import {
  WECOM_GATEWAY_LINE_FACTORY,
  WECOM_GATEWAY_LINE_LOCALE,
  type WecomGatewayLineKey,
} from '../contract/prompt-fragments.js';

/** The effective text of a gateway line. */
export function wecomPromptLine(key: WecomGatewayLineKey): string {
  let template: string | undefined;
  try {
    if (customizationEnabled('wecom')) {
      template = readCustomizationState('wecom').promptOverrides?.[WECOM_GATEWAY_LINE_LOCALE]?.[key];
    }
  } catch {
    template = undefined;
  }
  return template ?? WECOM_GATEWAY_LINE_FACTORY[key];
}
