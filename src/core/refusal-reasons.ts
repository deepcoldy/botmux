/** The `[reason=…]` tag a refusal carries as its last line. */
export function reasonTag(reason: string): string {
  return `[reason=${reason}]`;
}

/** The person has no grant on the platform yet, or has not allowed this machine's team. */
export const PLATFORM_NOT_AUTHORIZED_REASONS = ['platform_not_authorized', 'platform_consent_missing'] as const;

/** Refusals the person ends by authorizing: a local login, or the platform page. */
export const NOT_AUTHORIZED_REASONS = ['not_authorized', ...PLATFORM_NOT_AUTHORIZED_REASONS] as const;

/** The platform will not issue for the person at all (not a teammate of the owner, or refused for this machine). */
export const PLATFORM_WILL_NOT_ISSUE_REASONS = ['platform_not_teammate', 'platform_forbidden'] as const;

/** Whether `text` carries one of `reasons` as its tag. */
export function hasReason(text: string | undefined, reasons: readonly string[]): boolean {
  return !!text && reasons.some(reason => text.includes(reasonTag(reason)));
}
