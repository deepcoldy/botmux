/** Optional compare-before-locate guard carried by public session cards. */

export interface SessionLocateExpectedScope {
  expectedLarkAppId?: unknown;
  expectedChatId?: unknown;
  expectedScope?: unknown;
  expectedOpen?: unknown;
}

export interface SessionLocateTargetScope {
  larkAppId: string;
  chatId: string;
  scope: 'thread' | 'chat' | undefined;
  status: string;
}

/** Existing `{}` dashboard calls pass; supplied expectations fail closed. */
export function matchesExpectedSessionLocateScope(
  target: SessionLocateTargetScope,
  expected: SessionLocateExpectedScope,
): boolean {
  return !(
    (expected.expectedLarkAppId !== undefined && expected.expectedLarkAppId !== target.larkAppId)
    || (expected.expectedChatId !== undefined && expected.expectedChatId !== target.chatId)
    || (expected.expectedScope !== undefined && expected.expectedScope !== target.scope)
    || (expected.expectedOpen === true && target.status === 'closed')
  );
}
