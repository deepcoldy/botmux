// src/dashboard/public-redact.ts
//
// Anonymous (tokenless) shaping of read-only dashboard payloads served when
// `config.dashboard.publicReadOnly` is on. Pure + side-effect free so they can
// be unit-tested without standing up the dashboard server (dashboard.ts starts
// an HTTP listener on import).
//
// The public "watch work" board only needs NAMES + status. Two read endpoints
// embed real filesystem / business content that an anonymous visitor must not
// see, so each gets a redactor here:
//   - /api/groups   → memberBots[].oncallChat = { chatId, workingDir }
//   - /api/schedules → row carries `prompt` (business instructions) + `workingDir`
// Both `workingDir`s are repo / customer-project paths; stripping them keeps
// the board functional (name-map, timing, status) while not leaking bound dirs
// — and keeps the "/api/bots oncall config is private" boundary honest.

/** Project a `/api/groups` chats array down to the public, board-only fields
 *  for anonymous visitors. Explicit ALLOW-LIST (fail-closed): a chat field that
 *  isn't named here never reaches an anon visitor, so management/config metadata
 *  doesn't ride along. Dropped: `description`, `ownerId` (group config/PII),
 *  `hasRole` (leaks the role/persona existence matrix even though the roles
 *  page is token-gated), `oncallChat` (carries workingDir), `error`,
 *  `firstSeenAt`. Kept: chat `chatId/name/chatMode/avatar` (name-map + group
 *  头像，与公开看板已暴露的群名同等敏感度) and
 *  `memberBots[].larkAppId/botName/inChat` (roster). Returns a new array; never
 *  mutates the input. */
export function redactGroupsForPublic(chats: unknown[]): unknown[] {
  if (!Array.isArray(chats)) return chats;
  return chats.map((c) => {
    if (!c || typeof c !== 'object') return c;
    const chat = c as Record<string, unknown>;
    const out: Record<string, unknown> = {
      chatId: chat.chatId,
      name: chat.name,
      chatMode: chat.chatMode,
      avatar: chat.avatar,
    };
    if (Array.isArray(chat.memberBots)) {
      out.memberBots = chat.memberBots.map((mb) => {
        if (!mb || typeof mb !== 'object') return mb;
        const m = mb as Record<string, unknown>;
        return { larkAppId: m.larkAppId, botName: m.botName, inChat: m.inChat };
      });
    }
    return out;
  });
}

/** Drop `prompt` (business instructions) and `workingDir` (repo/customer path)
 *  from `/api/schedules` rows for anonymous visitors. Returns a new array; never
 *  mutates the input. Name / timing / status fields are preserved so the
 *  read-only schedules view still renders. */
export function redactSchedulesForPublic(schedules: unknown[]): unknown[] {
  if (!Array.isArray(schedules)) return schedules;
  return schedules.map((s) => {
    if (!s || typeof s !== 'object') return s;
    const { prompt: _prompt, workingDir: _workingDir, ...rest } = s as Record<string, unknown>;
    return rest;
  });
}
