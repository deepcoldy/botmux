import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse } from 'dotenv';
import { readSecureHostFileSync, withSecureHostParentSync } from '../platform/secure-host-file.js';
import { guardControlRequest, type ControlCsrfTokens } from './control-csrf.js';
import type { DashboardRequestIdentity } from './request-identity.js';
import { readJsonBodyWithLimit } from './trigger-api.js';
import { jsonRes } from './http.js';

const KEY = 'ONCALL_SERVICE_SECRET';

function replaceSecret(raw: string, secret: string): string {
  const assignment = ["'", '"', '`'].map(q => `${KEY}=${q}${secret}${q}`)
    .find(line => parse(line)[KEY] === secret);
  if (!assignment) throw new Error('invalid_secret');
  // Match complete dotenv assignments so a key inside another multiline value is untouched.
  const entries = /^[ \t]*(?:export[ \t]+)?([\w.-]+)(?:[ \t]*=[ \t]*|:[ \t]+)('(?:\\'|[^'])*'|"(?:\\"|[^"])*"|`(?:\\`|[^`])*`|[^#\r\n]*)([ \t]*(?:#[^\r\n]*)?)\r?$/gm;
  const rest = raw.replace(entries, (entry, key, _value, comment) => key === KEY ? comment : entry);
  const newline = raw.includes('\r\n') ? '\r\n' : '\n';
  const updated = `${rest}${rest && !rest.endsWith('\n') ? newline : ''}${assignment}${newline}`;
  const expected = { ...parse(raw), [KEY]: secret };
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
  },
): Promise<boolean> {
  if (url.pathname !== '/api/oncall-service-secret') return false;
  res.setHeader('cache-control', 'no-store');
  const reply = (status: number, body: unknown) => { jsonRes(res, status, body); return true; };
  if (!deps.identity?.canManageHost) return reply(403, { ok: false, error: '需要管理员权限' });
  if (req.method !== 'GET' && req.method !== 'PUT') return reply(405, { ok: false, error: 'method_not_allowed' });
  const envFile = deps.envFile ?? join(homedir(), '.botmux', '.env');
  if (req.method === 'GET') {
    try {
      const configured = Boolean(parse(readSecureHostFileSync(envFile) ?? '')[KEY]?.trim());
      return reply(200, { ok: true, configured });
    } catch { return reply(503, { ok: false, error: '无法读取配置，请检查 .env 权限为 0600' }); }
  }
  const guard = guardControlRequest({ headers: req.headers, authSessionId: deps.identity.authSessionId, tokens: deps.csrfTokens });
  if (!guard.ok) return reply(guard.status, { ok: false, error: guard.error });
  let body: any;
  try { body = await readJsonBodyWithLimit(req, 16 * 1024); }
  catch { return reply(400, { ok: false, error: '凭据请求无效或过大' }); }
  const secret = typeof body?.secret === 'string' ? body.secret.trim() : '';
  if (!body || Array.isArray(body) || Object.keys(body).some(key => key !== 'secret')
    || !secret || secret.length > 8192 || /[^\x21-\x7e]/.test(secret)) {
    return reply(400, { ok: false, error: '请输入有效的单行 Service Secret' });
  }
  try {
    withSecureHostParentSync(envFile, file => file.withLeafLock(() => {
      const raw = file.readLeaf();
      // Creating the global file would stop startup from loading the legacy cwd .env.
      if (raw === null && existsSync(join(process.cwd(), '.env'))) throw new Error('legacy_env');
      file.writeLeaf(replaceSecret(raw ?? '', secret));
    }));
    return reply(200, { ok: true, configured: true, restartRequired: true });
  } catch (error) {
    return reply(503, { ok: false, error: error instanceof Error && error.message === 'legacy_env'
      ? '请先将工作目录的 .env 迁移到 ~/.botmux/.env 并重启，避免覆盖其他启动配置'
      : '保存失败，请检查 .env 内容及权限为 0600' });
  }
}
