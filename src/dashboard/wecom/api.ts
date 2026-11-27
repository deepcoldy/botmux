import { WecomDashboardConfig } from './config.js';
import { existsSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { jsonRes } from '../http.js';
import { WecomDashboardManager } from './manager.js';
import { WECOM_SESSIONS_PATH } from './session-observer.js';
import { readWecomConfigPaths, wecomRoot } from '../../im/wecom/config/discovery.js';
const configuration = new WecomDashboardConfig();
const manager = new WecomDashboardManager();

/** The connections' manager behind `/api/wecom/*`; the onboarding wizard starts and stops through the same one. */
export function wecomConnectionsManager(): WecomDashboardManager {
  return manager;
}

/**
 * 已配置的企业微信连接数：与 `GET /api/wecom/connections` 列出的条目一一对应（登记过且文件
 * 存在的配置），但只看文件是否存在，不读配置、不探测网关，可以放进高频响应里顺带返回。
 */
export function wecomConnectionCount(root = wecomRoot()): number {
  return readWecomConfigPaths(root).filter(path => existsSync(path)).length;
}
export async function handleWecomConnectionsApi(req: IncomingMessage, res: ServerResponse, url: URL, deps: {
  hostAdmin: boolean;
  csrfValid: boolean;
  readBody?: () => Promise<Record<string, unknown>>;
  configuration?: Pick<WecomDashboardConfig, 'get' | 'patch'>
    & Partial<Pick<WecomDashboardConfig, 'codexProfiles' | 'environment' | 'cliProbe' | 'commandTriggers' | 'fallbackPeers'>>;
  manager?: Pick<WecomDashboardManager, 'list' | 'start' | 'stop' | 'restart'>;
  /** `GET /api/wecom/sessions`: the body the browser reads after a session hint on `/events`. */
  sessions?: () => Promise<unknown>;
}): Promise<boolean> {
  if (!url.pathname.startsWith('/api/wecom/')) {
    return false;
  }
  if (!deps.hostAdmin) {
    jsonRes(res, 403, { error: 'wecom_host_admin_required' });
    return true;
  }
  if (req.method !== 'GET' && !deps.csrfValid) {
    jsonRes(res, 403, { error: 'control_csrf_invalid' });
    return true;
  }
  const service = deps.manager ?? manager;
  try {
    if (req.method === 'GET' && url.pathname === '/api/wecom/connections') {
      jsonRes(res, 200, { connections: await service.list() });
      return true;
    }
    if (req.method === 'GET' && url.pathname === WECOM_SESSIONS_PATH && deps.sessions) {
      jsonRes(res, 200, await deps.sessions());
      return true;
    }
    const fallbackPeers = /^\/api\/wecom\/connections\/([a-f0-9]{64})\/fallback-peers$/.exec(url.pathname);
    if (fallbackPeers && req.method === 'GET') {
      const body = (deps.configuration ?? configuration).fallbackPeers?.(fallbackPeers[1]);
      if (body === undefined) {
        throw new Error('wecom_operation_unavailable');
      }
      jsonRes(res, 200, body);
      return true;
    }
    const triggers = /^\/api\/wecom\/connections\/([a-f0-9]{64})\/command-triggers(?:\/conflicts)?$/.exec(url.pathname);
    if (triggers && req.method === 'GET') {
      const body = (deps.configuration ?? configuration).commandTriggers?.(
        triggers[1],
        url.pathname.endsWith('/conflicts') ? (url.searchParams.get('cmds') ?? '').split(',') : undefined,
      );
      jsonRes(res, 200, body);
      return true;
    }
    const profileRead = /^\/api\/wecom\/connections\/([a-f0-9]{64})\/(codex-profiles|environment|cli-options\/(availability|models))$/.exec(url.pathname);
    if (profileRead && req.method === 'GET') {
      const source = deps.configuration ?? configuration;
      const id = profileRead[1];
      const body = profileRead[2] === 'codex-profiles' ? await source.codexProfiles?.(id)
        : profileRead[2] === 'environment' ? source.environment?.(id)
        : await source.cliProbe?.(id, profileRead[3] as 'availability' | 'models', url.searchParams.get('key') ?? '');
      if (body === undefined) {
        throw new Error('wecom_operation_unavailable');
      }
      jsonRes(res, 200, body);
      return true;
    }
    const settings = /^\/api\/wecom\/connections\/([a-f0-9]{64})\/config$/.exec(url.pathname);
    if (settings && req.method === 'GET') {
      jsonRes(res, 200, (deps.configuration ?? configuration).get(settings[1]));
      return true;
    }
    if (settings && req.method === 'PATCH') {
      jsonRes(res, 200, await (deps.configuration ?? configuration).patch(settings[1], await deps.readBody?.() ?? {}));
      return true;
    }
    // Answered as soon as the action has begun (202 with the connection in
    // progress); its outcome shows in later lists.
    const action = url.pathname.match(/^\/api\/wecom\/connections\/([a-f0-9]{64})\/(start|stop|restart)$/);
    if (req.method === 'POST' && action) {
      const verb = action[2] as 'start' | 'stop' | 'restart';
      const connection = await service[verb](action[1]);
      jsonRes(res, 202, { connection });
      return true;
    }
    jsonRes(res, 404, { error: 'not_found' });
  } catch (error) {
    const code = error instanceof Error && /^wecom_[a-z_]+$/.test(error.message) ? error.message : 'wecom_operation_failed';
    jsonRes(res, code === 'wecom_connection_not_found' ? 404 : 409, { error: code });
  }
  return true;
}
