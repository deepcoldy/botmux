/**
 * `requireBoundBot`：daemon 尚未绑定 larkAppId 时，这些路由必须在进入 handler 之前回 503。
 * 各路由历史上的 503 body 形状不一（有无 `ok` 字段、error 文案、少数带 reason / errorCode），
 * 这里按路由钉死，防止后续合并 helper 时被「顺手统一」。
 *
 * 表里的路由都是「guard 为 handler 第一条语句」的；先做 auth 再做 guard 的路由
 * （如 /api/headless/invocations*）顺序有语义，不在此表。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLarkAppId, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';

const LEGACY_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/api/groups'],
  ['GET', '/api/groups/:chatId/membership'],
  ['POST', '/api/groups/:chatId/add-bots'],
  ['POST', '/api/groups/:chatId/disband'],
  ['POST', '/api/groups/:chatId/leave'],
  ['PUT', '/api/oncall/:chatId'],
  ['DELETE', '/api/oncall/:chatId'],
  ['POST', '/api/roles/batch'],
  ['GET', '/api/roles/:chatId'],
  ['PUT', '/api/roles/:chatId'],
  ['DELETE', '/api/roles/:chatId'],
  ['GET', '/api/message-listeners/:chatId'],
  ['PUT', '/api/message-listeners/:chatId'],
  ['GET', '/api/doc-watches'],
  ['PUT', '/api/doc-watches/:fileToken'],
  ['DELETE', '/api/doc-watches/:fileToken'],
  ['POST', '/api/doc-watches'],
  ['DELETE', '/api/message-listeners/:chatId'],
  ['GET', '/api/global-message-listener'],
  ['PUT', '/api/global-message-listener'],
  ['GET', '/api/group-message-listeners'],
  ['GET', '/api/group-message-listeners/:chatId'],
  ['PUT', '/api/group-message-listeners/:chatId'],
  ['GET', '/api/command-triggers'],
  ['PUT', '/api/command-triggers'],
  ['PUT', '/api/command-triggers/chats/:chatId'],
  ['GET', '/api/command-triggers/conflicts'],
  ['GET', '/api/groups/:chatId/members-display'],
  ['GET', '/api/role-profiles'],
  ['GET', '/api/role-profiles/:profileId'],
  ['GET', '/api/role-profiles/:profileId/:larkAppId'],
  ['PUT', '/api/role-profiles/:profileId/:larkAppId'],
  ['DELETE', '/api/role-profiles/:profileId/:larkAppId'],
  ['POST', '/api/role-profiles/:profileId/apply'],
  ['GET', '/api/bot-default-oncall'],
  ['PUT', '/api/bot-card-prefs'],
  ['PUT', '/api/bot-substitute-mode'],
  ['POST', '/api/bot-substitute-targets/resolve'],
  ['PUT', '/api/bot-summary-range'],
  ['PUT', '/api/bot-grant-prefs'],
  ['PUT', '/api/bot-brand-label'],
  ['PUT', '/api/bot-reply-style'],
  ['PUT', '/api/bot-ask-option-layout'],
  ['PUT', '/api/bot-rename'],
  ['PUT', '/api/bot-avatar'],
  ['GET', '/api/bot-description'],
  ['PUT', '/api/bot-description'],
  ['PUT', '/api/bot-agent'],
  ['POST', '/api/session-group-tag-auth'],
  ['GET', '/api/session-group-tag-status'],
  ['PUT', '/api/session-group-tag-config'],
  ['PUT', '/api/bot-env-policy'],
  ['PUT', '/api/bot-codex-auth-sync'],
  ['PUT', '/api/bot-trigger-user-auth'],
  ['GET', '/api/bot-trigger-user-auth-status'],
  ['PUT', '/api/bot-session-owner-reminder'],
  ['PUT', '/api/bot-sandbox'],
  ['PUT', '/api/bot-sandbox-paths'],
  ['PUT', '/api/bot-read-isolation'],
  ['PUT', '/api/bot-backend-type'],
  ['PUT', '/api/bot-working-dir-mode'],
  ['POST', '/api/groups/create'],
  ['POST', '/api/groups/transfer-owner'],
];

const OKFALSE_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/api/owner-profile'],
  ['GET', '/api/schedules/calendars'],
  ['POST', '/api/schedules'],
  ['DELETE', '/api/schedules/:id'],
  ['GET', '/api/blocked-users'],
  ['PUT', '/api/blocked-users'],
  ['PUT', '/api/chat-group-grant'],
  ['PUT', '/api/group-idle-close/:chatId'],
  ['PUT', '/api/group-serial-input/:chatId'],
  ['PUT', '/api/group-default-models/:chatId'],
  ['PUT', '/api/groups/:chatId/name'],
  ['POST', '/api/message-listeners/:chatId/preview'],
  ['POST', '/api/message-listeners/:chatId/run-preview'],
  ['GET', '/api/message-listeners/:chatId/run-preview/:runId'],
  ['PUT', '/api/bot-quota-fallback'],
  ['PUT', '/api/chat-feedback/:chatId'],
  ['PUT', '/api/chat-pin-streaming-card/:chatId'],
  ['GET', '/api/feedback-effective'],
  ['POST', '/api/bot-config/reload'],
];

const BOTNOTFOUND_ROUTES: ReadonlyArray<readonly [string, string]> = [
  ['POST', '/api/sessions/spawn'],
  ['GET', '/api/headless/sessions'],
  ['POST', '/api/headless/sessions'],
  ['GET', '/api/headless/sessions/:sessionId'],
  ['POST', '/api/headless/sessions/:sessionId/publish'],
  ['POST', '/api/headless/sessions/:sessionId/bind'],
];

const OTHER_ROUTES: ReadonlyArray<readonly [string, string, object]> = [
  ['POST', '/api/chat-reply-mode', { ok: false, reason: 'larkAppId_not_set' }],
  ['POST', '/api/trigger', { ok: false, errorCode: 'bot_not_found', error: 'larkAppId_not_set' }],
];

describe('requireBoundBot guard (unbound daemon)', () => {
  let handle: IpcServerHandle | null = null;

  beforeEach(async () => {
    setLarkAppId('');
    handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = null;
  });

  const call = async (method: string, path: string) => {
    const res = await fetch(`http://127.0.0.1:${handle!.port}${path.replace(/:[a-zA-Z]+/g, 'x')}`, {
      method,
      ...(method === 'GET' || method === 'DELETE' ? {} : { headers: { 'content-type': 'application/json' }, body: '{}' }),
    });
    return { status: res.status, body: await res.json() };
  };

  it.each(LEGACY_ROUTES)('%s %s → 503 { error }', async (method, path) => {
    expect(await call(method, path)).toEqual({ status: 503, body: { error: 'larkAppId_not_set' } });
  });

  it.each(OKFALSE_ROUTES)('%s %s → 503 { ok:false, error:larkAppId_not_set }', async (method, path) => {
    expect(await call(method, path)).toEqual({ status: 503, body: { ok: false, error: 'larkAppId_not_set' } });
  });

  it.each(BOTNOTFOUND_ROUTES)('%s %s → 503 { ok:false, error:bot_not_found }', async (method, path) => {
    expect(await call(method, path)).toEqual({ status: 503, body: { ok: false, error: 'bot_not_found' } });
  });

  it.each(OTHER_ROUTES)('%s %s → 503 with its own body shape', async (method, path, body) => {
    expect(await call(method, path)).toEqual({ status: 503, body });
  });
});
