// src/dashboard/public-redact.ts
//
// Anonymous (tokenless) shaping of read-only dashboard payloads served when
// `config.dashboard.publicReadOnly` is on. Pure + side-effect free so they can
// be unit-tested without standing up the dashboard server (dashboard.ts starts
// an HTTP listener on import).
//
// The public "watch work" board only needs NAMES + status. Read endpoints can
// embed filesystem, business, or operator-only data that an anonymous visitor
// must not see, so each sensitive payload gets a redactor here:
//   - /api/groups   → memberBots[].oncallChat = { chatId, workingDir }
//   - /api/schedules → row carries `prompt` (business instructions) + `workingDir`
//   - /api/settings → notifier carries recipient / delivery diagnostics
//   - /api/sessions + /events → session rows/patches may carry `gitBranch`
//     and private message preview fields
// The group/schedule `workingDir`s are repo / customer-project paths; stripping
// them keeps the board functional (name-map, timing, status) while not leaking
// bound dirs — and keeps the "/api/bots oncall config is private" boundary honest.

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

const PRIVATE_SESSION_FIELDS = new Set([
  'gitBranch',
  'riffAccessUrl',
  // Concrete distribution identity is operator configuration, not anonymous
  // watch-board data. Public rows retain protocol-level `cliId`, which is
  // sufficient for the existing fallback label.
  'runtimeId',
  'runtimeDisplayName',
  'previewUserText',
  'previewBotText',
  'previewUserFullText',
  'previewBotFullText',
  'previewUserAt',
  'previewBotAt',
  'previewBotState',
  // openTodos.items[].text 是从 CLI transcript 读出的任务明文，等同 preview 内容，
  // 匿名看板不得透传。整字段进黑名单（列归属靠运行态即可，匿名侧不显示 TODO 徽标）。
  'openTodos',
]);

function omitPrivateSessionFields(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!PRIVATE_SESSION_FIELDS.has(key) && !key.startsWith('preview')) out[key] = value;
  }
  return out;
}

/** Branch names often carry issue/customer identifiers. `riffAccessUrl` is the
 * Riff AIO Sandbox **write** capability — a bearer URL whose unique subdomain is
 * itself the credential (riff-backend.ts:hashUrlForLog), so an anonymous read-only
 * visitor must never receive it (they'd gain write access to the sandbox). Read
 * access on the dashboard goes through the local worker log terminal (webPort),
 * which stays; only the sandbox write URL is stripped. `/api/sessions` and
 * `/events` are both public-read surfaces, so keep one non-mutating projection
 * for their shared session row shape. */
export function redactSessionForPublic(session: unknown): unknown {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
  return omitPrivateSessionFields(session as Record<string, unknown>);
}

export function redactSessionsForPublic(sessions: unknown[]): unknown[] {
  if (!Array.isArray(sessions)) return sessions;
  return sessions.map(redactSessionForPublic);
}

/** Apply the same branch-name policy to session rows delivered over SSE. */
export function redactSessionEventForPublic(type: string, body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const eventBody = body as Record<string, unknown>;
  if (type === 'session.spawned') {
    return { ...eventBody, session: redactSessionForPublic(eventBody.session) };
  }
  if (
    type === 'session.update'
    && eventBody.patch
    && typeof eventBody.patch === 'object'
    && !Array.isArray(eventBody.patch)
  ) {
    return {
      ...eventBody,
      patch: omitPrivateSessionFields(eventBody.patch as Record<string, unknown>),
    };
  }
  return body;
}

/** 匿名只读面板不展示外部 Codex 活动、目标 Bot 或投递运行态,也不展示过载
 *  告警的目标 Bot / 收件人提示。 */
export function redactSettingsForPublic(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
  const source = settings as Record<string, unknown>;
  const { codexNotifier: _privateNotifier, hostOverloadAlert: _privateOverload, ...publicSettings } = source;
  return publicSettings;
}
