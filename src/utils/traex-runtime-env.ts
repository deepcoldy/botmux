/** TraeX runtime ownership and snapshot environment keys.
 *
 * Leaf module by design: process-identity.ts is part of the daemon-free
 * workflow-core bundle. Keep these constants out of child-env.ts's broader
 * daemon/session environment machinery so the portable process scanner does
 * not pull that whole module into workflow-core. */
export const TRAEX_OCCUPANT_ID_ENV_KEY = 'BOTMUX_TRAEX_OCCUPANT_ID';
export const TRAEX_DOMAIN_KEY_ENV_KEY = 'BOTMUX_TRAEX_DOMAIN_KEY';
export const TRAEX_SNAPSHOT_DIR_ENV_KEY = 'BOTMUX_TRAEX_SNAPSHOT_DIR';
