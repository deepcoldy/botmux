import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'dotenv';
import { withSecureHostParentSync } from '../platform/secure-host-file.js';
import { guardControlRequest, type ControlCsrfTokens } from './control-csrf.js';
import type { DashboardRequestIdentity } from './request-identity.js';
import { readJsonBodyWithLimit } from './trigger-api.js';
import { jsonRes } from './http.js';
import { resolveBotmuxDataDir } from '../core/data-dir.js';
import { normalizeOncallConnection, readOncallConnectionDraft } from '../services/oncall-group-client.js';
import { readOncallDeploymentEnv } from '../services/oncall-deployment-config.js';

const KEY = 'ONCALL_SERVICE_SECRET';

function replaceEnvValue(raw: string, name: string, value: string): string {
  const assignment = ["'", '"', '`'].map(q => `${name}=${q}${value}${q}`)
    .find(line => parse(line)[name] === value);
  if (!assignment) throw new Error('invalid_secret');
  // Match complete dotenv assignments so a key inside another multiline value is untouched.
  const entries = /^[ \t]*(?:export[ \t]+)?([\w.-]+)(?:[ \t]*=[ \t]*|:[ \t]+)('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]*)([ \t]*(?:#[^\r\n]*)?)\r?$/gm;
  const rest = raw.replace(entries, (entry, key, _value, comment) => key === name ? comment : entry);
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const updated = `${rest}${rest && !rest.endsWith('\n') ? newline : ''}${assignment}${newline}`;
  const expected = { ...parse(raw), [name]: value };
  if (!isDeepStrictEqual(parse(updated), expected)) throw new Error('invalid_env');
  return updated;
}

export async function handleOncallServiceSecret(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  deps: {
    identity: Pick<DashboardRequestIdentity, 'canManageHost' | 'authSessionId'> | null;
    csrfTokens: ControlCsrfTokens;
    envFile?: string;
    dataDir?: string;
  },
): Promise<boolean> {
  const isConnection = url.pathname === '/api/oncall-connection';
  if (url.pathname !== '/api/oncall-service-secret' && !isConnection) return false;
  res.setHeader('cache-control', 'no-store');
  const reply = (status: number, body: unknown) => { jsonRes(res, status, body); return true; };
  if (!deps.identity?.canManageHost) return reply(403, { ok: false, error: '需要管理员权限' });
  if (req.method !== 'GET' && req.method !== 'PUT') return reply(405, { ok: false, error: 'method_not_allowed' });
  const envFile = deps.envFile ?? join(homedir(), '.botmux', '.env');
  if (req.method === 'GET') {
    try {
      const active = readOncallDeploymentEnv(envFile);
      if (isConnection) {
        const dataDir = deps.dataDir ?? resolveBotmuxDataDir();
        const appId = url.searchParams.get('appId') ?? '';
        return reply(200, { ok: true, ...readOncallConnectionDraft(dataDir, appId, active), restartRequired: false });
      }
      const configured = Boolean(active[KEY]?.trim());
      return reply(200, { ok: true, configured, secret: active[KEY] ?? '', restartRequired: false });
    } catch { return reply(503, { ok: false, error: '无法读取配置，请检查 .env 权限为 0600' }); }
  }
  const guard = guardControlRequest({ headers: req.headers, authSessionId: deps.identity.authSessionId, tokens: deps.csrfTokens });
  if (!guard.ok) return reply(guard.status, { ok: false, error: guard.error });
  let body: any;
  try { body = await readJsonBodyWithLimit(req, 16 * 1024); }
  catch { return reply(400, { ok: false, error: '凭据请求无效或过大' }); }
  const secret = typeof body?.secret === 'string' ? body.secret.trim() : '';
  const hasSecret = Object.hasOwn(body ?? {}, 'secret');
  if ((!isConnection || hasSecret) && (!secret || secret.length > 8192 || /[^\x21-\x7e]/.test(secret))) {
    return reply(400, { ok: false, error: '请输入有效的单行 Service Secret' });
  }
  let values: Record<string, string>;
  if (isConnection) {
    try {
      if (!body || Array.isArray(body) || Object.keys(body).some(key => !['endpoint', 'emailDomain', 'secret'].includes(key))) throw new Error();
      const result = normalizeOncallConnection({ endpoint: typeof body.endpoint === 'string' ? body.endpoint.trim() : '',
        emailDomain: typeof body.emailDomain === 'string' ? body.emailDomain.trim() : '' });
      values = { ONCALL_GROUP_ENDPOINT: result.endpoint, ONCALL_EMAIL_DOMAIN: result.emailDomain, ...(hasSecret ? { [KEY]: secret } : {}) };
    } catch { return reply(400, { ok: false, error: '请填写有效的 HTTPS 网关地址和邮箱域' }); }
  } else if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== 'secret')) {
    return reply(400, { ok: false, error: '请输入有效的单行 Service Secret' });
  } else values = { [KEY]: secret };
  try {
    withSecureHostParentSync(envFile, file => file.withLeafLock(() => {
      const raw = file.readLeaf();
      // Creating the global file would stop startup from loading the legacy cwd .env.
      if (raw === null && existsSync(join(process.cwd(), '.env'))) throw new Error('legacy_env');
      let updated = raw ?? '';
      for (const [key, value] of Object.entries(values)) updated = replaceEnvValue(updated, key, value);
      file.writeLeaf(updated);
    }));
    return reply(200, { ok: true, configured: true, restartRequired: false });
  } catch (error) {
    return reply(503, { ok: false, error: error instanceof Error && error.message === 'legacy_env'
      ? '请先将工作目录的 .env 迁移到 ~/.botmux/.env 并重启，避免覆盖其他启动配置'
      : '保存失败，请检查 .env 内容及权限为 0600' });
  }
}
