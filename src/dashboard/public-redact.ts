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
//     and authenticated-only precondition source values
//   - /api/settings → notifier carries recipient / delivery diagnostics
//   - /api/sessions + /events → session rows/patches may carry `gitBranch`
//     and private message preview fields
// The group/schedule `workingDir`s are repo / customer-project paths; stripping
// them keeps the board functional (name-map, timing, status) while not leaking
// bound dirs — and keeps the "/api/bots oncall config is private" boundary honest.
//
// The session board (`/api/sessions` + `/events`) has THREE audiences, not two —
// see `SessionBoardAudience`. "Not holding the local management cookie" is NOT
// the same as "anonymous": a Feishu H5 / platform Workbench identity is
// authenticated and holds `workbench.view` + `preview.view`/`preview.operate`
// (dashboard/auth.ts:workbenchH5Capability). Handing it the anonymous projection
// deletes the `preview` descriptor its own capabilities are about, so the Dock and
// the mobile Workbench render 「无网页预览」 forever. Only the tokenless
// publicReadOnly visitor gets the anonymous projection.

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
        return {
          larkAppId: m.larkAppId,
          botName: m.botName,
          inChat: m.inChat,
        };
      });
    }
    return out;
  });
}

/** Project one schedule row or event patch for an authenticated management
 *  browser. Only the explicit flat edit fields are returned; daemon-side
 *  references, hashes, nested definitions, and legacy aliases are always
 *  stripped. `preserveClearMarkers` is for merge-based live-event patches:
 *  JSON nulls clear a previous inline/file value after a source change. */
export function stripSchedulePreconditionMaterial(
  schedule: unknown,
  options: { preserveClearMarkers?: boolean } = {},
): unknown {
  if (!schedule || typeof schedule !== 'object') return schedule;
  const {
    preconditionScript,
    preconditionFile: _preconditionFile,
    preconditionFilePath,
    preconditionPath: _preconditionPath,
    preconditionSource,
    preconditionDefinition: _preconditionDefinition,
    preconditionRef: _preconditionRef,
    preconditionHash: _preconditionHash,
    precondition: _precondition,
    ...rest
  } = schedule as Record<string, unknown>;
  if (preconditionSource === 'inline' && typeof preconditionScript === 'string') {
    return {
      ...rest,
      preconditionSource,
      preconditionScript,
      ...(options.preserveClearMarkers && preconditionFilePath === null
        ? { preconditionFilePath: null }
        : {}),
    };
  }
  if (preconditionSource === 'file' && typeof preconditionFilePath === 'string') {
    return {
      ...rest,
      preconditionSource,
      preconditionFilePath,
      ...(options.preserveClearMarkers && preconditionScript === null
        ? { preconditionScript: null }
        : {}),
    };
  }
  if (
    options.preserveClearMarkers
    && rest.hasPrecondition === false
    && preconditionSource === null
    && preconditionScript === null
    && preconditionFilePath === null
  ) {
    return {
      ...rest,
      preconditionSource: null,
      preconditionScript: null,
      preconditionFilePath: null,
    };
  }
  return rest;
}

/** Strip every precondition source representation while preserving unrelated
 * schedule fields. Use this for audiences that may see schedule metadata but
 * must not receive executable text, host paths, or protected-store internals. */
export function stripAllSchedulePreconditionMaterial(schedule: unknown): unknown {
  const projected = stripSchedulePreconditionMaterial(schedule);
  if (!projected || typeof projected !== 'object') return projected;
  const {
    preconditionSource: _preconditionSource,
    preconditionScript: _preconditionScript,
    preconditionFilePath: _preconditionFilePath,
    ...rest
  } = projected as Record<string, unknown>;
  return rest;
}

/** Drop `prompt` (business instructions), `workingDir` (repo/customer path),
 *  and every executable/authority-bearing precondition field from
 *  `/api/schedules` rows for anonymous visitors. The supported list projection
 *  may carry only `hasPrecondition` / `preconditionEnabled`; source/path/script/
 *  ref/hash are stripped defensively even though authenticated management rows
 *  expose the validated flat edit fields. Returns a new array; never mutates the
 *  input. Name / timing / status fields remain available to the public board. */
