/** Browser-safe policy shared by Dashboard payloads and Worker launch. */
/** Verified app-server/remote-resume protocol; coco requires separate support. */
export const RPC_CAPABLE_CLIS = new Set(['codex', 'traex']);

export function resolveCodexRpcInput(
  cliId: string | undefined,
  botOverride: boolean | undefined | null,
  globalDefault: boolean,
  existingAppServer?: unknown,
  /** Only pass an Auto policy resolved for this actual managed launch. */
  traexAutoModel?: { enabled?: boolean } | null,
): boolean {
  if (!cliId || !RPC_CAPABLE_CLIS.has(cliId) || existingAppServer) return false;
  if (cliId === 'traex' && traexAutoModel?.enabled === true) return false;
  return typeof botOverride === 'boolean' ? botOverride : globalDefault === true;
}

/** Derive the effective mode without rewriting the bot's stored RPC preference. */
export function resolveBotCodexRpcInput(input: {
  cliId?: string;
  model?: string;
  traexAutoModel?: { enabled?: boolean } | null;
  codexRpcInput?: boolean | null;
  existingAppServer?: unknown;
  wrapperCli?: string | null;
  cliLaunchMode?: unknown;
}, globalDefault: boolean): boolean {
  const autoActive = input.cliId === 'traex' && input.model?.trim().toLowerCase() === 'auto'
    && input.traexAutoModel?.enabled === true
    && !input.wrapperCli && !input.cliLaunchMode;
  return resolveCodexRpcInput(input.cliId, input.codexRpcInput, globalDefault,
    input.existingAppServer, autoActive ? input.traexAutoModel : undefined);
}
