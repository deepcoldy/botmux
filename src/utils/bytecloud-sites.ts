/**
 * ByteCloud credential partitions governed by trigger-user authentication.
 *
 * These are credential sites, not every spelling accepted by bytedcli.  The
 * CLI currently aliases BOE to CN, i18n to i18n-bd, the US BDEE/USTS profiles
 * to us-ttp, and the EU limited/full profiles to eu-ttp.  Keep the allowlist in
 * one module so minting and wrapper publication cannot acquire different site
 * sets.  Unknown future sites are deliberately not minted; the wrapper's
 * prefix-based credential scrub then makes them fail closed.
 */
export const BYTECLOUD_USER_JWT_ENV_BY_SITE = {
  cn: 'BYTECLOUD_CLI_API_JWT_TOKEN_CN',
  'i18n-tt': 'BYTECLOUD_CLI_API_JWT_TOKEN_I18N_TT',
  'i18n-bd': 'BYTECLOUD_CLI_API_JWT_TOKEN_I18N_BD',
  'eu-ttp': 'BYTECLOUD_CLI_API_JWT_TOKEN_EU_TTP',
  'us-ttp': 'BYTECLOUD_CLI_API_JWT_TOKEN_US_TTP',
} as const;

export type ByteCloudUserSite = keyof typeof BYTECLOUD_USER_JWT_ENV_BY_SITE;

export const BYTECLOUD_USER_SITES = Object.freeze(
  Object.keys(BYTECLOUD_USER_JWT_ENV_BY_SITE) as ByteCloudUserSite[],
);
