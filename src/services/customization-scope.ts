/**
 * Scopes of the customization store (services/customization-store.ts).
 *
 * Each IM channel family has its own, fully independent set of built-in prompt
 * overrides: its own directory under a data dir, with its own state.json
 * (master switch included), history, read cache and file lock.
 *
 *   feishu — the original store, `<dataDir>/customizations`. Every caller that
 *            names no scope gets this one, exactly as before scopes existed.
 *   wecom  — the native-gateway channel's store, `<dataDir>/customizations-wecom`,
 *            shared by every connection of that channel. Only the Dashboard API
 *            writes it; the channel's gateway and its dedicated cores read it.
 *
 * The WeCom store has ONE resolution rule — {@link wecomCustomizationStoreDir}
 * — used by every party: the Dashboard that writes it, the gateway that renders
 * its per-turn lines from it, and the managed core it is handed to. The Feishu
 * store keeps its historical root (`config.session.dataDir`, unchanged).
 *
 * Light on purpose (node:path + core/data-dir.ts only): the gateway's core
 * environment builder (im/wecom/config) derives the store path from here without
 * loading the store.
 */
import { join } from 'node:path';
import { resolveBotmuxDataDir } from '../core/data-dir.js';

export const CUSTOMIZATION_SCOPES = ['feishu', 'wecom'] as const;
export type CustomizationScope = typeof CUSTOMIZATION_SCOPES[number];

/** The scope every scope-less caller uses. */
export const DEFAULT_CUSTOMIZATION_SCOPE: CustomizationScope = 'feishu';

const SCOPE_DIRECTORY: Record<CustomizationScope, string> = {
  feishu: 'customizations',
  wecom: 'customizations-wecom',
};

export function isCustomizationScope(value: unknown): value is CustomizationScope {
  return typeof value === 'string' && (CUSTOMIZATION_SCOPES as readonly string[]).includes(value);
}

/** Root directory of `scope`'s store under `dataDir`. */
export function customizationStoreRoot(dataDir: string, scope: CustomizationScope): string {
  return join(dataDir, SCOPE_DIRECTORY[scope]);
}

/**
 * The WeCom store's directory for a process with environment `env`: the
 * canonical data dir (core/data-dir.ts: trimmed, absolute SESSION_DATA_DIR, else
 * the daemon breadcrumb, else ~/.botmux/data) + `customizations-wecom`. A
 * padded, relative or empty SESSION_DATA_DIR therefore names the same store in
 * the Dashboard, in the gateway and in the core the gateway starts.
 */
export function wecomCustomizationStoreDir(env: NodeJS.ProcessEnv = process.env): string {
  return customizationStoreRoot(resolveBotmuxDataDir({ env }), 'wecom');
}

/** Whether `scope` carries built-in skill overrides. The wecom scope does not:
 *  its dedicated cores offer no built-in skills (skills/injection-mode.ts). */
export function customizationScopeHasSkills(scope: CustomizationScope): boolean {
  return scope === 'feishu';
}
