import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readSecureHostFileSync, withSecureHostParentSync } from '../platform/secure-host-file.js';

const DOMAIN = 'botmux.dispatch-report-binding.v1';

export const DISPATCH_REPORT_REGISTER_ROUTE = '/api/report-relay/register';
export const DISPATCH_REPORT_REGISTER_MAX_BYTES = 64 * 1024;

export interface DispatchReportBindingPayload {
  domain: typeof DOMAIN;
  dispatchRoot: string;
  targetLarkAppId: string;
  targetSessionId: string;
  targetChatId?: string;
  targetScope?: 'thread' | 'chat';
  sourceName: string;
  issuedAt: string;
}

export interface SignedDispatchReportBinding {
  payload: DispatchReportBindingPayload;
  signature: string;
}

/**
 * dispatch report 的宿主密钥位置。
 *
 * 普通 fleet 保持历史位置：`<botmuxHome>/.dashboard-secret.report-binding`，使同一
 * fleet 的各 bot dataDir 共享一个签名域。core-only 的 stateDir 可以是任意显式绝对目录
 * （例如 `/tmp/<isolated-state>`）；若仍取其 parent，会把密钥落到 `/tmp` 这类非当前
 * 用户目录，严格宿主凭证校验应当且会拒绝。因此 core-only 将密钥限定在自己的 stateDir，
 * 不读取或修改同 HOME fleet 的共享密钥。
 */
export function dispatchReportBindingSecretPath(
  dataDir: string,
  options: { coreOnly?: boolean } = {},
): string {
  const coreOnly = options.coreOnly ?? process.env.BOTMUX_CORE_ONLY === '1';
  return coreOnly
    ? join(dataDir, '.dashboard-secret.report-binding')
    : join(dirname(dataDir), '.dashboard-secret.report-binding');
}

/**
 * 读取 dispatch-report 宿主密钥，必要时为旧 core-only state-dir 做一次安全迁移。
 *
 * 历史 core-only 把密钥放在 `dirname(dataDir)`；新路径改为 dataDir 内，避免显式
 * `/tmp/<state>` 时写到共享 `/tmp`。为了保留已经签发的 report binding，新路径缺失
 * 时只迁移通过 secure-host-file 校验的旧叶子。旧路径缺失则创建新密钥；旧路径不安全
 * 时抛错，绝不为了兼容读取、删除或覆盖可疑凭证。
 */
export function loadOrCreateDispatchReportBindingSecret(
  dataDir: string,
  options: { coreOnly?: boolean } = {},
): string {
  const coreOnly = options.coreOnly ?? process.env.BOTMUX_CORE_ONLY === '1';
  const currentPath = dispatchReportBindingSecretPath(dataDir, { coreOnly });
  return withSecureHostParentSync(currentPath, (parent) => parent.withLeafLock(() => {
    const current = parent.readLeaf(256)?.trim();
    if (current) return current;

    if (coreOnly) {
      const legacyPath = join(dirname(dataDir), '.dashboard-secret.report-binding');
      // Do not run the strict legacy-parent check merely to discover a missing
      // leaf. An explicit state dir may be a direct child of sticky /tmp: that
      // parent is intentionally unsuitable for a credential, but its absence
      // must not prevent a new credential from being created inside stateDir.
      // If the legacy leaf exists, keep the strict reader: a symlink, unsafe
      // mode, or untrusted parent is an ambiguous authority and fails closed.
      let legacyPresent = false;
      try {
        lstatSync(legacyPath);
        legacyPresent = true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
      if (legacyPresent) {
        const legacy = readSecureHostFileSync(legacyPath, 256)?.trim();
        if (legacy) {
          parent.writeLeaf(legacy);
          return legacy;
        }
      }
    }

    const secret = randomBytes(32).toString('base64url');
    parent.writeLeaf(secret);
    return secret;
  }));
}

function validDispatchRoot(value: string): boolean {
  return /^om_[A-Za-z0-9_-]{1,128}$/.test(value);
}

function validIdentity(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !value.includes('\0');
}

function canonicalPayload(input: {
  dispatchRoot: string;
  targetLarkAppId: string;
  targetSessionId: string;
  targetChatId?: string;
  targetScope?: 'thread' | 'chat';
  sourceName?: string;
  issuedAt?: string;
}): DispatchReportBindingPayload {
  const dispatchRoot = input.dispatchRoot.trim();
  const targetLarkAppId = input.targetLarkAppId.trim();
  const targetSessionId = input.targetSessionId.trim();
  const targetChatId = input.targetChatId?.trim();
  if (!validDispatchRoot(dispatchRoot)) throw new Error('invalid dispatch root');
  if (!validIdentity(targetLarkAppId) || !validIdentity(targetSessionId)) {
    throw new Error('invalid dispatch report target');
  }
  if (targetChatId !== undefined && !/^oc_[A-Za-z0-9_-]{1,128}$/.test(targetChatId)) {
    throw new Error('invalid dispatch report target chat');
  }
  if (input.targetScope !== undefined && input.targetScope !== 'thread' && input.targetScope !== 'chat') {
    throw new Error('invalid dispatch report target scope');
  }
  const sourceName = input.sourceName?.trim().slice(0, 200) || 'dispatched subtask';
  const issuedAt = input.issuedAt ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(issuedAt))) throw new Error('invalid dispatch report issue time');
  return {
    domain: DOMAIN,
    dispatchRoot,
    targetLarkAppId,
    targetSessionId,
    ...(targetChatId ? { targetChatId } : {}),
    ...(input.targetScope ? { targetScope: input.targetScope } : {}),
    sourceName,
    issuedAt,
  };
}

