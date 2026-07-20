import type { MessageResource } from './message-parser.js';
import type { LarkMention } from '../../types.js';

export function composeForwardFollowupContent(seedContent: string, followupContent: string): string {
  const seed = seedContent.trim();
  const followup = followupContent.trim();
  if (!seed) return followup;
  if (!followup) return seed;
  return '<forwarded_context>\n' + seed + '\n</forwarded_context>\n\n'
    + '<user_request>\n' + followup + '\n</user_request>';
}

export function bindResourcesToMessage(
  resources: MessageResource[],
  messageId: string,
): MessageResource[] {
  return resources.map(resource => ({
    ...resource,
    messageId: resource.messageId ?? messageId,
  }));
}

export function mergeMessageMentions(
  seedMentions?: LarkMention[],
  followupMentions?: LarkMention[],
): LarkMention[] | undefined {
  const merged: LarkMention[] = [];
  const indexes = new Map<string, number>();
  for (const mention of [...(seedMentions ?? []), ...(followupMentions ?? [])]) {
    const identity = mention.openId
      ? `open:${mention.openId}`
      : mention.userId
        ? `user:${mention.userId}`
        : mention.unionId
          ? `union:${mention.unionId}`
          : `key:${mention.key}:${mention.name}`;
    const existingIndex = indexes.get(identity);
    if (existingIndex === undefined) {
      indexes.set(identity, merged.length);
      merged.push({ ...mention });
    } else {
      merged[existingIndex] = {
        ...mention,
        ...merged[existingIndex],
        openId: merged[existingIndex].openId ?? mention.openId,
        userId: merged[existingIndex].userId ?? mention.userId,
        unionId: merged[existingIndex].unionId ?? mention.unionId,
        idType: merged[existingIndex].idType ?? mention.idType,
      };
    }
  }
  return merged.length > 0 ? merged : undefined;
}
