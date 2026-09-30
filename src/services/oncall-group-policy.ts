export interface OncallGroupPolicy {
  enabled: boolean;
  chatIds: string[];
}

export function normalizeOncallGroupPolicy(value: unknown): OncallGroupPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('oncallGroup must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['enabled', 'chatIds'].includes(key))) throw new Error('Unknown oncallGroup field');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled must be boolean');
  if (input.chatIds !== undefined && (!Array.isArray(input.chatIds) || input.chatIds.length > 500
    || input.chatIds.some(id => typeof id !== 'string' || !/^oc_[a-zA-Z0-9]+$/.test(id)))) {
    throw new Error('chatIds must contain group chat IDs');
  }
  return { enabled: input.enabled === true, chatIds: [...new Set((input.chatIds ?? []) as string[])] };
}

export function oncallGroupEnabled(policy: OncallGroupPolicy | undefined, chatId: string): boolean {
  return policy?.enabled === true && policy.chatIds.includes(chatId);
}
