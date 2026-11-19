/**
 * Per-bot switch for the Lark local-address policy (BotConfig.hideLocalAddresses,
 * default off).
 *
 * Leaf module (no imports), mirroring i18n's setBotLookup: bot-registry pushes
 * its resolver in at load time, so the reply entries, the Lark transport and the
 * prompt builders read the switch without importing the registry. Until a
 * resolver is registered every bot reads as off.
 */

/** Spawn-time snapshot of the switch for processes that cannot read bots.json
 *  (a sandboxed or remote `botmux send`). */
export const HIDE_LOCAL_ADDRESSES_ENV = 'BOTMUX_HIDE_LOCAL_ADDRESSES';

export function hideLocalAddressesEnvValue(enabled: boolean): string {
  return enabled ? '1' : '0';
}

let resolver: ((larkAppId: string) => boolean) | undefined;

/** Returns a function that puts the previous resolver back (test isolation). */
export function setHideLocalAddressesResolver(next: (larkAppId: string) => boolean): () => void {
  const previous = resolver;
  resolver = next;
  return () => { resolver = previous; };
}

export function hideLocalAddressesFor(larkAppId: string | undefined): boolean {
  return !!larkAppId && resolver?.(larkAppId) === true;
}
