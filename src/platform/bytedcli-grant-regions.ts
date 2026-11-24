/** Partitions understood by the platform credential grant and the identity route. */
export const BYTEDCLI_OVERSEAS_REGIONS = ['i18n', 'i18nbd', 'tx'] as const;
export type BytedcliOverseasRegion = typeof BYTEDCLI_OVERSEAS_REGIONS[number];
export type BytedcliGrantRegion = BytedcliOverseasRegion | 'cn';

export function isBytedcliOverseasRegion(value: unknown): value is BytedcliOverseasRegion {
  return (BYTEDCLI_OVERSEAS_REGIONS as readonly unknown[]).includes(value);
}

export const BYTEDCLI_REGION_STATES = ['minted', 'pending', 'not_authorized', 'reauth_required', 'failed'] as const;
export type BytedcliRegionState = typeof BYTEDCLI_REGION_STATES[number];
export type BytedcliRegionStates = Partial<Record<BytedcliGrantRegion, BytedcliRegionState>>;
