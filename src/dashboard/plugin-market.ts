import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { z } from 'zod';
import { resolveCliSpawn } from '../core/self-spawn.js';
import { parsePluginPackageManifest } from '../core/plugins/manifest.js';
import { assertPluginServiceStopped } from '../core/plugins/service-manager.js';
import { getInstalledPlugin } from '../services/plugin-registry-store.js';
import { pluginRecordHash, pluginRegistryRevision, type PluginMutationGuard } from '../core/plugins/mutation-guard.js';

const CATALOG_URL = 'https://raw.githubusercontent.com/botmux-ai/plugin-market/main/index.json';
const REGISTRY = '--registry=https://registry.npmjs.org/';
const packageName = z.string().max(214).regex(/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/);
const pluginId = z.string().regex(/^[a-z][a-z0-9._-]{0,63}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i);
const httpsUrl = z.string().url().refine(value => new URL(value).protocol === 'https:');
const entrySchema = z.object({
  id: pluginId, package: packageName, displayName: z.string().min(1).max(120),
  description: z.string().max(1000), repo: httpsUrl, docs: httpsUrl.optional(),
  categories: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,31}$/)).max(12),
  compatibility: z.object({ botmux: z.string().max(100) }),
});
export type PluginMarketEntry = z.infer<typeof entrySchema>;
export interface PluginInstallPlan {
  nonce: string;
  id: string;
  packageName: string;
  version: string;
  integrity: string;
  expiresAt: number;
  expectedState: string | null;
  expectedRevision: string;
  authorityDigest?: string;
}
interface PendingPlan extends PluginInstallPlan { principal: string }
export interface MarketInstalledPlugin { id: string; packageName: string; version: string }
export interface PluginMarketDependencies {
  fetchCatalog(): Promise<unknown>;
  metadata(packageName: string): Promise<{ version: string; integrity: string }>;
  installed(id: string): MarketInstalledPlugin | undefined;
  assertStopped(id: string): void;
  isEnabled(id: string): boolean;
  install(plan: PluginInstallPlan): Promise<void>;
  uninstall(guard: PluginMutationGuard): Promise<void>;
  now(): number;
  revision(): string;
}
export class PluginMarketError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export function normalizePluginMarket(value: unknown): PluginMarketEntry[] {
  const parsed = z.object({ schemaVersion: z.literal(1), plugins: z.array(entrySchema).max(500) }).safeParse(value);
  if (!parsed.success) throw new PluginMarketError(502, '插件目录格式无效');
  const seen = new Set<string>();
  for (const entry of parsed.data.plugins) {
    if (seen.has(entry.id)) throw new PluginMarketError(502, '插件目录包含重复 ID');
    seen.add(entry.id);
  }
  return parsed.data.plugins;
}

export function createPluginMarket(deps: PluginMarketDependencies) {
  let cache: { items: PluginMarketEntry[]; at: number } | undefined;
  let loading: Promise<{ items: PluginMarketEntry[]; stale: boolean; available: boolean }> | undefined;
  let busy = false;
  const plans = new Map<string, PendingPlan>();
  async function catalog(force = false) {
    if (!force && cache && deps.now() - cache.at < 300_000) {
      return { items: cache.items, stale: false, available: true };
    }
    if (loading) return loading;
    loading = (async () => {
      try {
        const items = normalizePluginMarket(await deps.fetchCatalog());
        cache = { items, at: deps.now() };
        return { items, stale: false, available: true };
      } catch {
        return { items: cache?.items ?? [], stale: true, available: !!cache };
      } finally {
        loading = undefined;
      }
    })();
    return loading;
  }
  function prune() {
    for (const [key, plan] of plans) if (plan.expiresAt <= deps.now()) plans.delete(key);
  }
  function assertPackageIdentity(id: string, name: string) {
    const current = deps.installed(id);
    if (current && current.packageName !== name) {
      throw new PluginMarketError(409, '此 ID 已被另一个已安装的软件包使用，不能覆盖');
    }
  }
  function stopped(id: string) {
    try { deps.assertStopped(id); }
    catch { throw new PluginMarketError(409, '请先停止插件后台服务，再更新或卸载'); }
  }
  async function prepare(rawId: unknown, principal: string) {
    if (!pluginId.safeParse(rawId).success) throw new PluginMarketError(400, '插件 ID 无效');
    const entry = (await catalog()).items.find(item => item.id === rawId);
    if (!entry) throw new PluginMarketError(404, '目录中找不到此插件');
    assertPackageIdentity(entry.id, entry.package);
    const expectedState = pluginRecordHash(deps.installed(entry.id));
    const expectedRevision = deps.revision();
    if (deps.installed(entry.id)) stopped(entry.id);
    const metadata = await deps.metadata(entry.package);
    if (!version.safeParse(metadata.version).success || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(metadata.integrity)) {
      throw new PluginMarketError(502, '无法核验软件包版本或完整性');
    }
    prune();
    if (plans.size >= 100) throw new PluginMarketError(429, '待确认的安装过多，请稍后重试');
    const plan: PendingPlan = {
      nonce: randomUUID(), id: entry.id, packageName: entry.package,
      version: metadata.version, integrity: metadata.integrity,
      expiresAt: deps.now() + 300_000, principal,
      expectedState, expectedRevision,
    };
    plans.set(plan.nonce, plan);
    const { principal: _principal, ...publicPlan } = plan;
    return publicPlan;
  }
  async function install(nonce: unknown, confirm: unknown, principal: string, authorityDigest?: string) {
    prune();
    const plan = typeof nonce === 'string' ? plans.get(nonce) : undefined;
    if (!plan || plan.principal !== principal || confirm !== true) {
      throw new PluginMarketError(409, '安装确认已过期或无效，请重新选择');
    }
    if (busy) throw new PluginMarketError(409, '已有插件操作进行中');
    assertPackageIdentity(plan.id, plan.packageName);
    if (pluginRecordHash(deps.installed(plan.id)) !== plan.expectedState || deps.revision() !== plan.expectedRevision) {
      throw new PluginMarketError(409, '插件状态已变化，请重新确认安装');
    }
    stopped(plan.id);
    busy = true;
    plans.delete(plan.nonce);
    try {
      await deps.install({ ...plan, authorityDigest });
      const actual = deps.installed(plan.id);
      if (actual?.packageName !== plan.packageName || actual?.version !== plan.version) {
        throw new PluginMarketError(409, '安装结果未通过核对，请刷新已安装列表');
      }
      for (const [key, pending] of plans) if (pending.id === plan.id) plans.delete(key);
      return { id: actual.id, version: actual.version };
    } finally { busy = false; }
  }
  async function uninstall(value: unknown, authorityDigest?: string) {
    const parsed = z.object({
      id: pluginId, packageName, version, expectedState: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true),
    }).safeParse(value);
    if (!parsed.success) throw new PluginMarketError(400, '卸载需要明确确认');
    if (busy) throw new PluginMarketError(409, '已有插件操作进行中');
    const current = deps.installed(parsed.data.id);
    if (!current || current.version !== parsed.data.version || current.packageName !== parsed.data.packageName
      || pluginRecordHash(current) !== parsed.data.expectedState) {
      throw new PluginMarketError(409, '插件版本已变化，请刷新后重新确认');
    }
    if (deps.isEnabled(current.id)) throw new PluginMarketError(409, '请先关闭插件的全部启用范围，再卸载');
    stopped(current.id);
    busy = true;
    try {
      await deps.uninstall({
        id: current.id, packageName: current.packageName, version: current.version,
        expectedState: parsed.data.expectedState, authorityDigest,
        expectedRevision: deps.revision(),
      });
      if (deps.installed(current.id)) throw new PluginMarketError(409, '卸载结果未通过核对，请刷新已安装列表');
      for (const [key, pending] of plans) if (pending.id === current.id) plans.delete(key);
    } finally { busy = false; }
  }
  return { catalog, prepare, install, uninstall };
}

