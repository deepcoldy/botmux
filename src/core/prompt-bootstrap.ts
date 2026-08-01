export type PromptInjectionMode = 'legacy' | 'session-bootstrap';

/**
 * Prompt compaction is an explicit bot policy, independent from the terminal
 * backend. Existing installations stay byte-for-byte compatible until the
 * operator enables session-bootstrap for newly created sessions.
 */
export function resolvePromptInjectionMode(
  configured?: PromptInjectionMode,
): PromptInjectionMode {
  return configured === 'session-bootstrap' ? 'session-bootstrap' : 'legacy';
}
