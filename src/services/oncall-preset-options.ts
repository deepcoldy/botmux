import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { normalizeOncallGroupTarget, readOncallDeploymentConnection, type OncallGroupTarget } from './oncall-group-client.js';
import { readOncallBusinessName, readOncallChoices } from './oncall-platform.js';
import { readOncallDeploymentEnv } from './oncall-deployment-config.js';

export interface OncallPresetOptions {
  tenantId: number;
  tenantName: string;
  regions: Array<{ value: string; label: string; categories: Array<{ value: string; label: string }> }>;
}
function cachePath(dataDir: string, appId: string): string {
  return join(dataDir, 'oncall-presentation', createHash('sha256').update(appId).digest('hex') + '.json');
}
function fingerprint(target: OncallGroupTarget, secret: string): string {
  return createHash('sha256').update(JSON.stringify([target.endpoint, target.emailDomain, target.tenantId, secret])).digest('hex');
}
export function readOncallPresetOptions(dataDir: string, appId: string, target: OncallGroupTarget): OncallPresetOptions | undefined {
  try {
    const cached = JSON.parse(readFileSync(cachePath(dataDir, appId), 'utf8'));
    if (cached.fingerprint !== fingerprint(target, readOncallDeploymentEnv().ONCALL_SERVICE_SECRET?.trim() ?? '')
      || Date.now() - cached.updatedAtMs > 15 * 60_000) return undefined;
    return cached.options;
  } catch { return undefined; }
}
/** Read-only platform lookup for a draft business line. Never writes routing or credentials. */
export async function loadOncallPresetOptions(dataDir: string, appId: string, tenantId: number,
  fetcher: typeof fetch = fetch): Promise<OncallPresetOptions> {
  const deployment = readOncallDeploymentEnv();
  const secret = deployment.ONCALL_SERVICE_SECRET?.trim() ?? '';
  const target = normalizeOncallGroupTarget({ ...readOncallDeploymentConnection(dataDir, appId, deployment), tenantId });
  const [choices, tenantName] = await Promise.all([readOncallChoices(target, secret, '', fetcher), readOncallBusinessName(target, secret, fetcher)]);
  const options: OncallPresetOptions = { tenantId, tenantName, regions: Object.entries(choices.regions).map(([region, categories]) => ({
    value: region, label: region, categories: categories.filter(category => category.type_action === 'create_chat')
      .map(category => ({ value: String(category.id), label: category.name })),
  })) };
  const current = readOncallDeploymentEnv();
  const currentTarget = { ...readOncallDeploymentConnection(dataDir, appId, current), tenantId };
  const generation = fingerprint(target, secret);
  if (generation !== fingerprint(currentTarget, current.ONCALL_SERVICE_SECRET?.trim() ?? '')) return options;
  mkdirSync(join(dataDir, 'oncall-presentation'), { recursive: true, mode: 0o700 });
  atomicWriteFileSync(cachePath(dataDir, appId), JSON.stringify({ fingerprint: generation, updatedAtMs: Date.now(), options }), { mode: 0o600 });
  return options;
}
