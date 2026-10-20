/** Host-only identity observation. It grants nothing and never mutates a session. */
export type InteractionPrincipal = { kind: 'union'; unionId: string }
  | { kind: 'app_open'; larkAppId: string; openId: string };
export interface InteractionActorDependencies {
  resolveOpenId(unionId: string): Promise<{ status: string; openId?: string }>;
  resolveUnionId(openId: string): Promise<string | null>;
  members(chatId: string): Promise<readonly string[]>;
  canTalk(appId: string, chatId: string, openId: string, kind: 'group'): boolean;
}
const valid = (value: unknown, prefix: string) => typeof value === 'string'
  && value.length <= 200 && new RegExp('^' + prefix + '[A-Za-z0-9_-]+$').test(value);
export async function observeInteractionActor(request: {
  trustedHost: boolean; daemonAppId: string; body: unknown;
}, deps: InteractionActorDependencies) {
  const fail = (status: number, error: string) => ({ status, body: { ok: false, error } });
  if (!request.trustedHost) return fail(403, 'trusted_host_required');
  const body = request.body as { larkAppId?: string; chatId?: string; principal?: InteractionPrincipal } | undefined;
  if (!body || body.larkAppId !== request.daemonAppId || !valid(body.chatId, 'oc_')) return fail(400, 'invalid_interaction_actor');
  const principal = body.principal;
  if (!principal || !(principal.kind === 'union' && valid(principal.unionId, 'on_')
    || principal.kind === 'app_open' && principal.larkAppId === request.daemonAppId && valid(principal.openId, 'ou_')))
    return fail(400, 'app_scoped_principal_mismatch');
  let openId: string;
  let observedPrincipal: InteractionPrincipal = principal;
  if (principal.kind === 'union') {
    const resolved = await deps.resolveOpenId(principal.unionId);
    if (resolved.status !== 'resolved' || !valid(resolved.openId, 'ou_'))
      return fail(resolved.status === 'transient' ? 503 : 409, 'interaction_principal_unresolved');
    openId = resolved.openId!;
  } else {
    openId = principal.openId;
    const unionId = await deps.resolveUnionId(openId);
    if (unionId && valid(unionId, 'on_')) observedPrincipal = { kind: 'union', unionId };
  }
  const chatId = body.chatId!;
  const member = (await deps.members(chatId)).includes(openId);
  const canTalk = member && deps.canTalk(request.daemonAppId, chatId, openId, 'group') === true;
  return { status: 200, body: { ok: true, schemaVersion: 1,
    actor: { larkAppId: request.daemonAppId, chatId, openId, principal: observedPrincipal, member, canTalk } } };
}
