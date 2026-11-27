export type OncallForwardMode = 'none' | 'individual' | 'merge';

export interface OncallGroupPolicy {
  enabled: boolean;
  chatIds: string[];
  privateIntakeChatIds?: string[];
  flowMode?: 'direct' | 'classify';
  formDisplay?: 'native' | 'private_card' | 'thread_card';
  customFormMode?: 'native' | 'botmux';
  forwardMode?: OncallForwardMode;
  identitySource?: 'bot' | 'shared';
  button?: { timing?: 'first' | 'final'; minTurns?: number };
}

export function normalizeOncallGroupPolicy(value: unknown): OncallGroupPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('oncallGroup must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['enabled', 'chatIds', 'privateIntakeChatIds', 'flowMode', 'formDisplay', 'customFormMode', 'forwardMode', 'identitySource', 'button'].includes(key))) throw new Error('Unknown oncallGroup field');
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('enabled must be boolean');
  if (input.chatIds !== undefined && (!Array.isArray(input.chatIds) || input.chatIds.length > 500
    || input.chatIds.some(id => typeof id !== 'string' || !/^oc_[a-zA-Z0-9]+$/.test(id)))) {
    throw new Error('chatIds must contain group chat IDs');
  }
  if (input.privateIntakeChatIds !== undefined && (!Array.isArray(input.privateIntakeChatIds)
    || input.privateIntakeChatIds.length > 500
    || input.privateIntakeChatIds.some(id => typeof id !== 'string' || !(input.chatIds as unknown[] | undefined)?.includes(id)))) {
    throw new Error('仅私聊处理群必须属于 Oncall 适用群');
  }
  if (input.flowMode !== undefined && !['direct', 'classify'].includes(input.flowMode as string)) throw new Error('Invalid Oncall flowMode');
  if (input.formDisplay !== undefined && !['native', 'private_card', 'thread_card'].includes(input.formDisplay as string)) throw new Error('Invalid Oncall formDisplay');
  if (input.customFormMode !== undefined && !['native', 'botmux'].includes(input.customFormMode as string)) throw new Error('Invalid Oncall customFormMode');
  if (input.forwardMode !== undefined && !['none', 'individual', 'merge'].includes(input.forwardMode as string)) throw new Error('Invalid Oncall forwardMode');
  if (input.identitySource !== undefined && !['bot', 'shared'].includes(input.identitySource as string)) throw new Error('Invalid Oncall identitySource');
  const result: OncallGroupPolicy = { enabled: input.enabled === true, chatIds: [...new Set((input.chatIds ?? []) as string[])] };
  if (Array.isArray(input.privateIntakeChatIds) && input.privateIntakeChatIds.length) {
    result.privateIntakeChatIds = [...new Set(input.privateIntakeChatIds as string[])];
  }
  if (input.flowMode !== undefined) result.flowMode = input.flowMode as OncallGroupPolicy['flowMode'];
  if (input.formDisplay !== undefined) result.formDisplay = input.formDisplay as OncallGroupPolicy['formDisplay'];
  if (input.customFormMode !== undefined) result.customFormMode = input.customFormMode as OncallGroupPolicy['customFormMode'];
  if (input.forwardMode !== undefined) result.forwardMode = input.forwardMode as OncallGroupPolicy['forwardMode'];
  if (input.identitySource !== undefined) result.identitySource = input.identitySource as OncallGroupPolicy['identitySource'];
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

/** Keep already issued native form attempts valid when the display preference changes. */
export function nativeFormPolicyFingerprint(policy: OncallGroupPolicy | undefined): string | undefined {
  if (!policy) return;
  const { customFormMode: _mode, ...handoffPolicy } = policy;
  return JSON.stringify(handoffPolicy);
}

/** Private delivery is an independent privacy setting. Turning off human Oncall does not expose answers. */
export function oncallPrivateIntakeEnabled(policy: OncallGroupPolicy | undefined, sourceChatId: string): boolean {
  return policy?.privateIntakeChatIds?.includes(sourceChatId) === true;
}