export function redactSchedulesForPublic(schedules: unknown[]): unknown[] {
  if (!Array.isArray(schedules)) return schedules;
  return schedules.map((s) => {
    const projected = stripAllSchedulePreconditionMaterial(s);
    if (!projected || typeof projected !== 'object') return projected;
    const {
      prompt: _prompt,
      workingDir: _workingDir,
      ...rest
    } = projected as Record<string, unknown>;
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

/** The one field an AUTHENTICATED Workbench identity still does not get.
 *  `riffAccessUrl` is not a display field: it is the Riff AIO Sandbox **write**
 *  capability, a bearer URL whose unique subdomain IS the credential — so
 *  sensitive that riff-backend.ts:hashUrlForLog refuses to log even its host.
 *  Three existing boundaries would silently reopen if the session board handed
 *  it to a Workbench viewer:
 *    1. `GET /api/sessions/:id/write-link` is deliberately absent from
 *       workbenchH5Capability (dashboard/auth.ts) — Workbench identities are
 *       already refused this exact URL through the front door.
 *    2. Terminal writes are arbitrated by a server-side single-writer lease
 *       (terminal-control.ts). The sandbox URL dials the sandbox directly, with
 *       no lease, no takeover arbitration and no control audit record.
 *    3. agent-workbench-panes.tsx short-circuits the read-only `viewToken` path
 *       whenever `workbenchExternalTerminalHref` resolves, so a mobile/H5 viewer
 *       would silently get a WRITABLE terminal where the touch path promises a
 *       read-only one.
 *  Everything else in PRIVATE_SESSION_FIELDS is display data (branch, preview
 *  descriptor + message previews, runtime label, TODO counts) that an
 *  authenticated Workbench viewer is entitled to. */
const WORKBENCH_PRIVATE_SESSION_FIELDS = new Set(['riffAccessUrl']);

/** Who is receiving the session board.
 *  - `management` — the local Dashboard owner cookie: full row, no projection.
 *  - `workbench`  — an authenticated Feishu H5 / platform Workbench identity:
 *                   display fields restored, bearer write credential still gone.
 *  - `anonymous`  — a tokenless `publicReadOnly` visitor: full redaction. */
export type SessionBoardAudience = 'management' | 'workbench' | 'anonymous';

/** Map the two authentication facts dashboard.ts already computes per request
 *  onto an audience. Exported so the judgement itself is unit-testable:
 *  dashboard.ts starts an HTTP listener on import and cannot be loaded from a
 *  test, which is how the H5 board silently regressed to the anonymous
 *  projection in the first place. */
export function sessionBoardAudienceFor(identity: {
  /** Holds the local Dashboard management cookie (`legacy-dashboard`). */
  legacyAuthed: boolean;
  /** Holds an authenticated Feishu H5 or `platform-dashboard` identity. */
  workbenchIdentity: boolean;
}): SessionBoardAudience {
  if (identity.legacyAuthed) return 'management';
  return identity.workbenchIdentity ? 'workbench' : 'anonymous';
}

type SessionFieldFilter = (key: string) => boolean;

/** Anonymous rule: named blacklist PLUS a `preview*` prefix sweep, so a future
 *  preview-prefixed field is private by default (fail-closed). */
const isPrivateForAnonymous: SessionFieldFilter = key =>
  PRIVATE_SESSION_FIELDS.has(key) || key.startsWith('preview');

const isPrivateForWorkbench: SessionFieldFilter = key =>
  WORKBENCH_PRIVATE_SESSION_FIELDS.has(key);

/** `null` = no projection at all (the local management cookie). */
function sessionFieldFilterFor(audience: SessionBoardAudience): SessionFieldFilter | null {
  if (audience === 'management') return null;
  return audience === 'workbench' ? isPrivateForWorkbench : isPrivateForAnonymous;
}

function omitSessionFields(
  record: Record<string, unknown>,
  isPrivate: SessionFieldFilter,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!isPrivate(key)) out[key] = value;
  }
  return out;
}

function projectSessionRow(session: unknown, isPrivate: SessionFieldFilter): unknown {
  if (!session || typeof session !== 'object' || Array.isArray(session)) return session;
  return omitSessionFields(session as Record<string, unknown>, isPrivate);
}

function projectSessionEvent(type: string, body: unknown, isPrivate: SessionFieldFilter): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return body;
  const eventBody = body as Record<string, unknown>;
  if (type === 'session.spawned') {
    return { ...eventBody, session: projectSessionRow(eventBody.session, isPrivate) };
  }
  if (
    type === 'session.update'
    && eventBody.patch
    && typeof eventBody.patch === 'object'
    && !Array.isArray(eventBody.patch)
  ) {
    return {
      ...eventBody,
      patch: omitSessionFields(eventBody.patch as Record<string, unknown>, isPrivate),
    };
  }
  return body;
}

/** Single entry point for `GET /api/sessions`. Never mutates the input, so the
 *  aggregator's own rows stay intact for other audiences on the next request. */
export function projectSessionsForAudience(
  sessions: unknown[],
  audience: SessionBoardAudience,
): unknown[] {
  const isPrivate = sessionFieldFilterFor(audience);
  if (!isPrivate || !Array.isArray(sessions)) return sessions;
  return sessions.map(session => projectSessionRow(session, isPrivate));
}

/** Single entry point for the `/events` SSE relay — same rule as the REST list,
 *  or the REST-side projection would be trivially bypassed by subscribing. */
export function projectSessionEventForAudience(
  type: string,
  body: unknown,
  audience: SessionBoardAudience,
): unknown {
  const isPrivate = sessionFieldFilterFor(audience);
  if (!isPrivate) return body;
  return projectSessionEvent(type, body, isPrivate);
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
  return projectSessionRow(session, isPrivateForAnonymous);
}

export function redactSessionsForPublic(sessions: unknown[]): unknown[] {
  return projectSessionsForAudience(sessions, 'anonymous');
}

/** Apply the same branch-name policy to session rows delivered over SSE. */
export function redactSessionEventForPublic(type: string, body: unknown): unknown {
  return projectSessionEventForAudience(type, body, 'anonymous');
}

/** 匿名只读面板不展示外部 Codex 活动、目标 Bot 或投递运行态,也不展示过载
 *  告警的目标 Bot / 收件人提示。 */
export function redactSettingsForPublic(settings: unknown): unknown {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return settings;
  const source = settings as Record<string, unknown>;
  const { codexNotifier: _privateNotifier, hostOverloadAlert: _privateOverload, ...publicSettings } = source;
  return publicSettings;
}
