import { getBot } from '../bot-registry.js';
import { bytecloudBrokerEnabled } from '../core/identity-policy.js';
import { readPluginBytedcliOperationPresets, selectPluginBytedcliOperationPreset } from '../core/plugins/bytedcli-operation-presets.js';
import { withPluginServiceLock } from '../core/plugins/service-manager.js';
import { rmwBotEntry } from './config-store.js';
import { parseTriggerUserAuthConfig, type TriggerUserAuthConfig } from './trigger-user-auth.js';

const referenceErrors = new Set(['invalid_bytedcli_operation_preset_reference', 'bytedcli_operation_preset_unavailable', 'bytedcli_operation_preset_changed', 'bytedcli_operation_preset_mode_required']);
/** Preserve the latest on-disk settings; installation/binding mutations cannot
 * interleave with selecting and committing an explicit plugin template. */
export async function applyPluginBytedcliOperationPreset(appId: string, reference: unknown): Promise<
  { ok: true; triggerUserAuth: TriggerUserAuthConfig } | { ok: false; reason: string }
> {
  try {
    return await withPluginServiceLock(async () => {
      let applied: TriggerUserAuthConfig | undefined;
      const result = await rmwBotEntry<TriggerUserAuthConfig>(appId, entry => {
        const current = parseTriggerUserAuthConfig(entry.triggerUserAuth);
        if (!current || !bytecloudBrokerEnabled({ ...current, enabled: true })) throw new Error('bytedcli_operation_preset_mode_required');
        const preset = selectPluginBytedcliOperationPreset(readPluginBytedcliOperationPresets(entry), reference);
        const next = parseTriggerUserAuthConfig({ ...current, bytedcliOperationPolicy: preset.policy })!;
        const { legacyFallback: _legacy, tools: _tools, ...stored } = next;
        entry.triggerUserAuth = next.capabilities ? stored : { ...stored, tools: next.tools };
        applied = next;
        return next;
      }, { onCommitted: () => { getBot(appId).config.triggerUserAuth = applied; } });
      return result.ok ? { ok: true as const, triggerUserAuth: result.result } : result;
    });
  } catch (error) {
    const reason = (error as Error).message;
    if (referenceErrors.has(reason)) return { ok: false, reason };
    throw error;
  }
}
