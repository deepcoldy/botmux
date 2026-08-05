export interface GroupMatrixChat {
  chatId: string;
  name?: string;
  avatar?: string;
  [key: string]: unknown;
}

export interface GroupsMatrix {
  chats: GroupMatrixChat[];
  bots: unknown[];
}

export interface GroupPresentation {
  chatId: string;
  name?: string;
  avatar?: string;
}

export interface CompactGroupsSnapshot {
  chats: GroupPresentation[];
}

interface CachedMatrix {
  matrix: GroupsMatrix;
  presentationByChatId: ReadonlyMap<string, GroupPresentation>;
  validUntil: number;
}

export interface GroupsMatrixSnapshotOptions {
  ttlMs?: number;
  retryMs?: number;
  now?: () => number;
  onRefreshError?: (error: unknown) => void;
}

export interface GroupsMatrixSnapshot {
  get: (options?: { force?: boolean }) => Promise<GroupsMatrix>;
  warm: () => void;
  invalidate: () => void;
  peekPresentation: () => ReadonlyMap<string, GroupPresentation>;
}

function optionalTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Decide whether a role write (PUT/DELETE `/api/roles/:chatId`, or
 * `POST /api/role-profiles/:id/apply`) actually mutated the `hasRole` matrix
 * and should therefore invalidate the groups snapshot.
 *
 * `hasRole` (per bot × chat) feeds the roles-page「已配置/未配置」badge and the
 * groups card, so a stale snapshot leaves the badge wrong for up to the 30s TTL
 * — and the refresh button can't fix it (it hits `/api/groups` without
 * `refresh=1`). We invalidate on every successful write EXCEPT when the daemon
 * reports `changed: false`, which means the role FILE was not touched:
 *   - `apply` preview mode, and no-op / refused applies;
 *   - an injectMode-only PUT (writes just the `.meta.json` sidecar — `hasRole`
 *     is unchanged, so the common inject-mode toggle must not bust the cache);
 *   - a DELETE that removed nothing (`existed:false`).
 * Invalidating in those cases would punch through the 30s snapshot and undo the
 * fan-out savings this cache exists to provide. Responses that omit `changed`
 * entirely (e.g. a proxied text body we can't parse) still invalidate — a
 * successful write we can't introspect should refresh rather than stay stale.
 */
export function roleWriteShouldInvalidate(upstreamOk: boolean, body: unknown): boolean {
  if (!upstreamOk) return false;
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const rec = body as Record<string, unknown>;
    if (rec.ok === false) return false;
    // changed:false = daemon confirmed the role file was untouched (preview /
    // injectMode-only / delete-not-found). Absent field (undefined !== false)
    // → still invalidate, keeping the fail-safe "refresh when unsure" default.
    if (rec.changed === false) return false;
  }
  return true;
}


export function compactGroupsMatrix(matrix: GroupsMatrix): CompactGroupsSnapshot {
  return {
    chats: matrix.chats.flatMap((chat) => {
      const chatId = optionalTrimmedString(chat.chatId);
      if (!chatId) return [];
      return [
        {
          chatId,
          ...(optionalTrimmedString(chat.name) ? { name: optionalTrimmedString(chat.name) } : {}),
          ...(optionalTrimmedString(chat.avatar)
            ? { avatar: optionalTrimmedString(chat.avatar) }
            : {}),
        },
      ];
    }),
  };
}

function presentationMap(matrix: GroupsMatrix): ReadonlyMap<string, GroupPresentation> {
  return new Map(compactGroupsMatrix(matrix).chats.map((chat) => [chat.chatId, chat]));
}

export function enrichSessionsWithGroupNames<T extends Record<string, unknown>>(
  sessions: readonly T[],
  presentationByChatId: ReadonlyMap<string, GroupPresentation>,
): T[] {
  if (presentationByChatId.size === 0) return [...sessions];
  return sessions.map((session) => {
    if (session.chatType !== "group" || optionalTrimmedString(session.chatDisplayName))
      return session;
    const chatId = optionalTrimmedString(session.chatId);
    const name = chatId ? presentationByChatId.get(chatId)?.name : undefined;
    return name ? { ...session, chatDisplayName: name } : session;
  });
}

export function createGroupsMatrixSnapshot(
  build: () => Promise<GroupsMatrix>,
  options: GroupsMatrixSnapshotOptions = {},
): GroupsMatrixSnapshot {
  const ttlMs = options.ttlMs ?? 30_000;
  const retryMs = options.retryMs ?? 5_000;
  const now = options.now ?? Date.now;
  let cached: CachedMatrix | null = null;
  let inFlight: Promise<GroupsMatrix> | null = null;
  let generation = 0;
  let inFlightGeneration = 0;

  const get = async (getOptions: { force?: boolean } = {}): Promise<GroupsMatrix> => {
    if (!getOptions.force && cached && cached.validUntil > now()) return cached.matrix;
    if (inFlight) {
      if (inFlightGeneration === generation) return inFlight;
      await inFlight;
      return get(getOptions);
    }

    const startedGeneration = generation;
    inFlightGeneration = startedGeneration;
    inFlight = build()
      .then((matrix) => {
        cached = {
          matrix,
          presentationByChatId: presentationMap(matrix),
          validUntil: startedGeneration === generation ? now() + ttlMs : 0,
        };
        return matrix;
      })
      .catch((error: unknown) => {
        options.onRefreshError?.(error);
        if (!cached) throw error;
        cached.validUntil = now() + retryMs;
        return cached.matrix;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  return {
    get,
    warm() {
      void get().catch(() => {
        // Cold-cache enrichment is best-effort; the authoritative session list remains available.
      });
    },
    invalidate() {
      generation += 1;
      if (cached) cached.validUntil = 0;
    },
    peekPresentation() {
      return cached?.presentationByChatId ?? new Map();
    },
  };
}
