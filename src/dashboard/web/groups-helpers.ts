export function allExpectedInChat(row: any, expectedBotIds: Set<string>): boolean {
  if (expectedBotIds.size === 0) return true;
  if (!row) return false;
  const members = (row?.memberBots ?? []) as Array<{ larkAppId: string; inChat: boolean }>;
  for (const id of expectedBotIds) {
    if (!members.some((m) => m.larkAppId === id && m.inChat)) return false;
  }
  return true;
}
