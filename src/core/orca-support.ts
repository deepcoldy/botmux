export function isOrcaCliId(id: string | undefined): id is 'orca-codex' | 'orca-claude' {
  return id === 'orca-codex' || id === 'orca-claude';
}

/** Orca owns its Agent's identity/environment. Never claim Botmux isolated a process it did not spawn. */
export function orcaLaunchSupportError(config: {
  cliId?: string; sandbox?: unknown; readIsolation?: boolean; envPolicy?: { mode?: string };
  sandboxNetwork?: boolean; sandboxNetworkPolicy?: unknown; triggerUserAuth?: unknown;
  credentialsSourceDir?: string; wrapperCli?: string; cliPathOverride?: string;
  envUnset?: string[]; codexAuthSync?: string; cliConfigDir?: string;
  startupCommands?: string | string[]; disableCliBypass?: boolean; env?: Record<string, string>;
}, env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!isOrcaCliId(config.cliId)) return undefined;
  if ((config.sandbox && config.sandbox !== 'off') || config.readIsolation
      || (env.BOTMUX_SANDBOX && !['0', 'false', 'off'].includes(env.BOTMUX_SANDBOX))
      || config.envPolicy?.mode === 'strict' || config.sandboxNetwork === false || config.sandboxNetworkPolicy) {
    return 'Orca-managed Agents cannot enforce Botmux sandbox, read-isolation or network/environment policies';
  }
  if (config.envUnset?.length || config.codexAuthSync === 'isolated' || config.cliConfigDir
      || config.triggerUserAuth || config.credentialsSourceDir || config.wrapperCli || config.cliPathOverride
      || config.startupCommands?.length || config.disableCliBypass
      || Object.keys(config.env ?? {}).some(key => key !== 'ORCA_USER_DATA_PATH')) {
    return 'Orca-managed Agents use Orca accounts, permissions and environment; configure them in Orca. Only ORCA_USER_DATA_PATH may select the runtime profile';
  }
  return undefined;
}