const exec = promisify(execFile);
async function run(command: string, args: string[], timeout = 120_000) {
  return exec(command, args, {
    timeout, maxBuffer: 2 * 1024 * 1024, shell: false,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_registry: 'https://registry.npmjs.org/' },
  });
}
async function runCli(args: string[]) {
  const command = resolveCliSpawn(join(dirname(fileURLToPath(import.meta.url)), '../cli.js'), args);
  await run(command.command, command.args, 180_000);
}
export function verifyPluginArchive(bytes: Uint8Array, manifest: unknown, plan: PluginInstallPlan): void {
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  if (integrity !== plan.integrity) throw new PluginMarketError(409, '软件包完整性与确认版本不一致，已取消安装');
  const pkg = parsePluginPackageManifest(manifest);
  if (pkg.name !== plan.packageName || pkg.version !== plan.version || pkg.botmux.id !== plan.id) {
    throw new PluginMarketError(409, '软件包声明与目录不一致，已取消安装');
  }
}
export function createHostPluginMarket(isEnabled: (id: string) => boolean) {
  return createPluginMarket({
    now: Date.now, revision: pluginRegistryRevision, installed: getInstalledPlugin, isEnabled,
    assertStopped: id => assertPluginServiceStopped(id, 'update'),
    async fetchCatalog() {
      const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(8000), redirect: 'error' });
      if (!response.ok) throw new Error('catalog_unavailable');
      const text = await response.text();
      if (text.length > 500_000) throw new Error('catalog_too_large');
      return JSON.parse(text);
    },
    async metadata(name) {
      const { stdout } = await run('npm', ['view', name, 'version', 'dist.integrity', '--json', REGISTRY], 30_000);
      const value = JSON.parse(stdout);
      return { version: value.version, integrity: value['dist.integrity'] };
    },
    async install(plan) {
      const dir = await mkdtemp(join(tmpdir(), 'botmux-market-'));
      try {
        const { stdout } = await run('npm', [
          'pack', `${plan.packageName}@${plan.version}`, '--ignore-scripts', '--json', '--pack-destination', dir, REGISTRY,
        ]);
        const filename: unknown = JSON.parse(stdout)?.[0]?.filename;
        if (typeof filename !== 'string' || basename(filename) !== filename || !filename.endsWith('.tgz')) {
          throw new PluginMarketError(502, '下载的软件包格式无效');
        }
        const archive = join(dir, filename);
        const bytes = await readFile(archive);
        if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== plan.integrity) {
          throw new PluginMarketError(409, '软件包完整性与确认版本不一致，已取消安装');
        }
        const extracted = await run('tar', ['-xOf', archive, 'package/package.json'], 10_000);
        verifyPluginArchive(bytes, JSON.parse(extracted.stdout), plan);
        const current = getInstalledPlugin(plan.id);
        if (current && current.packageName !== plan.packageName) throw new PluginMarketError(409, '已安装软件包发生变化，已取消安装');
        const guard: PluginMutationGuard = {
          id: plan.id, packageName: plan.packageName, version: plan.version,
          expectedState: plan.expectedState, integrity: plan.integrity, authorityDigest: plan.authorityDigest,
          expectedRevision: plan.expectedRevision,
        };
        await runCli(['plugin', 'install-verified', `file:${archive}`, '--guard-json', JSON.stringify(guard)]);
      } finally { await rm(dir, { recursive: true, force: true }); }
    },
    async uninstall(guard) { await runCli(['plugin', 'uninstall-verified', guard.id, '--guard-json', JSON.stringify(guard)]); },
  });
}
