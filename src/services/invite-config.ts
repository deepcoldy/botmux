/** Per-bot defaults used only by the explicit /invite all command. */
export interface InviteConfig {
  agents?: string[];
}

export function parseInviteConfig(value: unknown): InviteConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('inviteConfig must be an object');
  }
  const input = value as Record<string, unknown>;
  for (const key of Object.keys(input)) {
    if (key !== 'agents') throw new Error(`Unknown inviteConfig option: ${key}`);
  }
  if (input.agents === undefined) return {};
  if (!Array.isArray(input.agents) || input.agents.some(ref => typeof ref !== 'string' || !ref.trim())) {
    throw new Error('inviteConfig.agents must be a list of names or app IDs');
  }
  return { agents: [...new Set((input.agents as string[]).map(ref => ref.trim()))] };
}
