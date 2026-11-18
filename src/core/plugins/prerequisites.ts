import { spawn, execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { readPluginRegistry } from '../../services/plugin-registry-store.js';
import { isStandaloneBinary } from '../self-spawn.js';
import { ensurePluginServicePreload } from './supervisor-store.js';
import { pluginRuntimeDir, resolvePluginPath } from './paths.js';
import type { InstalledPluginRecord } from './types.js';

const execute = promisify(execFile);

function invocation(record: InstalledPluginRecord, action: 'installed' | 'check') {
  const entrypoint = record.contributions?.prerequisites?.entry;
  if (!entrypoint) throw new Error('插件准备入口不可用，请重新安装');
  const entry = resolvePluginPath(pluginRuntimeDir(record.id), entrypoint, 'prerequisites_entry');
  if (!existsSync(entry)) throw new Error('插件准备入口不可用，请重新安装');
  const env = { ...process.env };
  delete env.BUN_BE_BUN;
  delete env.BOTMUX_PLUGIN_INSTALL_RECORD;
  // In the compiled binary BUN_BE_BUN makes this executable run the plugin's JS
  // as Bun. The switch is bootstrap-only: it must not survive into plugin code,
  // or a nested botmux call enters Bun's CLI. A preload clears it after bootstrap,
  // exactly like plugin service processes (see service-manager.ts).
  const bootstrapArgs: string[] = [];
  if (isStandaloneBinary() || process.env.BUN_BE_BUN === '1') {
    bootstrapArgs.push('--preload', ensurePluginServicePreload());
    env.BUN_BE_BUN = '1';
  }
  if (action === 'installed') {
    // This is install authority only. It must not be used for login or Bot writes.
    env.BOTMUX_PLUGIN_INSTALL_RECORD = createHash('sha256').update(JSON.stringify(record)).digest('hex');
  }
  return { entry, env, bootstrapArgs };
}

/** Start only after the runtime and registry transaction has committed. */
export function prepareInstalledPlugin(record: InstalledPluginRecord): void {
  if (!record.manifest.prerequisites) return;
  try {
    const { entry, env, bootstrapArgs } = invocation(record, 'installed');
    const child = spawn(process.execPath, [...bootstrapArgs, entry, 'installed'], {
      env, cwd: pluginRuntimeDir(record.id), detached: true, stdio: 'ignore', shell: false,
    });
    child.once('error', () => console.warn(`plugin_preparation_start_failed:${record.id}`));
    child.unref();
  } catch {
    // Installation remains committed; enabling still fails closed.
    console.warn(`plugin_preparation_start_failed:${record.id}`);
  }
}

export async function assertPluginPrerequisitesReady(pluginId: string): Promise<void> {
  const record = readPluginRegistry().plugins[pluginId];
  if (!record) throw new Error(`plugin_not_installed:${pluginId}`);
  if (!record.manifest.prerequisites) return;
  let status: { ready?: unknown; message?: unknown };
  try {
    const { entry, env, bootstrapArgs } = invocation(record, 'check');
    const { stdout } = await execute(process.execPath, [...bootstrapArgs, entry, 'check'], {
      env, cwd: pluginRuntimeDir(pluginId), timeout: 20_000, maxBuffer: 64 * 1024, shell: false,
    });
    status = JSON.parse(stdout);
  } catch {
    throw new Error('插件前置检查未完成，请在管理页检查安装和登录状态');
  }
  if (status?.ready !== true) {
    throw new Error(typeof status?.message === 'string' && status.message.length < 300
      ? status.message : '请先完成插件安装、本人登录和网关检查');
  }
}
