/**
 * Outbound redaction: every text and card leaving the gateway has local
 * addresses hidden when configured.
 *
 * Functions here are WecomBridge methods: they run with `this` bound to the bridge
 * (the class in ../bridge.ts forwards to them), so they share its state and lane.
 */
import { sanitizeLocalAddressText } from '../../../lark/local-address-policy.js';
import type { WecomTemplateCard, WecomCardEvent } from '../../protocol/types.js';
import type { WecomBridge } from '../bridge.js';

export function sanitizeCard(this: WecomBridge, card: WecomTemplateCard): WecomTemplateCard {
  return JSON.parse(this.sanitize(JSON.stringify(card))) as WecomTemplateCard;
}

export async function sendCard(this: WecomBridge, recipient: string, card: WecomTemplateCard): Promise<void> {
  await this.options.transport.sendCard?.(recipient, this.sanitizeCard(card));
}

export async function updateCard(this: WecomBridge, event: WecomCardEvent, card: WecomTemplateCard): Promise<void> {
  await this.options.transport.updateCard?.(event, this.sanitizeCard(card));
}

export function sanitize(this: WecomBridge, text: string, policy = this.policy()): string {
  return policy.hideLocalAddresses
    ? sanitizeLocalAddressText(text, { workspaceRoots: policy.workingDirectory ? [policy.workingDirectory] : [] })
    : text;
}
