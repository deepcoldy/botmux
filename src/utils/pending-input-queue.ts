export interface PendingCliInput {
  content: string;
  turnId?: string;
  senderOpenId?: string;
}

export function mergeQueuedCliInput(
  pending: PendingCliInput[],
  next: PendingCliInput,
): boolean {
  const tail = pending[pending.length - 1];
  if (!tail) return false;
  tail.content = `${tail.content}\n\n${next.content}`;
  tail.turnId = next.turnId ?? tail.turnId;
  if (next.senderOpenId !== undefined) tail.senderOpenId = next.senderOpenId;
  return true;
}