function signPayload(secret: string, payload: DispatchReportBindingPayload): string {
  return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('base64url');
}

export function createDispatchReportBinding(
  secret: string,
  input: Omit<DispatchReportBindingPayload, 'domain'>,
): SignedDispatchReportBinding {
  if (!secret) throw new Error('dispatch report binding secret is empty');
  const payload = canonicalPayload(input);
  return { payload, signature: signPayload(secret, payload) };
}

export function verifyDispatchReportBinding(
  secret: string,
  dispatchRoot: string,
  raw: unknown,
): DispatchReportBindingPayload | null {
  if (!secret || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const binding = raw as Record<string, unknown>;
  if (!binding.payload || typeof binding.payload !== 'object' || Array.isArray(binding.payload)
    || typeof binding.signature !== 'string') return null;
  const candidate = binding.payload as Record<string, unknown>;
  try {
    const payload = canonicalPayload({
      dispatchRoot: typeof candidate.dispatchRoot === 'string' ? candidate.dispatchRoot : '',
      targetLarkAppId: typeof candidate.targetLarkAppId === 'string'
        ? candidate.targetLarkAppId
        : '',
      targetSessionId: typeof candidate.targetSessionId === 'string'
        ? candidate.targetSessionId
        : '',
      targetChatId: typeof candidate.targetChatId === 'string'
        ? candidate.targetChatId
        : undefined,
      targetScope: candidate.targetScope === 'thread' || candidate.targetScope === 'chat'
        ? candidate.targetScope
        : undefined,
      sourceName: typeof candidate.sourceName === 'string' ? candidate.sourceName : '',
      issuedAt: typeof candidate.issuedAt === 'string' ? candidate.issuedAt : '',
    });
    if (candidate.domain !== DOMAIN || payload.dispatchRoot !== dispatchRoot) return null;
    const expected = Buffer.from(signPayload(secret, payload), 'base64url');
    const provided = Buffer.from(binding.signature, 'base64url');
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function resolveVerifiedDispatchReportTarget(input: {
  registry: Record<string, unknown>;
  dispatchRoot: string;
  secret: string;
}):
  | { ok: true; binding: DispatchReportBindingPayload }
  | { ok: false; error: 'dispatch_target_unavailable' | 'dispatch_binding_unproven' } {
  const rawEntry = input.registry[input.dispatchRoot];
  if (!rawEntry || typeof rawEntry !== 'object' || Array.isArray(rawEntry)) {
    return { ok: false, error: 'dispatch_target_unavailable' };
  }
  const binding = verifyDispatchReportBinding(
    input.secret,
    input.dispatchRoot,
    (rawEntry as Record<string, unknown>).reportBinding,
  );
  return binding
    ? { ok: true, binding }
    : { ok: false, error: 'dispatch_binding_unproven' };
}
