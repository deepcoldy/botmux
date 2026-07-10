import type {
  EffectiveRoleValue,
  RoleProfileEntryLike,
} from './role-profile-match.js';

export interface BotInfo {
  larkAppId: string;
  botName: string;
  inChat: boolean;
  hasRole: boolean;
  oncallChat: unknown;
}

export interface DashboardBot {
  larkAppId: string;
  botName: string;
  botAvatarUrl?: string;
}

export interface GroupInfo {
  chatId: string;
  name?: string;
  memberBots: BotInfo[];
}

export type RoleInjectMode = 'every' | 'once';

export interface RoleData {
  chatId: string;
  content: string | null;
  byteLength: number;
  hasRole: boolean;
  injectMode?: RoleInjectMode;
  effectiveContent?: string | null;
  effectiveSource?: string;
  hasEffectiveRole?: boolean;
}

export interface RoleProfileSummary {
  profileId: string;
  entryCount: number;
  updatedAt: number | null;
  botEntries?: Array<{ larkAppId: string; hasEntry: boolean }>;
}

export interface RoleProfileEntry {
  profileId: string;
  larkAppId: string;
  content: string;
  byteLength: number;
  updatedAt: number | null;
}

export interface RoleProfileEntryData {
  profileId: string;
  larkAppId: string;
  content: string | null;
  byteLength: number;
  hasEntry: boolean;
}

export interface RoleProfileContext {
  entriesByProfile: Map<string, RoleProfileEntryLike[]>;
  effectiveRolesByBot: Map<string, EffectiveRoleValue>;
}

export interface RoleProfileApplyResult {
  larkAppId: string;
  ok: boolean;
  status: number;
  error?: unknown;
  wouldRefuse?: boolean;
}

// Keep in sync with MAX_ROLE_BYTES in core/role-resolver.ts (this is a browser
// bundle, so it can't import the Node module — mirror the value here).
export const MAX_ROLE_BYTES = 32768;
export const ROLE_WARN_BYTES = Math.floor(MAX_ROLE_BYTES * 0.95);

const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isValidProfileId(profileId: string): boolean {
  return PROFILE_ID_RE.test(profileId) && profileId !== '.' && profileId !== '..';
}

export function hashChatId(hash = location.hash): string | null {
  const [, query = ''] = hash.split('?');
  const chatId = new URLSearchParams(query).get('chatId')?.trim();
  return chatId || null;
}

export function roleKey(larkAppId: string, chatId: string): string {
  return `${larkAppId}\u0000${chatId}`;
}

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

export function botRoleCount(group: GroupInfo): number {
  return group.memberBots.filter(bot => bot.inChat && bot.hasRole).length;
}

export function botInChatCount(group: GroupInfo): number {
  return group.memberBots.filter(bot => bot.inChat).length;
}

export function profileHasEntry(profile: RoleProfileSummary, larkAppId: string): boolean {
  return (profile.botEntries ?? []).some(entry => entry.larkAppId === larkAppId && entry.hasEntry);
}

export function entryForBot(entries: RoleProfileEntry[], larkAppId: string | null): RoleProfileEntry | undefined {
  return larkAppId ? entries.find(entry => entry.larkAppId === larkAppId) : undefined;
}

export function filterRoleGroups(groups: GroupInfo[], filter: string): GroupInfo[] {
  const q = filter.toLowerCase();
  if (!q) return groups;
  return groups.filter(group => {
    const matchGroup = group.chatId.toLowerCase().includes(q) || (group.name ?? '').toLowerCase().includes(q);
    const matchBot = group.memberBots.some(bot =>
      bot.larkAppId.toLowerCase().includes(q) || (bot.botName ?? '').toLowerCase().includes(q),
    );
    return matchGroup || matchBot;
  });
}

export function filterRoleProfiles(profiles: RoleProfileSummary[], filter: string): RoleProfileSummary[] {
  const q = filter.toLowerCase();
  return profiles.filter(profile => !q || profile.profileId.toLowerCase().includes(q));
}

async function readJson(r: Response): Promise<any> {
  return r.json().catch(() => ({}));
}

export async function loadGroups(): Promise<{ groups: GroupInfo[]; bots: DashboardBot[] }> {
  const r = await fetch('/api/groups');
  const data = await readJson(r);
  return {
    bots: (data.bots ?? []).map((bot: any) => ({
      larkAppId: bot.larkAppId,
      botName: bot.botName ?? bot.larkAppId,
      botAvatarUrl: bot.botAvatarUrl,
    })),
    groups: (data.chats ?? []).map((chat: any) => ({
      chatId: chat.chatId,
      name: chat.name ?? chat.chatId,
      memberBots: (chat.memberBots ?? []).map((member: any) => ({
        larkAppId: member.larkAppId,
        botName: member.botName ?? member.larkAppId,
        inChat: member.inChat ?? false,
        hasRole: member.hasRole ?? false,
        oncallChat: member.oncallChat ?? null,
      })),
    })),
  };
}

