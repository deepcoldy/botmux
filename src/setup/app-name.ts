/**
 * Resolve the Feishu application/bot name once at the start of onboarding.
 * Both CLI and Dashboard use this helper so an omitted name always maps to the
 * same stable botmux process index for the lifetime of that attempt.
 */
export function resolveSetupAppName(requestedName: string | undefined, nextBotIndex: number): string {
  const requested = requestedName?.trim();
  return requested || `botmux-${nextBotIndex}`;
}
