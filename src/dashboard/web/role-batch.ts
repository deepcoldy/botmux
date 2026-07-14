import type { EffectiveRoleValue } from './role-profile-match.js';

export interface EffectiveRoleTarget {
  larkAppId: string;
  chatId: string;
}

export function effectiveRoleKey(larkAppId: string, chatId: string): string {
  return `${larkAppId}\u0000${chatId}`;
}

/** Load the requested role snapshots through one browser request. */
export async function loadEffectiveRoleMap(
  targets: EffectiveRoleTarget[],
): Promise<Map<string, EffectiveRoleValue>> {
  const roles = new Map<string, EffectiveRoleValue>();
  for (const target of targets) roles.set(effectiveRoleKey(target.larkAppId, target.chatId), null);
  if (targets.length === 0) return roles;

  let response: Response;
  try {
    response = await fetch('/api/roles/batch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ targets }),
    });
  } catch {
    return roles;
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) return roles;

  for (const role of Array.isArray(body?.roles) ? body.roles : []) {
    if (!role || typeof role !== 'object') continue;
    const larkAppId = typeof role.larkAppId === 'string' ? role.larkAppId : '';
    const chatId = typeof role.chatId === 'string' ? role.chatId : '';
    const key = effectiveRoleKey(larkAppId, chatId);
    if (!roles.has(key)) continue;
    const hasEffectiveRole = role.hasEffectiveRole ?? role.hasRole;
    const effectiveContent = 'effectiveContent' in role ? role.effectiveContent : role.content;
    roles.set(key, {
      content: hasEffectiveRole ? String(effectiveContent ?? '') : null,
      source: role.effectiveSource ?? (role.hasRole ? 'chat' : 'none'),
    });
  }
  return roles;
}