export async function loadProfiles(): Promise<RoleProfileSummary[]> {
  const r = await fetch('/api/role-profiles');
  const data = await readJson(r);
  return data.profiles ?? [];
}

export async function loadProfileEntries(profileId: string): Promise<RoleProfileEntry[]> {
  const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}`);
  const data = await readJson(r);
  return data.entries ?? [];
}

export async function loadRole(larkAppId: string, chatId: string): Promise<RoleData> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`);
  return readJson(r) as Promise<RoleData>;
}

export async function saveRole(larkAppId: string, chatId: string, content: string, injectMode: RoleInjectMode): Promise<boolean> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, injectMode }),
  });
  return r.ok;
}

/** Persist only the injection mode (no content) — used when toggling the mode
 *  select, which can apply even to a chat whose role comes from the team default. */
export async function saveInjectMode(larkAppId: string, chatId: string, injectMode: RoleInjectMode): Promise<boolean> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ injectMode }),
  });
  return r.ok;
}

export async function deleteRole(larkAppId: string, chatId: string): Promise<boolean> {
  const r = await fetch(`/api/roles/${encodeURIComponent(larkAppId)}/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
  return r.ok;
}

export async function loadProfileEntry(profileId: string, larkAppId: string): Promise<RoleProfileEntryData> {
  const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`);
  return readJson(r) as Promise<RoleProfileEntryData>;
}

export async function saveProfileEntry(profileId: string, larkAppId: string, content: string): Promise<boolean> {
  const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, allowEmpty: true }),
  });
  return r.ok;
}

export async function deleteProfileEntry(profileId: string, larkAppId: string): Promise<boolean> {
  const r = await fetch(`/api/role-profiles/${encodeURIComponent(profileId)}/${encodeURIComponent(larkAppId)}`, { method: 'DELETE' });
  return r.ok;
}

export async function loadRoleProfileContext(groups: GroupInfo[], profiles: RoleProfileSummary[]): Promise<RoleProfileContext> {
  const detailPairs = await Promise.all(profiles.map(async profile => {
    try {
      const r = await fetch(`/api/role-profiles/${encodeURIComponent(profile.profileId)}`);
      const body = await readJson(r);
      return [profile.profileId, Array.isArray(body.entries) ? body.entries as RoleProfileEntryLike[] : []] as const;
    } catch {
      return [profile.profileId, [] as RoleProfileEntryLike[]] as const;
    }
  }));

  const nextEffectiveRoles = new Map<string, EffectiveRoleValue>();
  const seen = new Set<string>();
  await Promise.all(groups.flatMap(group =>
    group.memberBots
      .filter(bot => bot.inChat)
      .map(async bot => {
        const key = roleKey(bot.larkAppId, group.chatId);
        if (seen.has(key)) return;
        seen.add(key);
        try {
          const role = await loadRole(bot.larkAppId, group.chatId);
          const hasEffectiveRole = role.hasEffectiveRole ?? role.hasRole;
          const effectiveContent = 'effectiveContent' in role ? role.effectiveContent : role.content;
          nextEffectiveRoles.set(key, {
            content: hasEffectiveRole ? String(effectiveContent ?? '') : null,
            source: role.effectiveSource ?? (role.hasRole ? 'chat' : 'none'),
          });
        } catch {
          nextEffectiveRoles.set(key, null);
        }
      }),
  ));

  return {
    entriesByProfile: new Map(detailPairs),
    effectiveRolesByBot: nextEffectiveRoles,
  };
}

export async function applyRoleProfile(input: {
  profileId: string;
  chatId: string;
  larkAppId: string;
  force: boolean;
  preview: boolean;
}): Promise<RoleProfileApplyResult> {
  const r = await fetch(`/api/role-profiles/${encodeURIComponent(input.profileId)}/apply`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      chatId: input.chatId,
      larkAppId: input.larkAppId,
      force: input.force,
      preview: input.preview,
    }),
  });
  const body = await readJson(r);
  return {
    larkAppId: input.larkAppId,
    ok: r.ok && body.ok !== false,
    status: r.status,
    error: body.error,
    wouldRefuse: body.wouldRefuse,
  };
}
