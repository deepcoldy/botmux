export interface Session {
  sessionId: string;
  status: string;
  botName?: string;
  cliId?: string;
  title?: string;
  workingDir?: string;
  chatId?: string;
  rootMessageId?: string;
  threadId?: string;
  spawnedAt?: number;
  lastMessageAt?: number;
  adopt?: boolean;
  webPort?: number;
  larkAppId?: string;
  [k: string]: any;
}

export interface Schedule {
  id: string;
  name?: string;
  botName?: string;
  larkAppId?: string;
  parsed?: { kind?: string; display?: string };
  nextRunAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  repeat?: { completed: number; times?: number };
  enabled?: boolean;
  [k: string]: any;
}

export interface BotInfo {
  larkAppId: string;
  botName?: string;
}

export interface MemberBot extends BotInfo {
  inChat: boolean;
  oncallChat?: { workingDir?: string } | null;
  error?: string;
}

export interface ChatRow {
  chatId: string;
  name?: string;
  ownerId?: string | null;
  memberBots: MemberBot[];
  [k: string]: any;
}

export interface GroupsPayload {
  chats: ChatRow[];
  bots: BotInfo[];
}

export interface BotDefault {
  larkAppId: string;
  botName?: string;
  botAvatarUrl?: string;
  online?: boolean;
  defaultOncall?: { enabled?: boolean; workingDir?: string; since?: number };
  autoboundChatCount?: number;
  error?: string;
}

type JsonResult = { ok: boolean; [k: string]: any };

async function jget<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

async function jsend(url: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<JsonResult> {
  const r = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok && (j?.ok ?? true), ...j };
}

const enc = encodeURIComponent;

export const api = {
  sessions: () => jget<{ sessions: Session[] }>('/api/sessions'),
  schedules: () => jget<{ schedules: Schedule[] }>('/api/schedules'),
  groups: () => jget<GroupsPayload>('/api/groups'),
  bots: () => jget<{ bots: BotDefault[] }>('/api/bots'),

  closeSession: (id: string) => jsend(`/api/sessions/${enc(id)}/close`, 'POST'),
  locateSession: (id: string) => jsend(`/api/sessions/${enc(id)}/locate`, 'POST'),

  schedOp: (id: string, op: 'run' | 'pause' | 'resume') =>
    jsend(`/api/schedules/${enc(id)}/${op}`, 'POST'),

  createGroup: (body: { name?: string; larkAppIds: string[]; bindWorkingDir?: string }) =>
    jsend('/api/groups/create', 'POST', body),
  addBots: (chatId: string, larkAppIds: string[]) =>
    jsend(`/api/groups/${enc(chatId)}/add-bots`, 'POST', { larkAppIds }),
  leaveGroup: (chatId: string, larkAppIds: string[]) =>
    jsend(`/api/groups/${enc(chatId)}/leave`, 'POST', { larkAppIds }),
  disbandGroup: (chatId: string, larkAppId: string) =>
    jsend(`/api/groups/${enc(chatId)}/disband`, 'POST', { larkAppId }),

  setOncall: (chatId: string, appId: string, workingDir: string) =>
    jsend(`/api/groups/${enc(chatId)}/oncall/${enc(appId)}`, 'PUT', { workingDir }),
  clearOncall: (chatId: string, appId: string) =>
    jsend(`/api/groups/${enc(chatId)}/oncall/${enc(appId)}`, 'DELETE'),
  setBotDefault: (appId: string, body: { enabled: boolean; workingDir: string }) =>
    jsend(`/api/bots/${enc(appId)}/default-oncall`, 'PUT', body),
};
