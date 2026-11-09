export type OncallForwardMode = 'none' | 'individual' | 'merge';

export interface OncallGroupPolicy {
  enabled: boolean;
  chatIds: string[];
  flowMode?: 'direct' | 'classify';
  formDisplay?: 'native' | 'private_card' | 'thread_card';
  forwardMode?: OncallForwardMode;
  button?: { timing?: 'first' | 'final'; minTurns?: number };
}

export function normalizeOncallGroupPolicy(value: unknown): OncallGroupPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('oncallGroup must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['enabled', 'chatIds', 'flowMode', 'formDisplay', 'forwardMode', 'button'].includes(key))) throw new Error('Unknown oncallGroup field');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled must be boolean');
  if (input.chatIds !== undefined && (!Array.isArray(input.chatIds) || input.chatIds.length > 500
    || input.chatIds.some(id => typeof id !== 'string' || !/^oc_[a-zA-Z0-9]+$/.test(id)))) {
    throw new Error('chatIds must contain group chat IDs');
  }
  if (input.flowMode !== undefined && !['direct', 'classify'].includes(input.flowMode as string)) throw new Error('Invalid Oncall flowMode');
  if (input.formDisplay !== undefined && !['native', 'private_card', 'thread_card'].includes(input.formDisplay as string)) throw new Error('Invalid Oncall formDisplay');
  if (input.forwardMode !== undefined && !['none', 'individual', 'merge'].includes(input.forwardMode as string)) throw new Error('Invalid Oncall forwardMode');
  const result: OncallGroupPolicy = { enabled: input.enabled === true, chatIds: [...new Set((input.chatIds ?? []) as string[])] };
  if (input.flowMode !== undefined) result.flowMode = input.flowMode as OncallGroupPolicy['flowMode'];
  if (input.formDisplay !== undefined) result.formDisplay = input.formDisplay as OncallGroupPolicy['formDisplay'];
  if (input.forwardMode !== undefined) result.forwardMode = input.forwardMode as OncallGroupPolicy['forwardMode'];
  if (input.button !== undefined) {
    if (!input.button || typeof input.button !== 'object' || Array.isArray(input.button)) throw new Error('button must be an object');
    const button = input.button as Record<string, unknown>;
    if (Object.keys(button).some(key => !['timing', 'minTurns'].includes(key))) throw new Error('Unknown Oncall button field');
    if (button.timing !== undefined && !['first', 'final'].includes(button.timing as string)) throw new Error('Invalid Oncall button timing');
    if (button.minTurns !== undefined && (!Number.isInteger(button.minTurns) || Number(button.minTurns) < 1 || Number(button.minTurns) > 100)) throw new Error('minTurns must be between 1 and 100');
    result.button = { timing: button.timing as 'first' | 'final' | undefined, minTurns: button.minTurns as number | undefined };
  }
  return result;
}

export function oncallGroupEnabled(policy: OncallGroupPolicy | undefined, chatId: string): boolean {
  return policy?.enabled === true && policy.chatIds.includes(chatId);
}
